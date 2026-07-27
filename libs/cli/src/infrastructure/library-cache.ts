import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  GitClient,
  GitExecutionError,
  redactGitCredentials,
  type NormalizedGitRemote,
} from './git.js';

const CACHE_STATE_SCHEMA_VERSION = 1 as const;
const FULL_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type LibraryCacheAccess = 'read-only' | 'mutation';
export type LibraryCacheFreshness = 'fetched' | 'stale-cache' | 'offline-revision' | 'cache-only';

export interface LibraryCacheRefreshRequest {
  readonly remote: NormalizedGitRemote;
  readonly branch?: string;
  readonly access: LibraryCacheAccess;
  /** Stale fallback is honored only for read-only access. */
  readonly allowStale?: boolean;
  /** An exact full object ID already present in the cache; no network request is made. */
  readonly offlineRevision?: string;
}

export interface LibraryCacheInspectRequest {
  readonly remote: NormalizedGitRemote;
  readonly branch?: string;
}

export interface LibraryCacheWarning {
  readonly code: 'STALE_CACHE' | 'OFFLINE_REVISION' | 'CACHE_ONLY';
  readonly message: string;
}

export interface LibraryCacheRevision {
  readonly repositoryDirectory: string;
  /** Exact-revision inert filesystem snapshot produced during a successful refresh. */
  readonly treeDirectory?: string;
  readonly identity: string;
  readonly branch: string;
  readonly revision: string;
  readonly refreshedAt: string;
  readonly freshness: LibraryCacheFreshness;
  /** True means the result must not be represented as current with the remote. */
  readonly stale: boolean;
  /** Stale fallback is never valid input to a mutation. */
  readonly usableForMutation: boolean;
  readonly warning?: LibraryCacheWarning;
}

interface CacheState {
  readonly schemaVersion: typeof CACHE_STATE_SCHEMA_VERSION;
  readonly identity: string;
  readonly branch: string;
  readonly revision: string;
  readonly refreshedAt: string;
  /** SHA-256 over the complete inert snapshot tree at `revision`. */
  readonly snapshotDigest: string;
}

export type LibraryCacheLock = <T>(key: string, operation: () => Promise<T>) => Promise<T>;

export interface LibraryCacheOptions {
  readonly rootDirectory: string;
  readonly git?: GitClient;
  readonly withLock?: LibraryCacheLock;
  readonly now?: () => Date;
}

export type LibraryCacheErrorCode =
  | 'INVALID_BRANCH'
  | 'INVALID_CACHE'
  | 'REMOTE_REFRESH_FAILED'
  | 'DEFAULT_BRANCH_UNRESOLVED'
  | 'STALE_CACHE_UNAVAILABLE'
  | 'OFFLINE_REVISION_UNAVAILABLE';

export class LibraryCacheError extends Error {
  readonly code: LibraryCacheErrorCode;

  constructor(code: LibraryCacheErrorCode, message: string) {
    super(redactGitCredentials(message));
    this.name = 'LibraryCacheError';
    this.code = code;
  }
}

const activeLocks = new Map<string, Promise<void>>();

export const withInProcessLibraryCacheLock: LibraryCacheLock = async <T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = activeLocks.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  activeLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (activeLocks.get(key) === tail) {
      activeLocks.delete(key);
    }
  }
};

function cacheKey(identity: string): string {
  return createHash('sha256').update(identity).digest('hex');
}

function containsControlOrSpace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertBranchName(branch: string): void {
  const isInvalid =
    branch.length === 0 ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    containsControlOrSpace(branch) ||
    /[~^:?*[\\]/u.test(branch);
  if (isInvalid) {
    throw new LibraryCacheError('INVALID_BRANCH', 'The configured Git branch name is invalid.');
  }
}

function assertExactObjectId(revision: string): void {
  if (!FULL_OBJECT_ID.test(revision)) {
    throw new LibraryCacheError(
      'OFFLINE_REVISION_UNAVAILABLE',
      'An offline revision must be an exact 40- or 64-character hexadecimal commit ID.',
    );
  }
}

function parseDefaultBranch(output: string): string {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^ref:\s+refs\/heads\/(.+)\tHEAD$/u.exec(line);
    if (match?.[1] !== undefined) {
      assertBranchName(match[1]);
      return match[1];
    }
  }
  throw new LibraryCacheError(
    'DEFAULT_BRANCH_UNRESOLVED',
    'The remote did not advertise a default branch.',
  );
}

function parseRevision(output: string, code: LibraryCacheErrorCode): string {
  const revision = output.trim();
  if (!FULL_OBJECT_ID.test(revision)) {
    throw new LibraryCacheError(code, 'Git did not resolve an exact commit object ID.');
  }
  return revision;
}

async function pathType(path: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? 'directory' : 'other';
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

function validateCacheState(value: unknown, identity: string): CacheState {
  if (typeof value !== 'object' || value === null) {
    throw new LibraryCacheError('INVALID_CACHE', 'The library cache state is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== CACHE_STATE_SCHEMA_VERSION ||
    record.identity !== identity ||
    typeof record.branch !== 'string' ||
    typeof record.revision !== 'string' ||
    typeof record.refreshedAt !== 'string' ||
    typeof record.snapshotDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.snapshotDigest) ||
    !FULL_OBJECT_ID.test(record.revision) ||
    Number.isNaN(Date.parse(record.refreshedAt))
  ) {
    throw new LibraryCacheError('INVALID_CACHE', 'The library cache state is invalid.');
  }
  assertBranchName(record.branch);
  return {
    schemaVersion: CACHE_STATE_SCHEMA_VERSION,
    identity,
    branch: record.branch,
    revision: record.revision,
    refreshedAt: record.refreshedAt,
    snapshotDigest: record.snapshotDigest,
  };
}

/**
 * Hash a filesystem tree using an unambiguous, versioned byte stream. The
 * digest includes every relative path, entry type, permission mode, symlink
 * target, and regular-file byte. It follows no symlinks and performs no writes.
 */
async function snapshotIntegrityDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update('skill-sync-cache-snapshot-v1\0');

  const updateFrame = (kind: string, path: string, mode: number, value: Buffer): void => {
    const pathBytes = Buffer.from(path, 'utf8');
    hash.update(kind);
    hash.update('\0');
    hash.update(String(pathBytes.byteLength));
    hash.update('\0');
    hash.update(pathBytes);
    hash.update('\0');
    hash.update(mode.toString(8));
    hash.update('\0');
    hash.update(String(value.byteLength));
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  };

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = await readdir(directory);
    names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const name of names) {
      const path = join(directory, name);
      const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
      const stats = await lstat(path);
      const mode = stats.mode & 0o777;
      if (stats.isSymbolicLink()) {
        updateFrame('symlink', relativePath, mode, Buffer.from(await readlink(path), 'utf8'));
      } else if (stats.isDirectory()) {
        updateFrame('directory', relativePath, mode, Buffer.alloc(0));
        await visit(path, relativePath);
      } else if (stats.isFile()) {
        updateFrame('file', relativePath, mode, await readFile(path));
      } else {
        throw new LibraryCacheError(
          'INVALID_CACHE',
          `The exact-revision cache snapshot contains an unsupported entry: ${relativePath}`,
        );
      }
    }
  };

  await visit(root, '');
  return hash.digest('hex');
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof GitExecutionError || error instanceof LibraryCacheError) {
    return error.message;
  }
  if (error instanceof Error) {
    return redactGitCredentials(error.message);
  }
  return 'The remote could not be refreshed.';
}

export class LibraryCache {
  private readonly rootDirectory: string;
  private readonly git: GitClient;
  private readonly withLock: LibraryCacheLock;
  private readonly now: () => Date;

  constructor(options: LibraryCacheOptions) {
    this.rootDirectory = options.rootDirectory;
    this.git = options.git ?? new GitClient();
    this.withLock = options.withLock ?? withInProcessLibraryCacheLock;
    this.now = options.now ?? (() => new Date());
  }

  async refresh(request: LibraryCacheRefreshRequest): Promise<LibraryCacheRevision> {
    if (request.branch !== undefined) {
      assertBranchName(request.branch);
    }
    if (request.offlineRevision !== undefined) {
      assertExactObjectId(request.offlineRevision);
    }
    if (request.access === 'mutation' && request.allowStale === true) {
      throw new LibraryCacheError(
        'STALE_CACHE_UNAVAILABLE',
        'Stale cache fallback is restricted to read-only operations.',
      );
    }

    const key = cacheKey(request.remote.identity);
    return await this.withLock(key, async () => {
      const libraryDirectory = join(this.rootDirectory, key);
      const repositoryDirectory = join(libraryDirectory, 'repository.git');
      const statePath = join(libraryDirectory, 'state.json');

      if (request.offlineRevision !== undefined) {
        return await this.resolveOfflineRevision(
          request,
          repositoryDirectory,
          statePath,
          request.offlineRevision,
        );
      }

      await this.prepareRepository(request.remote, repositoryDirectory);
      try {
        const branch = request.branch ?? (await this.resolveDefaultBranch(request.remote.cloneUrl));
        const revision = await this.fetchBranch(repositoryDirectory, branch);
        const snapshot = await this.materializeSnapshot(repositoryDirectory, revision);
        const state: CacheState = {
          schemaVersion: CACHE_STATE_SCHEMA_VERSION,
          identity: request.remote.identity,
          branch,
          revision,
          refreshedAt: this.now().toISOString(),
          snapshotDigest: snapshot.digest,
        };
        await this.writeState(statePath, state);
        return {
          repositoryDirectory,
          treeDirectory: snapshot.directory,
          identity: state.identity,
          branch: state.branch,
          revision: state.revision,
          refreshedAt: state.refreshedAt,
          freshness: 'fetched',
          stale: false,
          usableForMutation: true,
        };
      } catch (error) {
        if (request.access === 'read-only' && request.allowStale === true) {
          return await this.staleFallback(
            request,
            repositoryDirectory,
            statePath,
            safeFailureMessage(error),
          );
        }
        throw new LibraryCacheError(
          'REMOTE_REFRESH_FAILED',
          `Unable to refresh the configured library: ${safeFailureMessage(error)}`,
        );
      }
    });
  }

  /**
   * Resolve the last verified cached commit without network access, directory
   * creation, metadata updates, or any other filesystem write.
   */
  async inspect(request: LibraryCacheInspectRequest): Promise<LibraryCacheRevision> {
    if (request.branch !== undefined) assertBranchName(request.branch);
    const key = cacheKey(request.remote.identity);
    return await this.withLock(key, async () => {
      const libraryDirectory = join(this.rootDirectory, key);
      const repositoryDirectory = join(libraryDirectory, 'repository.git');
      const statePath = join(libraryDirectory, 'state.json');
      if ((await pathType(repositoryDirectory)) !== 'directory') {
        throw new LibraryCacheError(
          'STALE_CACHE_UNAVAILABLE',
          'No verified cached library revision is available for cache-only inspection.',
        );
      }
      const state = await this.readState(statePath, request.remote.identity);
      if (request.branch !== undefined && request.branch !== state.branch) {
        throw new LibraryCacheError(
          'STALE_CACHE_UNAVAILABLE',
          'The cached branch does not match the configured branch.',
        );
      }
      const treeDirectory = this.snapshotDirectory(repositoryDirectory, state.revision);
      if ((await pathType(treeDirectory)) !== 'directory') {
        throw new LibraryCacheError(
          'STALE_CACHE_UNAVAILABLE',
          'The verified cache has no materialized exact-revision tree for write-free inspection.',
        );
      }
      await this.verifySnapshotIntegrity(treeDirectory, state.snapshotDigest);
      return {
        repositoryDirectory,
        treeDirectory,
        identity: state.identity,
        branch: state.branch,
        revision: state.revision,
        refreshedAt: state.refreshedAt,
        freshness: 'cache-only',
        stale: true,
        usableForMutation: false,
        warning: {
          code: 'CACHE_ONLY',
          message:
            'Using the last verified cache without a remote refresh; it must not be reported as current.',
        },
      };
    });
  }

  private async prepareRepository(
    remote: NormalizedGitRemote,
    repositoryDirectory: string,
  ): Promise<void> {
    await mkdir(dirname(repositoryDirectory), { recursive: true });
    const type = await pathType(repositoryDirectory);
    if (type === 'other') {
      throw new LibraryCacheError(
        'INVALID_CACHE',
        'The library cache repository path is not a regular directory.',
      );
    }
    if (type === 'missing') {
      await this.git.run(['init', '--bare', repositoryDirectory]);
    } else {
      const result = await this.git.run(['rev-parse', '--is-bare-repository'], {
        cwd: repositoryDirectory,
      });
      if (result.stdout.trim() !== 'true') {
        throw new LibraryCacheError('INVALID_CACHE', 'The library cache is not a bare repository.');
      }
    }

    try {
      await this.git.run(['remote', 'get-url', 'origin'], { cwd: repositoryDirectory });
      await this.git.run(['remote', 'set-url', 'origin', remote.cloneUrl], {
        cwd: repositoryDirectory,
      });
    } catch (error) {
      if (!(error instanceof GitExecutionError) || error.exitCode !== 2) {
        throw error;
      }
      await this.git.run(['remote', 'add', 'origin', remote.cloneUrl], {
        cwd: repositoryDirectory,
      });
    }
  }

  private async resolveDefaultBranch(cloneUrl: string): Promise<string> {
    const result = await this.git.run(['ls-remote', '--symref', '--exit-code', cloneUrl, 'HEAD']);
    return parseDefaultBranch(result.stdout);
  }

  private async fetchBranch(repositoryDirectory: string, branch: string): Promise<string> {
    assertBranchName(branch);
    const remoteReference = `refs/remotes/origin/${branch}`;
    const refspec = `+refs/heads/${branch}:${remoteReference}`;
    await this.git.run(
      ['fetch', '--force', '--prune', '--no-tags', '--no-recurse-submodules', 'origin', refspec],
      { cwd: repositoryDirectory },
    );
    const result = await this.git.run(
      ['rev-parse', '--verify', '--end-of-options', `${remoteReference}^{commit}`],
      { cwd: repositoryDirectory },
    );
    return parseRevision(result.stdout, 'REMOTE_REFRESH_FAILED');
  }

  private async staleFallback(
    request: LibraryCacheRefreshRequest,
    repositoryDirectory: string,
    statePath: string,
    refreshFailure: string,
  ): Promise<LibraryCacheRevision> {
    let state: CacheState;
    try {
      state = await this.readState(statePath, request.remote.identity);
      if (request.branch !== undefined && request.branch !== state.branch) {
        throw new LibraryCacheError(
          'STALE_CACHE_UNAVAILABLE',
          'The cached branch does not match the configured branch.',
        );
      }
      await this.verifyCachedRevision(repositoryDirectory, state.revision);
    } catch (error) {
      throw new LibraryCacheError(
        'STALE_CACHE_UNAVAILABLE',
        `The remote refresh failed and no verified stale cache is available: ${safeFailureMessage(error)}`,
      );
    }

    const treeDirectory = this.snapshotDirectory(repositoryDirectory, state.revision);
    const hasTreeDirectory = (await pathType(treeDirectory)) === 'directory';
    if (hasTreeDirectory) {
      await this.verifySnapshotIntegrity(treeDirectory, state.snapshotDigest);
    }

    return {
      repositoryDirectory,
      ...(hasTreeDirectory ? { treeDirectory } : {}),
      identity: state.identity,
      branch: state.branch,
      revision: state.revision,
      refreshedAt: state.refreshedAt,
      freshness: 'stale-cache',
      stale: true,
      usableForMutation: false,
      warning: {
        code: 'STALE_CACHE',
        message: `Remote refresh failed; this read-only result uses stale cached data and must not be reported as current. ${redactGitCredentials(refreshFailure)}`,
      },
    };
  }

  private async resolveOfflineRevision(
    request: LibraryCacheRefreshRequest,
    repositoryDirectory: string,
    statePath: string,
    revision: string,
  ): Promise<LibraryCacheRevision> {
    if ((await pathType(repositoryDirectory)) !== 'directory') {
      throw new LibraryCacheError(
        'OFFLINE_REVISION_UNAVAILABLE',
        'The requested offline revision is not present in the library cache.',
      );
    }
    const state = await this.readState(statePath, request.remote.identity);
    if (request.branch !== undefined && request.branch !== state.branch) {
      throw new LibraryCacheError(
        'OFFLINE_REVISION_UNAVAILABLE',
        'The cached branch does not match the configured branch.',
      );
    }
    await this.verifyCachedRevision(repositoryDirectory, revision);
    const treeDirectory = this.snapshotDirectory(repositoryDirectory, revision);
    const isCurrentSnapshot = revision.toLowerCase() === state.revision.toLowerCase();
    const hasTreeDirectory = isCurrentSnapshot && (await pathType(treeDirectory)) === 'directory';
    if (hasTreeDirectory) {
      await this.verifySnapshotIntegrity(treeDirectory, state.snapshotDigest);
    }
    return {
      repositoryDirectory,
      ...(hasTreeDirectory ? { treeDirectory } : {}),
      identity: state.identity,
      branch: request.branch ?? state.branch,
      revision: revision.toLowerCase(),
      refreshedAt: state.refreshedAt,
      freshness: 'offline-revision',
      stale: true,
      usableForMutation: request.access === 'mutation',
      warning: {
        code: 'OFFLINE_REVISION',
        message:
          'Using an explicitly requested cached revision without a remote refresh; it must not be reported as current.',
      },
    };
  }

  private async verifyCachedRevision(repositoryDirectory: string, revision: string): Promise<void> {
    assertExactObjectId(revision);
    try {
      const result = await this.git.run(
        ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
        { cwd: repositoryDirectory },
      );
      const resolved = parseRevision(result.stdout, 'OFFLINE_REVISION_UNAVAILABLE');
      if (resolved.toLowerCase() !== revision.toLowerCase()) {
        throw new LibraryCacheError(
          'OFFLINE_REVISION_UNAVAILABLE',
          'The requested offline revision did not resolve exactly.',
        );
      }
    } catch (error) {
      if (error instanceof LibraryCacheError) {
        throw error;
      }
      throw new LibraryCacheError(
        'OFFLINE_REVISION_UNAVAILABLE',
        `The requested cached revision is unavailable: ${safeFailureMessage(error)}`,
      );
    }
  }

  private snapshotDirectory(repositoryDirectory: string, revision: string): string {
    return join(dirname(repositoryDirectory), 'snapshots', revision.toLowerCase());
  }

  private async materializeSnapshot(
    repositoryDirectory: string,
    revision: string,
  ): Promise<{ readonly directory: string; readonly digest: string }> {
    const destination = this.snapshotDirectory(repositoryDirectory, revision);
    const destinationType = await pathType(destination);

    const snapshotsRoot = dirname(destination);
    await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
    const temporary = join(snapshotsRoot, `.snapshot-${revision}-${randomUUID()}`);
    try {
      await this.git.run(['init', '--quiet', temporary], { profile: 'content' });
      await this.git.run(['remote', 'add', 'cache', repositoryDirectory], {
        cwd: temporary,
        profile: 'content',
      });
      await this.git.run(
        ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'cache', revision],
        { cwd: temporary, profile: 'content' },
      );
      await this.git.run(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], {
        cwd: temporary,
        profile: 'content',
      });
      const resolved = await this.git.run(
        ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
        { cwd: temporary, profile: 'content' },
      );
      if (
        parseRevision(resolved.stdout, 'INVALID_CACHE').toLowerCase() !== revision.toLowerCase()
      ) {
        throw new LibraryCacheError(
          'INVALID_CACHE',
          'The materialized cache tree did not resolve to the fetched exact commit.',
        );
      }
      await rm(join(temporary, '.git'), { recursive: true, force: true });
      const digest = await snapshotIntegrityDigest(temporary);
      if (destinationType === 'directory') {
        const existingDigest = await snapshotIntegrityDigest(destination).catch(() => undefined);
        if (existingDigest === digest) {
          return { directory: destination, digest };
        }
      }
      if (destinationType !== 'missing') {
        const displaced = join(snapshotsRoot, `.snapshot-displaced-${revision}-${randomUUID()}`);
        await rename(destination, displaced);
        try {
          await rename(temporary, destination);
        } catch (error) {
          await rename(displaced, destination);
          throw error;
        }
        await rm(displaced, { recursive: true, force: true });
      } else {
        await rename(temporary, destination);
      }
      return { directory: destination, digest };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async verifySnapshotIntegrity(directory: string, expectedDigest: string): Promise<void> {
    let actualDigest: string;
    try {
      actualDigest = await snapshotIntegrityDigest(directory);
    } catch (error) {
      if (error instanceof LibraryCacheError) throw error;
      throw new LibraryCacheError(
        'INVALID_CACHE',
        `The exact-revision cache snapshot could not be verified: ${safeFailureMessage(error)}`,
      );
    }
    if (actualDigest !== expectedDigest) {
      throw new LibraryCacheError(
        'INVALID_CACHE',
        'The exact-revision cache snapshot has changed since it was materialized from Git.',
      );
    }
  }

  private async readState(statePath: string, identity: string): Promise<CacheState> {
    try {
      return validateCacheState(JSON.parse(await readFile(statePath, 'utf8')) as unknown, identity);
    } catch (error) {
      if (error instanceof LibraryCacheError) {
        throw error;
      }
      throw new LibraryCacheError('INVALID_CACHE', 'The library cache state could not be read.');
    }
  }

  private async writeState(statePath: string, state: CacheState): Promise<void> {
    const temporaryPath = `${statePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    await mkdir(dirname(statePath), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, statePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
