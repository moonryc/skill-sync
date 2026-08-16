import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  initConfigurationFingerprint,
  initPlanFingerprint,
  type LibraryInitPlanAction,
  type LibraryInitPlanEffects,
} from './init-plan.js';
import {
  InitializationRecoverySession,
  type InitializationRecoveryRuntime,
} from './init-recovery.js';

import {
  canonicalSkillPath,
  GROUP_MARKER_FILE,
  LIBRARY_MANIFEST_PATH,
  LIBRARY_SCHEMA_VERSION,
  validateLibrary,
  validateSkillDirectory,
  type LibraryValidationResult,
  type ValidatedSkill,
} from '../domain/library.js';
import {
  comparePortableStrings,
  parseGroupPath,
  parsePortableSlug,
  parseQualifiedSkillId,
  type GroupPath,
  type QualifiedSkillId,
} from '../domain/identifiers.js';
import { RecoveryIntegrityError } from '../domain/recovery-integrity.js';
import type { ProjectLock, ProjectManifest } from '../domain/project-state.js';
import {
  readUserConfig,
  redactCredentials,
  USER_CONFIG_SCHEMA_VERSION,
  writeUserConfig,
  type GitTransport as ConfigGitTransport,
  type UserConfig,
} from '../infrastructure/config.js';
import {
  gitFailureDiagnostic,
  GitClient,
  GitExecutionError,
  normalizeGitRemote,
  redactGitCredentials,
  type GitProcessResult,
  type GitRunOptions,
  type NormalizedGitRemote,
} from '../infrastructure/git.js';
import {
  LibraryCacheExpectedRevisionError,
  type LibraryCacheRefreshRequest,
  type LibraryCacheInspectRequest,
  type LibraryCachePromotionRequest,
  type LibraryCacheRevision,
  type LibraryCacheLock,
  withInProcessLibraryCacheLock,
} from '../infrastructure/library-cache.js';
import {
  assertProjectStatePair,
  readProjectLock,
  readProjectManifest,
  writeProjectLock,
} from '../infrastructure/project-state.js';
import {
  nonInteractiveProcessEnvironment,
  ProcessRunError,
  runProcess,
} from '../infrastructure/process-runner.js';
import { writeJsonAtomic } from '../infrastructure/stable-json.js';

export type LibraryLifecycleErrorCode =
  | 'REMOTE_EMPTY_CONFIRMATION_REQUIRED'
  | 'INIT_PLAN_CHANGED'
  | 'REMOTE_NOT_EMPTY'
  | 'INCOMPATIBLE_LIBRARY'
  | 'LIBRARY_VALIDATION_FAILED'
  | 'LIBRARY_DIVERGED'
  | 'GITHUB_REPOSITORY_EXISTS'
  | 'GITHUB_CREATE_FAILED'
  | 'CONFIG_PERSIST_FAILED'
  | 'SKILL_EXISTS'
  | 'SKILL_NOT_FOUND'
  | 'INVALID_SKILL_SOURCE'
  | 'GROUP_EXISTS'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_NOT_EMPTY'
  | 'DESTRUCTIVE_CONFIRMATION_REQUIRED'
  | 'PROJECT_STATE_REQUIRED'
  | 'PROJECT_SKILL_NOT_TRACKED'
  | 'REMOTE_BASE_DIVERGED'
  | 'DIVERGENT_TARGETS'
  | 'TARGET_SOURCE_NOT_FOUND'
  | 'MUTATION_HAS_NO_CHANGES'
  | 'REMOTE_ACCESS_FAILED';

export class LibraryLifecycleError extends Error {
  readonly code: LibraryLifecycleErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: LibraryLifecycleErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(redactGitCredentials(redactCredentials(message)));
    this.name = 'LibraryLifecycleError';
    this.code = code;
    this.details = details;
  }
}

export interface LibraryGitPort {
  run(arguments_: readonly string[], options?: GitRunOptions): Promise<GitProcessResult>;
}

export interface LibraryCachePort {
  refresh(request: LibraryCacheRefreshRequest): Promise<LibraryCacheRevision>;
  inspect?(request: LibraryCacheInspectRequest): Promise<LibraryCacheRevision>;
  promoteExact(request: LibraryCachePromotionRequest): Promise<LibraryCacheRevision>;
}

export interface LibraryConfigStore {
  read(): Promise<UserConfig | undefined>;
  /** Replaces the complete config; undefined restores the absence of a config file. */
  replace(config: UserConfig | undefined): Promise<void>;
}

export interface LibraryProjectStateStore {
  readManifest(projectRoot: string): Promise<ProjectManifest | undefined>;
  readLock(projectRoot: string): Promise<ProjectLock | undefined>;
  writeLock(projectRoot: string, lock: ProjectLock): Promise<void>;
}

export type GitHubVisibility = 'private' | 'public' | 'internal';

export interface GitHubCreateRequest {
  readonly repository: string;
  readonly signal?: AbortSignal;
  readonly visibility: GitHubVisibility;
  readonly transport: ConfigGitTransport;
}

export interface GitHubCreateResult {
  readonly cloneUrl: string;
}

export interface GitHubRepositoryPort {
  inspectRepository(request: GitHubCreateRequest): Promise<GitHubCreateResult>;
  createRepository(request: GitHubCreateRequest): Promise<GitHubCreateResult>;
}

export interface GitHubProcessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type GitHubProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options: GitHubProcessOptions,
) => Promise<GitProcessResult>;

const GITHUB_PROCESS_TIMEOUT_MS = 120_000;
const PROCESS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

const defaultGitHubProcessRunner: GitHubProcessRunner = async (executable, arguments_, options) =>
  await runProcess({
    arguments: arguments_,
    env: options.env,
    executable,
    maxOutputBytes: PROCESS_OUTPUT_LIMIT_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? GITHUB_PROCESS_TIMEOUT_MS,
  });

function githubProcessDiagnostic(error: unknown): string {
  if (error instanceof ProcessRunError) {
    return error.output.stderr.trim() || error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const stderr: unknown = Reflect.get(error, 'stderr');
    if (typeof stderr === 'string' && stderr.trim().length > 0) return stderr.trim();
  }
  return error instanceof Error ? error.message : 'GitHub CLI failed.';
}

export function isValidGitHubRepositoryName(value: string): boolean {
  const segments = value.split('/');
  return (
    segments.length === 2 &&
    segments.every((segment) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u.test(segment))
  );
}

function githubCloneUrl(repository: string, transport: ConfigGitTransport): string {
  return transport === 'ssh'
    ? `git@github.com:${repository}.git`
    : `https://github.com/${repository}.git`;
}

function githubRepositoryIsMissing(error: unknown): boolean {
  const diagnostic = githubProcessDiagnostic(error);
  return /(?:could not resolve to a repository|http\s+(?:status\s+)?404)/iu.test(diagnostic);
}

export class GhCliRepositoryClient implements GitHubRepositoryPort {
  private readonly executable: string;
  private readonly processRunner: GitHubProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly signal: AbortSignal | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(
    options: {
      readonly executable?: string;
      readonly processRunner?: GitHubProcessRunner;
      readonly environment?: NodeJS.ProcessEnv;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.executable = options.executable ?? 'gh';
    this.processRunner = options.processRunner ?? defaultGitHubProcessRunner;
    this.environment = nonInteractiveProcessEnvironment({
      ...process.env,
      ...options.environment,
    });
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs;
  }

  private processOptions(signal?: AbortSignal): GitHubProcessOptions {
    const selectedSignal = signal ?? this.signal;
    return {
      env: this.environment,
      ...(selectedSignal === undefined ? {} : { signal: selectedSignal }),
      ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
    };
  }

  async inspectRepository(request: GitHubCreateRequest): Promise<GitHubCreateResult> {
    if (!isValidGitHubRepositoryName(request.repository)) {
      throw new LibraryLifecycleError(
        'GITHUB_CREATE_FAILED',
        'GitHub repository names must use owner/repository syntax.',
      );
    }

    try {
      await this.processRunner(
        this.executable,
        ['auth', 'status'],
        this.processOptions(request.signal),
      );
    } catch (error) {
      throw new LibraryLifecycleError(
        'GITHUB_CREATE_FAILED',
        `GitHub authentication is unavailable: ${githubProcessDiagnostic(error)} Next: run gh auth login, then retry the same skill-sync init --create preview with --dry-run.`,
      );
    }

    try {
      await this.processRunner(
        this.executable,
        ['repo', 'view', request.repository, '--json', 'nameWithOwner'],
        this.processOptions(request.signal),
      );
      throw new LibraryLifecycleError(
        'GITHUB_REPOSITORY_EXISTS',
        `The requested GitHub repository already exists. Preview connecting it with skill-sync init ${githubCloneUrl(request.repository, request.transport)} --dry-run instead.`,
      );
    } catch (error) {
      if (error instanceof LibraryLifecycleError) throw error;
      if (!githubRepositoryIsMissing(error)) {
        throw new LibraryLifecycleError(
          'GITHUB_CREATE_FAILED',
          `GitHub repository availability could not be verified: ${githubProcessDiagnostic(error)} Check GitHub connectivity, then retry the same skill-sync init --create preview with --dry-run.`,
        );
      }
    }

    return { cloneUrl: githubCloneUrl(request.repository, request.transport) };
  }

  async createRepository(request: GitHubCreateRequest): Promise<GitHubCreateResult> {
    if (!isValidGitHubRepositoryName(request.repository)) {
      throw new LibraryLifecycleError(
        'GITHUB_CREATE_FAILED',
        'GitHub repository names must use owner/repository syntax.',
      );
    }

    try {
      await this.processRunner(
        this.executable,
        ['repo', 'create', request.repository, `--${request.visibility}`],
        this.processOptions(request.signal),
      );
    } catch (error) {
      throw new LibraryLifecycleError(
        'GITHUB_CREATE_FAILED',
        `GitHub repository creation failed: ${githubProcessDiagnostic(error)} The repository may have been created; inspect GitHub before retrying or deleting it.`,
      );
    }

    return { cloneUrl: githubCloneUrl(request.repository, request.transport) };
  }
}

export class FileLibraryConfigStore implements LibraryConfigStore {
  constructor(private readonly path: string) {}

  async read(): Promise<UserConfig | undefined> {
    return await readUserConfig(this.path);
  }

  async replace(config: UserConfig | undefined): Promise<void> {
    if (config === undefined) {
      try {
        await unlink(this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return;
    }
    await writeUserConfig(this.path, config);
  }
}

export const fileProjectStateStore: LibraryProjectStateStore = {
  readManifest: readProjectManifest,
  readLock: readProjectLock,
  writeLock: async (projectRoot, lock) => {
    await writeProjectLock(projectRoot, lock);
  },
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertPortableRepositoryPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new LibraryLifecycleError(
      'LIBRARY_VALIDATION_FAILED',
      'A mutation path is not a portable repository-relative path.',
    );
  }
}

function validationFailure(result: LibraryValidationResult): LibraryLifecycleError {
  return new LibraryLifecycleError(
    'LIBRARY_VALIDATION_FAILED',
    `The complete library is invalid (${String(result.errors.length)} validation errors).`,
    { errors: result.errors },
  );
}

async function copyValidatedSkill(source: ValidatedSkill, destination: string): Promise<void> {
  if (await pathExists(destination)) {
    throw new LibraryLifecycleError('SKILL_EXISTS', 'The canonical skill already exists.');
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const realSource = await realpath(source.rootPath);

  for (const file of source.files) {
    assertPortableRepositoryPath(file.relativePath);
    const sourcePath = resolve(realSource, ...file.relativePath.split('/'));
    const information = await lstat(sourcePath);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new LibraryLifecycleError(
        'INVALID_SKILL_SOURCE',
        'The skill source changed after validation or contains a non-regular file.',
      );
    }
    const destinationPath = resolve(destination, ...file.relativePath.split('/'));
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, information.mode & 0o666);
  }

  const copied = await validateSkillDirectory(destination, source.id);
  if (!copied.valid || copied.skill?.digest !== source.digest) {
    throw new LibraryLifecycleError(
      'INVALID_SKILL_SOURCE',
      'The skill source changed while it was being copied; no library commit was created.',
      { errors: copied.errors },
    );
  }
}

async function replaceValidatedSkill(source: ValidatedSkill, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await copyValidatedSkill(source, destination);
}

async function writeGroupMarker(path: string): Promise<void> {
  await writeJsonAtomic(path, { schemaVersion: LIBRARY_SCHEMA_VERSION }, { mode: 0o644 });
}

async function ensureGroupMarkers(libraryRoot: string, group: GroupPath): Promise<void> {
  if (group.length === 0) return;
  const segments = group.split('/');
  let current = join(libraryRoot, 'skills');
  for (const segment of segments) {
    current = join(current, segment);
    await mkdir(current, { recursive: true, mode: 0o700 });
    if (await pathExists(join(current, 'SKILL.md'))) {
      throw new LibraryLifecycleError(
        'GROUP_EXISTS',
        'A skill path prevents creation of the requested group.',
      );
    }
    const marker = join(current, GROUP_MARKER_FILE);
    if (!(await pathExists(marker))) {
      await writeGroupMarker(marker);
    }
  }
}

async function configureCommitIdentity(git: LibraryGitPort, checkout: string): Promise<void> {
  await git.run(['config', '--local', 'user.name', 'skill-sync'], {
    cwd: checkout,
    profile: 'content',
  });
  await git.run(['config', '--local', 'user.email', 'skill-sync@users.noreply.github.com'], {
    cwd: checkout,
    profile: 'content',
  });
}

async function exactHead(git: LibraryGitPort, repository: string): Promise<string> {
  const result = await git.run(['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], {
    cwd: repository,
    profile: 'content',
  });
  const revision = result.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) {
    throw new LibraryLifecycleError(
      'LIBRARY_VALIDATION_FAILED',
      'Git did not resolve an exact commit after the library mutation.',
    );
  }
  return revision;
}

async function createCheckout(options: {
  readonly git: LibraryGitPort;
  readonly stagingRoot: string;
  readonly cacheRepository: string;
  readonly revision: string;
  readonly remote: NormalizedGitRemote;
}): Promise<string> {
  await mkdir(options.stagingRoot, { recursive: true, mode: 0o700 });
  const checkout = await mkdtemp(join(options.stagingRoot, 'library-'));
  try {
    await options.git.run(['init', '--quiet', checkout], { profile: 'content' });
    await options.git.run(['remote', 'add', 'cache', options.cacheRepository], {
      cwd: checkout,
      profile: 'content',
    });
    await options.git.run(
      ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'cache', options.revision],
      { cwd: checkout, profile: 'content' },
    );
    await options.git.run(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], {
      cwd: checkout,
      profile: 'content',
    });
    if ((await exactHead(options.git, checkout)) !== options.revision) {
      throw new LibraryLifecycleError(
        'LIBRARY_VALIDATION_FAILED',
        'The clean checkout did not resolve to the requested exact revision.',
      );
    }
    await options.git.run(['remote', 'add', 'origin', options.remote.cloneUrl], {
      cwd: checkout,
      profile: 'network',
    });
    return checkout;
  } catch (error) {
    await rm(checkout, { recursive: true, force: true });
    throw error;
  }
}

export interface LibraryMutationContext {
  readonly checkout: string;
  readonly baseRevision: string;
  readonly library: LibraryValidationResult;
}

export interface LibraryMutationApplication<T> {
  readonly changed: boolean;
  readonly value: T;
}

export interface LibraryMutationRequest<T> {
  readonly remote: NormalizedGitRemote;
  readonly branch?: string;
  readonly touchedPaths: readonly string[];
  readonly message: string;
  readonly apply: (context: LibraryMutationContext) => Promise<LibraryMutationApplication<T>>;
}

export interface LibraryMutationResult<T> {
  readonly changed: boolean;
  readonly branch: string;
  readonly baseRevision: string;
  readonly revision: string;
  readonly value: T;
}

export interface LibraryMutationCoordinatorOptions {
  readonly git?: LibraryGitPort;
  readonly cache: LibraryCachePort;
  readonly stagingRoot: string;
  readonly withLock?: LibraryCacheLock;
  readonly maxRemoteAdvanceRetries?: number;
  readonly hooks?: {
    readonly beforePush?: (options: {
      readonly attempt: number;
      readonly checkout: string;
      readonly baseRevision: string;
      readonly candidateRevision: string;
    }) => Promise<void>;
  };
}

export class LibraryMutationCoordinator {
  private readonly git: LibraryGitPort;
  private readonly cache: LibraryCachePort;
  private readonly stagingRoot: string;
  private readonly withLock: LibraryCacheLock;
  private readonly maxRemoteAdvanceRetries: number;
  private readonly hooks: LibraryMutationCoordinatorOptions['hooks'];

  constructor(options: LibraryMutationCoordinatorOptions) {
    this.git = options.git ?? new GitClient();
    this.cache = options.cache;
    this.stagingRoot = options.stagingRoot;
    this.withLock = options.withLock ?? withInProcessLibraryCacheLock;
    this.maxRemoteAdvanceRetries = options.maxRemoteAdvanceRetries ?? 2;
    this.hooks = options.hooks;
  }

  async mutate<T>(request: LibraryMutationRequest<T>): Promise<LibraryMutationResult<T>> {
    request.touchedPaths.forEach(assertPortableRepositoryPath);
    if (request.touchedPaths.length === 0) {
      throw new LibraryLifecycleError(
        'LIBRARY_VALIDATION_FAILED',
        'A library mutation must declare every touched repository path.',
      );
    }
    if (request.message.trim().length === 0 || /[\r\n\0]/u.test(request.message)) {
      throw new LibraryLifecycleError(
        'LIBRARY_VALIDATION_FAILED',
        'A generated commit message must be one nonempty line.',
      );
    }

    return await this.withLock(`lifecycle:${request.remote.identity}`, async () => {
      let base = await this.cache.refresh({
        remote: request.remote,
        ...(request.branch === undefined ? {} : { branch: request.branch }),
        access: 'mutation',
      });

      for (let attempt = 0; attempt <= this.maxRemoteAdvanceRetries; attempt += 1) {
        const checkout = await createCheckout({
          git: this.git,
          stagingRoot: this.stagingRoot,
          cacheRepository: base.repositoryDirectory,
          revision: base.revision,
          remote: request.remote,
        });
        try {
          const before = await validateLibrary(checkout);
          if (!before.valid) throw validationFailure(before);
          const application = await request.apply({
            checkout,
            baseRevision: base.revision,
            library: before,
          });
          if (!application.changed) {
            return {
              changed: false,
              branch: base.branch,
              baseRevision: base.revision,
              revision: base.revision,
              value: application.value,
            };
          }

          const after = await validateLibrary(checkout);
          if (!after.valid) throw validationFailure(after);
          await configureCommitIdentity(this.git, checkout);
          await this.git.run(['add', '--all', '--', '.'], { cwd: checkout, profile: 'content' });
          const status = await this.git.run(['status', '--porcelain', '--untracked-files=all'], {
            cwd: checkout,
            profile: 'content',
          });
          if (status.stdout.trim().length === 0) {
            throw new LibraryLifecycleError(
              'MUTATION_HAS_NO_CHANGES',
              'The requested library mutation produced no commit-worthy change.',
            );
          }
          await this.git.run(
            ['commit', '--quiet', '--no-gpg-sign', '--no-verify', '-m', request.message],
            { cwd: checkout, profile: 'content' },
          );
          const candidateRevision = await exactHead(this.git, checkout);
          await this.hooks?.beforePush?.({
            attempt,
            checkout,
            baseRevision: base.revision,
            candidateRevision,
          });

          try {
            await this.git.run(
              ['push', '--porcelain', '--no-verify', 'origin', `HEAD:refs/heads/${base.branch}`],
              { cwd: checkout, profile: 'network' },
            );
            await this.cache.refresh({
              remote: request.remote,
              branch: base.branch,
              access: 'mutation',
            });
            return {
              changed: true,
              branch: base.branch,
              baseRevision: base.revision,
              revision: candidateRevision,
              value: application.value,
            };
          } catch (pushError) {
            const advanced = await this.refreshAfterRejectedPush(request.remote, base.branch);
            if (advanced.revision === candidateRevision) {
              return {
                changed: true,
                branch: base.branch,
                baseRevision: base.revision,
                revision: candidateRevision,
                value: application.value,
              };
            }
            if (advanced.revision === base.revision) throw pushError;
            if (
              !(await this.touchedPathsUnchanged(
                advanced.repositoryDirectory,
                base.revision,
                advanced.revision,
                request.touchedPaths,
              ))
            ) {
              throw new LibraryLifecycleError(
                'LIBRARY_DIVERGED',
                'The remote advanced in content touched by this mutation; refusing to overwrite it.',
                { expectedRevision: base.revision, fetchedRevision: advanced.revision },
              );
            }
            if (attempt === this.maxRemoteAdvanceRetries) {
              throw new LibraryLifecycleError(
                'LIBRARY_DIVERGED',
                'The remote continued advancing while the mutation was retried.',
                { expectedRevision: base.revision, fetchedRevision: advanced.revision },
              );
            }
            base = advanced;
          }
        } finally {
          await rm(checkout, { recursive: true, force: true });
        }
      }

      throw new LibraryLifecycleError(
        'LIBRARY_DIVERGED',
        'The remote could not be updated optimistically.',
      );
    });
  }

  private async refreshAfterRejectedPush(
    remote: NormalizedGitRemote,
    branch: string,
  ): Promise<LibraryCacheRevision> {
    try {
      return await this.cache.refresh({ remote, branch, access: 'mutation' });
    } catch (error) {
      throw new LibraryLifecycleError(
        'REMOTE_ACCESS_FAILED',
        `The push failed and the remote could not be refreshed safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async touchedPathsUnchanged(
    cacheRepository: string,
    previousRevision: string,
    nextRevision: string,
    touchedPaths: readonly string[],
  ): Promise<boolean> {
    try {
      await this.git.run(
        ['diff', '--quiet', '--no-ext-diff', previousRevision, nextRevision, '--', ...touchedPaths],
        { cwd: cacheRepository, profile: 'content' },
      );
      return true;
    } catch (error) {
      if (error instanceof GitExecutionError && error.exitCode === 1) return false;
      throw error;
    }
  }
}

export interface LibraryInitRequest {
  readonly url: string;
  readonly branch?: string;
  readonly initializeEmpty?: boolean;
}

export interface LibraryInitResult {
  readonly changed: boolean;
  readonly initialized: boolean;
  readonly remote: NormalizedGitRemote;
  readonly branch: string;
  readonly revision: string;
}

export type LibraryInitializationRequest =
  | {
      readonly kind: 'connect';
      readonly url: string;
      readonly branch?: string;
    }
  | {
      readonly kind: 'create';
      readonly repository: string;
      readonly branch?: string;
      readonly transport?: ConfigGitTransport;
      readonly visibility?: GitHubVisibility;
    };

export interface LibraryInitializationExecutionOptions {
  readonly recovery?: InitializationRecoveryRuntime;
  readonly signal?: AbortSignal;
}

export interface LibraryInitPlan {
  readonly action: LibraryInitPlanAction;
  readonly applied: false;
  readonly branch: string;
  readonly configuration: {
    readonly beforeFingerprint: string;
    readonly changed: boolean;
    readonly nextIdentity: string;
    readonly previousIdentity: string | null;
  };
  readonly dryRun: true;
  readonly effects: LibraryInitPlanEffects;
  readonly fingerprint: string;
  readonly operation: 'init';
  readonly remote: NormalizedGitRemote;
  readonly remoteState: 'available' | 'compatible' | 'empty';
  readonly repository: string | null;
  readonly revision: string | null;
  readonly validation: {
    readonly groups: number;
    readonly skills: number;
  } | null;
  readonly visibility: GitHubVisibility | null;
}

export interface LibraryCreateRequest {
  readonly repository: string;
  readonly branch?: string;
  readonly transport?: ConfigGitTransport;
  readonly visibility?: GitHubVisibility;
}

export interface LibraryAddRequest {
  readonly sourcePath: string;
  readonly group?: string;
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly dryRun?: boolean;
}

export interface LibraryAddResult {
  readonly id: QualifiedSkillId;
  readonly digest: string;
  readonly revision: string;
  readonly changed: boolean;
  readonly dryRun: boolean;
}

export interface LibraryPublishRequest {
  readonly ids: readonly string[];
  readonly projectRoot?: string;
  readonly sourcePaths?: Readonly<Record<string, string>>;
  readonly expectedBaseDigests?: Readonly<Record<string, string>>;
  readonly fromTarget?: string;
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly dryRun?: boolean;
}

export interface LibraryPublishResult {
  readonly changed: boolean;
  readonly revision: string;
  readonly dryRun: boolean;
  readonly skills: readonly {
    readonly id: QualifiedSkillId;
    readonly digest: string;
    readonly previousDigest: string;
    readonly changed: boolean;
    readonly diff: {
      readonly added: readonly string[];
      readonly modified: readonly string[];
      readonly removed: readonly string[];
    };
  }[];
  readonly projectStateUpdated: boolean;
}

export interface GroupCreateRequest {
  readonly group: string;
  readonly description?: string;
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly dryRun?: boolean;
}

export interface GroupRenameRequest {
  readonly from: string;
  readonly to: string;
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly dryRun?: boolean;
}

export interface GroupRemoveRequest {
  readonly group: string;
  readonly recursive?: boolean;
  readonly confirmed: boolean;
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly dryRun?: boolean;
}

export interface LibraryRemoveRequest {
  readonly id: string;
  readonly confirmed: boolean;
  readonly remoteUrl?: string;
  readonly branch?: string;
  readonly dryRun?: boolean;
}

export interface LibraryGroupResult {
  readonly revision: string;
  readonly affectedIds: readonly string[];
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly requiresRecursive?: boolean;
  readonly warning?: string;
}

export interface LibraryRemoveResult {
  readonly revision: string;
  readonly id: QualifiedSkillId;
  readonly warning: string;
  readonly changed: boolean;
  readonly dryRun: boolean;
}

interface ResolvedLibraryConnection {
  readonly remote: NormalizedGitRemote;
  readonly branch?: string;
}

interface PreparedLibraryInitialization {
  readonly plan: LibraryInitPlan;
  /** Valid only inside the surrounding initialization-inspection callback. */
  readonly sourceRepositoryDirectory?: string;
}

interface PublicationSource {
  readonly id: QualifiedSkillId;
  readonly skill: ValidatedSkill;
  readonly expectedBaseDigest?: string;
  readonly projectionDigests: ReadonlyMap<string, string>;
}

export interface LibraryLifecycleServiceOptions {
  readonly cache: LibraryCachePort;
  readonly config: LibraryConfigStore;
  readonly stagingRoot: string;
  /** OS-temporary root used only for side-effect-free initialization inspection. */
  readonly inspectionRoot?: string;
  readonly git?: LibraryGitPort;
  readonly github?: GitHubRepositoryPort;
  readonly projectState?: LibraryProjectStateStore;
  readonly coordinator?: LibraryMutationCoordinator;
  readonly normalizeRemote?: (value: string) => NormalizedGitRemote;
  readonly withLock?: LibraryCacheLock;
}

export interface ValidatedLibrarySnapshot {
  /** Valid only for the duration of the withValidatedLibrary callback. */
  readonly rootPath: string;
  readonly identity: string;
  readonly revision: string;
  readonly branch: string;
  readonly freshness: LibraryCacheRevision['freshness'];
  readonly stale: boolean;
  readonly library: LibraryValidationResult;
}

export class LibraryLifecycleService {
  private readonly git: LibraryGitPort;
  private readonly cache: LibraryCachePort;
  private readonly config: LibraryConfigStore;
  private readonly github: GitHubRepositoryPort;
  private readonly projectState: LibraryProjectStateStore;
  private readonly stagingRoot: string;
  private readonly inspectionRoot: string;
  private readonly normalizeRemote: (value: string) => NormalizedGitRemote;
  private readonly withLock: LibraryCacheLock;
  private readonly coordinator: LibraryMutationCoordinator;

  constructor(options: LibraryLifecycleServiceOptions) {
    this.git = options.git ?? new GitClient();
    this.cache = options.cache;
    this.config = options.config;
    this.github = options.github ?? new GhCliRepositoryClient();
    this.projectState = options.projectState ?? fileProjectStateStore;
    this.stagingRoot = options.stagingRoot;
    this.inspectionRoot = options.inspectionRoot ?? tmpdir();
    this.normalizeRemote = options.normalizeRemote ?? normalizeGitRemote;
    this.withLock = options.withLock ?? withInProcessLibraryCacheLock;
    this.coordinator =
      options.coordinator ??
      new LibraryMutationCoordinator({
        git: this.git,
        cache: this.cache,
        stagingRoot: this.stagingRoot,
        withLock: this.withLock,
      });
  }

  async withValidatedLibrary<T>(
    options: {
      readonly remoteUrl?: string;
      readonly branch?: string;
      readonly allowStale?: boolean;
      /** Inspect a verified existing cache without fetching or writing cache state. */
      readonly cacheOnly?: boolean;
    },
    operation: (snapshot: ValidatedLibrarySnapshot) => Promise<T>,
  ): Promise<T> {
    const connection = await this.resolveConnection(options.remoteUrl, options.branch);
    const cacheRequest = {
      remote: connection.remote,
      ...(connection.branch === undefined ? {} : { branch: connection.branch }),
    };
    const cached =
      options.cacheOnly === true
        ? await this.inspectExistingCache(cacheRequest)
        : await this.cache.refresh({
            ...cacheRequest,
            access: 'read-only',
            ...(options.allowStale === undefined ? {} : { allowStale: options.allowStale }),
          });
    if (options.cacheOnly === true && cached.treeDirectory === undefined) {
      throw new LibraryLifecycleError(
        'REMOTE_ACCESS_FAILED',
        'The verified cache has no write-free exact-revision tree snapshot.',
      );
    }
    const usesPersistentTree = cached.treeDirectory !== undefined;
    const checkout =
      cached.treeDirectory ??
      (await createCheckout({
        git: this.git,
        stagingRoot: this.stagingRoot,
        cacheRepository: cached.repositoryDirectory,
        revision: cached.revision,
        remote: connection.remote,
      }));
    try {
      const library = await validateLibrary(checkout);
      if (!library.valid) throw validationFailure(library);
      return await operation({
        rootPath: checkout,
        identity: cached.identity,
        revision: cached.revision,
        branch: cached.branch,
        freshness: cached.freshness,
        stale: cached.stale,
        library,
      });
    } finally {
      if (!usesPersistentTree) {
        await rm(checkout, { recursive: true, force: true });
      }
    }
  }

  async planInitialization(
    request: LibraryInitializationRequest,
    options: LibraryInitializationExecutionOptions = {},
  ): Promise<LibraryInitPlan> {
    return await this.withInitializationInspection(
      async (git, inspection) =>
        (await this.prepareInitialization(request, git, inspection, options.signal)).plan,
      options.signal,
    );
  }

  async applyInitialization(
    request: LibraryInitializationRequest,
    expectedPlanFingerprint: string,
    options: LibraryInitializationExecutionOptions = {},
  ): Promise<LibraryInitResult> {
    const coordinationIdentity =
      request.kind === 'connect'
        ? this.normalizeRemote(request.url).identity
        : `github.com/${request.repository.toLocaleLowerCase('en-US')}`;
    return await this.withLock(
      `lifecycle:${coordinationIdentity}`,
      async () =>
        await this.withInitializationInspection(async (git, inspection) => {
          const prepared = await this.prepareInitialization(
            request,
            git,
            inspection,
            options.signal,
          );
          const current = prepared.plan;
          if (current.fingerprint !== expectedPlanFingerprint) {
            throw new LibraryLifecycleError(
              'INIT_PLAN_CHANGED',
              'The initialization plan changed after review, so nothing was applied. Run the same init command with --dry-run, then apply its new --expect-plan fingerprint.',
              { currentPlan: current, expectedPlanFingerprint },
            );
          }
          await this.assertPlannedConfiguration(current);

          if (current.action === 'connect') {
            if (prepared.sourceRepositoryDirectory === undefined || current.revision === null) {
              throw new LibraryLifecycleError(
                'INIT_PLAN_CHANGED',
                'The reviewed library snapshot is no longer available, so nothing was applied. Run the same init command with --dry-run and review the new plan.',
              );
            }
            let cached: LibraryCacheRevision;
            try {
              cached = await this.cache.promoteExact({
                remote: current.remote,
                branch: current.branch,
                revision: current.revision,
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                sourceRepositoryDirectory: prepared.sourceRepositoryDirectory,
              });
            } catch (error) {
              if (error instanceof LibraryCacheExpectedRevisionError) {
                throw new LibraryLifecycleError(
                  'INIT_PLAN_CHANGED',
                  'The library remote changed after review, so the persistent cache and saved configuration were not changed.',
                  {
                    currentPlan: current,
                    expectedRevision: error.expectedRevision,
                    ...(error.actualRevision === undefined
                      ? {}
                      : { fetchedRevision: error.actualRevision }),
                  },
                );
              }
              throw error;
            }
            if (
              cached.branch !== current.branch ||
              cached.revision.toLowerCase() !== current.revision.toLowerCase()
            ) {
              throw new LibraryLifecycleError(
                'INIT_PLAN_CHANGED',
                'The prepared cache did not match the reviewed plan. The saved configuration was not changed; run the same init command with --dry-run before retrying.',
                {
                  expectedRevision: current.revision,
                  fetchedRevision: cached.revision,
                },
              );
            }
            const library = await this.validateCachedRevision(current.remote, cached);
            if (!library.valid) throw validationFailure(library);
            const recovery =
              options.recovery === undefined
                ? undefined
                : await InitializationRecoverySession.create(current, options.recovery);
            const changed = await this.persistPlannedLibraryConfig(current, recovery);
            await recovery?.complete();
            return {
              changed,
              initialized: false,
              remote: current.remote,
              branch: current.branch,
              revision: cached.revision,
            };
          }

          if (current.action === 'create') {
            const recovery =
              options.recovery === undefined
                ? undefined
                : await InitializationRecoverySession.create(current, options.recovery);
            try {
              await recovery?.begin('provider');
              const created = await this.github.createRepository({
                repository: current.repository ?? '',
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                transport: current.remote.transport,
                visibility: current.visibility ?? 'private',
              });
              await recovery?.confirm('provider');
              const createdRemote = this.normalizeRemote(created.cloneUrl);
              if (createdRemote.identity !== current.remote.identity) {
                throw new LibraryLifecycleError(
                  'INIT_PLAN_CHANGED',
                  'GitHub returned a different repository than the reviewed plan. The created repository may still exist; inspect it before retrying.',
                );
              }
              const advertised = await this.listRemote(createdRemote, git);
              if (advertised.trim().length > 0) {
                throw new LibraryLifecycleError(
                  'REMOTE_NOT_EMPTY',
                  'The newly created repository was unexpectedly nonempty; refusing to initialize it.',
                );
              }
              const revision = await this.initializeEmptyRemoteUnderLock(
                createdRemote,
                current.branch,
                git,
                options.signal,
                recovery,
              );
              const changed = await this.persistPlannedLibraryConfig(current, recovery);
              await recovery?.complete();
              return {
                changed,
                initialized: true,
                remote: createdRemote,
                branch: current.branch,
                revision,
              };
            } catch (error) {
              if (error instanceof LibraryLifecycleError) {
                const repositoryBoundary =
                  error.code === 'REMOTE_ACCESS_FAILED'
                    ? 'The GitHub repository was created before this access check failed and may still exist.'
                    : 'The GitHub repository was created and may still exist.';
                throw new LibraryLifecycleError(
                  error.code,
                  `${error.message} ${repositoryBoundary} Inspect it with your Git provider before retrying or deleting it.`,
                  error.details,
                );
              }
              throw new LibraryLifecycleError(
                'GITHUB_CREATE_FAILED',
                `GitHub repository initialization failed: ${gitFailureDiagnostic(error)} The GitHub repository was created and may still exist. Inspect it with your Git provider before retrying or deleting it.`,
              );
            }
          }

          const recovery =
            options.recovery === undefined
              ? undefined
              : await InitializationRecoverySession.create(current, options.recovery);
          const revision = await this.initializeEmptyRemoteUnderLock(
            current.remote,
            current.branch,
            git,
            options.signal,
            recovery,
          );
          const changed = await this.persistPlannedLibraryConfig(current, recovery);
          await recovery?.complete();
          return {
            changed,
            initialized: true,
            remote: current.remote,
            branch: current.branch,
            revision,
          };
        }, options.signal),
    );
  }

  async init(request: LibraryInitRequest): Promise<LibraryInitResult> {
    const initializationRequest: LibraryInitializationRequest = {
      kind: 'connect',
      url: request.url,
      ...(request.branch === undefined ? {} : { branch: request.branch }),
    };
    const plan = await this.planInitialization(initializationRequest);
    if (plan.action === 'initialize-empty' && request.initializeEmpty !== true) {
      throw new LibraryLifecycleError(
        'REMOTE_EMPTY_CONFIRMATION_REQUIRED',
        'The remote is empty and requires explicit confirmation before initialization.',
        { currentPlan: plan },
      );
    }
    return await this.applyInitialization(initializationRequest, plan.fingerprint);
  }

  async create(request: LibraryCreateRequest): Promise<LibraryInitResult> {
    const initializationRequest: LibraryInitializationRequest = {
      kind: 'create',
      repository: request.repository,
      ...(request.branch === undefined ? {} : { branch: request.branch }),
      ...(request.transport === undefined ? {} : { transport: request.transport }),
      ...(request.visibility === undefined ? {} : { visibility: request.visibility }),
    };
    const plan = await this.planInitialization(initializationRequest);
    return await this.applyInitialization(initializationRequest, plan.fingerprint);
  }

  async add(request: LibraryAddRequest): Promise<LibraryAddResult> {
    const group = parseGroupPath(request.group ?? '');
    const sourceName = parsePortableSlug(basename(resolve(request.sourcePath)));
    const id = parseQualifiedSkillId(group.length === 0 ? sourceName : `${group}/${sourceName}`);
    const validation = await validateSkillDirectory(request.sourcePath, id);
    if (!validation.valid || validation.skill === null) {
      throw new LibraryLifecycleError(
        'INVALID_SKILL_SOURCE',
        'The local skill source is invalid.',
        { errors: validation.errors },
      );
    }
    const source = validation.skill;
    const connection = await this.resolveConnection(request.remoteUrl, request.branch);
    if (request.dryRun === true) {
      const revision = await this.withValidatedLibrary(
        {
          ...(request.remoteUrl === undefined ? {} : { remoteUrl: request.remoteUrl }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        },
        (snapshot) => {
          if (snapshot.library.skills.some((skill) => skill.id === id)) {
            throw new LibraryLifecycleError(
              'SKILL_EXISTS',
              `The canonical skill ${id} already exists; use publish to update it.`,
            );
          }
          return Promise.resolve(snapshot.revision);
        },
      );
      return { id, digest: source.digest, revision, changed: true, dryRun: true };
    }
    const result = await this.coordinator.mutate({
      remote: connection.remote,
      ...(connection.branch === undefined ? {} : { branch: connection.branch }),
      touchedPaths: [`skills/${id}`],
      message: `skill-sync: add ${id}`,
      apply: async ({ checkout, library }) => {
        if (library.skills.some((skill) => skill.id === id)) {
          throw new LibraryLifecycleError(
            'SKILL_EXISTS',
            `The canonical skill ${id} already exists; use publish to update it.`,
          );
        }
        await ensureGroupMarkers(checkout, group);
        await copyValidatedSkill(source, canonicalSkillPath(checkout, group, sourceName).path);
        return { changed: true, value: undefined };
      },
    });
    return {
      id,
      digest: source.digest,
      revision: result.revision,
      changed: true,
      dryRun: false,
    };
  }

  async publish(request: LibraryPublishRequest): Promise<LibraryPublishResult> {
    const ids = [...new Set(request.ids.map((id) => parseQualifiedSkillId(id)))].sort(
      comparePortableStrings,
    );
    if (ids.length === 0) {
      throw new LibraryLifecycleError(
        'INVALID_SKILL_SOURCE',
        'Publish requires at least one qualified skill ID.',
      );
    }
    const project =
      request.projectRoot === undefined
        ? undefined
        : await this.readRequiredProjectState(request.projectRoot);
    const sources = await Promise.all(
      ids.map(async (id) => await this.resolvePublicationSource(id, request, project)),
    );
    const connection = await this.resolveConnection(request.remoteUrl, request.branch);
    if (
      project !== undefined &&
      (project.manifest.library.identity !== connection.remote.identity ||
        project.lock.library.identity !== connection.remote.identity)
    ) {
      throw new LibraryLifecycleError(
        'PROJECT_STATE_REQUIRED',
        'The project is tracked against a different canonical library.',
      );
    }
    if (request.dryRun === true) {
      return await this.withValidatedLibrary(
        {
          ...(request.remoteUrl === undefined ? {} : { remoteUrl: request.remoteUrl }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        },
        (snapshot) => {
          const skills = this.previewPublication(sources, snapshot.library);
          return Promise.resolve({
            changed: skills.some((skill) => skill.changed),
            revision: snapshot.revision,
            dryRun: true,
            skills,
            projectStateUpdated: false,
          });
        },
      );
    }
    let publishedSkills: LibraryPublishResult['skills'] = [];
    const result = await this.coordinator.mutate({
      remote: connection.remote,
      ...(connection.branch === undefined ? {} : { branch: connection.branch }),
      touchedPaths: ids.map((id) => `skills/${id}`),
      message: `skill-sync: publish ${ids.join(', ')}`,
      apply: async ({ checkout, library }) => {
        publishedSkills = this.previewPublication(sources, library);
        for (const source of sources) {
          const preview = publishedSkills.find((skill) => skill.id === source.id);
          if (preview?.changed === true) {
            await replaceValidatedSkill(
              source.skill,
              canonicalSkillPath(checkout, source.skill.group, source.skill.name).path,
            );
          }
        }
        return { changed: publishedSkills.some((skill) => skill.changed), value: undefined };
      },
    });
    if (project !== undefined && request.projectRoot !== undefined) {
      await this.updatePublishedProjectState(
        request.projectRoot,
        project.lock,
        sources,
        result.revision,
      );
    }
    return {
      changed: result.changed,
      revision: result.revision,
      dryRun: false,
      skills: publishedSkills,
      projectStateUpdated: project !== undefined,
    };
  }

  async groupList(
    options: {
      readonly remoteUrl?: string;
      readonly branch?: string;
    } = {},
  ): Promise<readonly { readonly path: string; readonly description: string | null }[]> {
    return await this.withValidatedLibrary({ ...options, allowStale: true }, ({ library }) =>
      Promise.resolve(
        library.groups.map((group) => ({
          path: group.path,
          description: group.description,
        })),
      ),
    );
  }

  async groupCreate(request: GroupCreateRequest): Promise<LibraryGroupResult> {
    const group = this.parseNonRootGroup(request.group);
    const connection = await this.resolveConnection(request.remoteUrl, request.branch);
    if (request.dryRun === true) {
      const revision = await this.withValidatedLibrary(
        {
          ...(request.remoteUrl === undefined ? {} : { remoteUrl: request.remoteUrl }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        },
        (snapshot) => {
          this.assertCanCreateGroup(snapshot.library, group);
          return Promise.resolve(snapshot.revision);
        },
      );
      return { revision, affectedIds: [], changed: true, dryRun: true };
    }
    const result = await this.coordinator.mutate({
      remote: connection.remote,
      ...(connection.branch === undefined ? {} : { branch: connection.branch }),
      touchedPaths: [`skills/${group}`],
      message: `skill-sync: create group ${group}`,
      apply: async ({ checkout, library }) => {
        this.assertCanCreateGroup(library, group);
        await ensureGroupMarkers(checkout, group);
        if (request.description !== undefined) {
          const description = request.description.trim();
          if (description.length === 0) {
            throw new LibraryLifecycleError(
              'LIBRARY_VALIDATION_FAILED',
              'A group description must not be empty.',
            );
          }
          await writeJsonAtomic(
            join(checkout, 'skills', ...group.split('/'), GROUP_MARKER_FILE),
            { schemaVersion: LIBRARY_SCHEMA_VERSION, description },
            { mode: 0o644 },
          );
        }
        return { changed: true, value: undefined };
      },
    });
    return {
      revision: result.revision,
      affectedIds: [],
      changed: true,
      dryRun: false,
    };
  }

  async groupRename(request: GroupRenameRequest): Promise<LibraryGroupResult> {
    const from = this.parseNonRootGroup(request.from);
    const to = this.parseNonRootGroup(request.to);
    if (to === from || to.startsWith(`${from}/`)) {
      throw new LibraryLifecycleError(
        'GROUP_EXISTS',
        'A group cannot be renamed to itself or into its own subtree.',
      );
    }
    const connection = await this.resolveConnection(request.remoteUrl, request.branch);
    const warning =
      'Renaming group paths changes qualified skill IDs; other projects may report the previous IDs as orphaned.';
    if (request.dryRun === true) {
      return await this.withValidatedLibrary(
        {
          ...(request.remoteUrl === undefined ? {} : { remoteUrl: request.remoteUrl }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        },
        (snapshot) =>
          Promise.resolve({
            revision: snapshot.revision,
            affectedIds: this.planGroupRename(snapshot.library, from, to),
            changed: true,
            dryRun: true,
            warning,
          }),
      );
    }
    const result = await this.coordinator.mutate({
      remote: connection.remote,
      ...(connection.branch === undefined ? {} : { branch: connection.branch }),
      touchedPaths: [`skills/${from}`, `skills/${to}`],
      message: `skill-sync: rename group ${from} to ${to}`,
      apply: async ({ checkout, library }) => {
        const affectedIds = this.planGroupRename(library, from, to);
        const targetParent = parseGroupPath(
          to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '',
        );
        await ensureGroupMarkers(checkout, targetParent);
        const fromPath = join(checkout, 'skills', ...from.split('/'));
        const toPath = join(checkout, 'skills', ...to.split('/'));
        await mkdir(dirname(toPath), { recursive: true, mode: 0o700 });
        await rename(fromPath, toPath);
        return { changed: true, value: affectedIds };
      },
    });
    return {
      revision: result.revision,
      affectedIds: result.value,
      changed: true,
      dryRun: false,
      warning,
    };
  }

  async groupRemove(request: GroupRemoveRequest): Promise<LibraryGroupResult> {
    const group = this.parseNonRootGroup(request.group);
    if (!request.confirmed && request.dryRun !== true) {
      throw new LibraryLifecycleError(
        'DESTRUCTIVE_CONFIRMATION_REQUIRED',
        'Removing a library group requires explicit destructive confirmation.',
      );
    }
    const connection = await this.resolveConnection(request.remoteUrl, request.branch);
    if (request.dryRun === true) {
      return await this.withValidatedLibrary(
        {
          ...(request.remoteUrl === undefined ? {} : { remoteUrl: request.remoteUrl }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        },
        (snapshot) => {
          const affectedIds = this.planGroupRemoval(snapshot.library, group);
          return Promise.resolve({
            revision: snapshot.revision,
            affectedIds,
            changed: true,
            dryRun: true,
            ...(affectedIds.length === 0
              ? {}
              : {
                  warning:
                    'Removing this group leaves existing project copies installed as orphaned skills.',
                }),
            ...(affectedIds.length > 0 && request.recursive !== true
              ? { requiresRecursive: true }
              : {}),
          });
        },
      );
    }
    const result = await this.coordinator.mutate({
      remote: connection.remote,
      ...(connection.branch === undefined ? {} : { branch: connection.branch }),
      touchedPaths: [`skills/${group}`],
      message: `skill-sync: remove group ${group}`,
      apply: async ({ checkout, library }) => {
        const affectedIds = this.planGroupRemoval(library, group);
        if (affectedIds.length > 0 && request.recursive !== true) {
          throw new LibraryLifecycleError(
            'GROUP_NOT_EMPTY',
            `Group ${group} contains skills and requires the explicit recursive option.`,
            { affectedIds },
          );
        }
        await rm(join(checkout, 'skills', ...group.split('/')), {
          recursive: true,
          force: false,
        });
        return { changed: true, value: affectedIds };
      },
    });
    return {
      revision: result.revision,
      affectedIds: result.value,
      changed: true,
      dryRun: false,
      ...(result.value.length === 0
        ? {}
        : {
            warning:
              'Removing this group leaves existing project copies installed as orphaned skills.',
          }),
    };
  }

  async libraryRemove(request: LibraryRemoveRequest): Promise<LibraryRemoveResult> {
    const id = parseQualifiedSkillId(request.id);
    if (!request.confirmed && request.dryRun !== true) {
      throw new LibraryLifecycleError(
        'DESTRUCTIVE_CONFIRMATION_REQUIRED',
        'Removing a canonical skill requires explicit destructive confirmation.',
      );
    }
    const connection = await this.resolveConnection(request.remoteUrl, request.branch);
    const warning =
      'Project copies were not uninstalled and are now orphaned; recover canonical content through Git history.';
    if (request.dryRun === true) {
      const revision = await this.withValidatedLibrary(
        {
          ...(request.remoteUrl === undefined ? {} : { remoteUrl: request.remoteUrl }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        },
        (snapshot) => {
          if (!snapshot.library.skills.some((skill) => skill.id === id)) {
            throw new LibraryLifecycleError('SKILL_NOT_FOUND', `Skill ${id} does not exist.`);
          }
          return Promise.resolve(snapshot.revision);
        },
      );
      return { revision, id, warning, changed: true, dryRun: true };
    }
    const result = await this.coordinator.mutate({
      remote: connection.remote,
      ...(connection.branch === undefined ? {} : { branch: connection.branch }),
      touchedPaths: [`skills/${id}`],
      message: `skill-sync: remove ${id}`,
      apply: async ({ checkout, library }) => {
        if (!library.skills.some((skill) => skill.id === id)) {
          throw new LibraryLifecycleError('SKILL_NOT_FOUND', `Skill ${id} does not exist.`);
        }
        await rm(join(checkout, 'skills', ...id.split('/')), { recursive: true, force: false });
        return { changed: true, value: undefined };
      },
    });
    return {
      revision: result.revision,
      id,
      warning,
      changed: true,
      dryRun: false,
    };
  }

  private assertCanCreateGroup(library: LibraryValidationResult, group: GroupPath): void {
    if (library.groups.some((item) => item.path === group)) {
      throw new LibraryLifecycleError('GROUP_EXISTS', `Group ${group} already exists.`);
    }
    const segments = group.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/');
      if (library.skills.some((skill) => String(skill.id) === prefix)) {
        throw new LibraryLifecycleError(
          'GROUP_EXISTS',
          `Skill ${prefix} prevents creation of group ${group}.`,
        );
      }
    }
  }

  private planGroupRename(
    library: LibraryValidationResult,
    from: GroupPath,
    to: GroupPath,
  ): readonly string[] {
    if (!library.groups.some((group) => group.path === from)) {
      throw new LibraryLifecycleError('GROUP_NOT_FOUND', `Group ${from} does not exist.`);
    }
    if (
      library.groups.some((group) => group.path === to) ||
      library.skills.some(
        (skill) => String(skill.id) === String(to) || skill.id.startsWith(`${to}/`),
      )
    ) {
      throw new LibraryLifecycleError('GROUP_EXISTS', `Group ${to} already exists.`);
    }
    return library.skills
      .filter((skill) => skill.group === from || skill.group.startsWith(`${from}/`))
      .map((skill) => {
        const suffix = skill.id.slice(from.length);
        return `${skill.id} -> ${to}${suffix}`;
      })
      .sort(comparePortableStrings);
  }

  private planGroupRemoval(library: LibraryValidationResult, group: GroupPath): readonly string[] {
    if (!library.groups.some((item) => item.path === group)) {
      throw new LibraryLifecycleError('GROUP_NOT_FOUND', `Group ${group} does not exist.`);
    }
    return library.skills
      .filter((skill) => skill.group === group || skill.group.startsWith(`${group}/`))
      .map((skill) => skill.id)
      .sort(comparePortableStrings);
  }

  private async inspectExistingCache(
    request: LibraryCacheInspectRequest,
  ): Promise<LibraryCacheRevision> {
    if (this.cache.inspect === undefined) {
      throw new LibraryLifecycleError(
        'REMOTE_ACCESS_FAILED',
        'The configured cache adapter does not support write-free cache inspection.',
      );
    }
    return await this.cache.inspect(request);
  }

  private async listRemote(
    remote: NormalizedGitRemote,
    git: LibraryGitPort = this.git,
  ): Promise<string> {
    try {
      return (await git.run(['ls-remote', '--symref', remote.cloneUrl])).stdout;
    } catch (error) {
      const guidance =
        remote.transport === 'ssh'
          ? 'For SSH, check that the correct key is loaded and the host is configured in SSH.'
          : 'For HTTPS, configure a Git credential helper or authenticate with your Git provider (for GitHub, run gh auth login).';
      throw new LibraryLifecycleError(
        'REMOTE_ACCESS_FAILED',
        `The library remote could not be accessed. Git reported: ${gitFailureDiagnostic(error)} Verify the repository exists and your account has access. ${guidance}`,
      );
    }
  }

  private async withInitializationInspection<T>(
    operation: (git: LibraryGitPort, inspection: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await mkdir(this.inspectionRoot, { recursive: true, mode: 0o700 });
    const inspection = await mkdtemp(join(this.inspectionRoot, 'skill-sync-init-plan-'));
    const commandGit: LibraryGitPort =
      signal === undefined
        ? this.git
        : this.git instanceof GitClient
          ? this.git.withSignal(signal)
          : {
              run: async (arguments_, options) =>
                await this.git.run(arguments_, {
                  ...options,
                  signal: options?.signal ?? signal,
                }),
            };
    const git =
      commandGit instanceof GitClient
        ? commandGit.withSafetyDirectory(join(inspection, 'git-safety'))
        : commandGit;
    try {
      return await operation(git, inspection);
    } finally {
      await rm(inspection, { recursive: true, force: true });
    }
  }

  private async prepareInitialization(
    request: LibraryInitializationRequest,
    git: LibraryGitPort,
    inspection: string,
    signal?: AbortSignal,
  ): Promise<PreparedLibraryInitialization> {
    if (request.kind === 'create') {
      const branch = request.branch ?? 'main';
      await this.assertInitializationBranch(branch, git);
      const transport = request.transport ?? 'https';
      const visibility = request.visibility ?? 'private';
      const inspected = await this.github.inspectRepository({
        repository: request.repository,
        ...(signal === undefined ? {} : { signal }),
        transport,
        visibility,
      });
      const remote = this.normalizeRemote(inspected.cloneUrl);
      return {
        plan: await this.buildInitializationPlan({
          action: 'create',
          branch,
          remote,
          remoteState: 'available',
          repository: request.repository,
          revision: null,
          validation: null,
          visibility,
        }),
      };
    }

    if (request.branch !== undefined) {
      await this.assertInitializationBranch(request.branch, git);
    }
    const remote = this.normalizeRemote(request.url);
    const advertised = await this.listRemote(remote, git);
    if (advertised.trim().length === 0) {
      const branch = request.branch ?? 'main';
      await this.assertInitializationBranch(branch, git);
      return {
        plan: await this.buildInitializationPlan({
          action: 'initialize-empty',
          branch,
          remote,
          remoteState: 'empty',
          repository: null,
          revision: null,
          validation: null,
          visibility: null,
        }),
      };
    }

    const inspected = await this.inspectRemoteLibrary(
      remote,
      advertised,
      request.branch,
      git,
      inspection,
    );
    return {
      plan: await this.buildInitializationPlan({
        action: 'connect',
        branch: inspected.branch,
        remote,
        remoteState: 'compatible',
        repository: null,
        revision: inspected.revision,
        validation: {
          groups: inspected.library.groups.length,
          skills: inspected.library.skills.length,
        },
        visibility: null,
      }),
      sourceRepositoryDirectory: inspected.repositoryDirectory,
    };
  }

  private async buildInitializationPlan(options: {
    readonly action: LibraryInitPlanAction;
    readonly branch: string;
    readonly remote: NormalizedGitRemote;
    readonly remoteState: LibraryInitPlan['remoteState'];
    readonly repository: string | null;
    readonly revision: string | null;
    readonly validation: LibraryInitPlan['validation'];
    readonly visibility: GitHubVisibility | null;
  }): Promise<LibraryInitPlan> {
    const configuration = await this.plannedLibraryConfiguration(options.remote, options.branch);
    const effects: LibraryInitPlanEffects = {
      cache: 'refresh',
      configuration: configuration.changed ? 'write' : 'none',
      githubRepository: options.action === 'create' ? 'create' : 'none',
      remoteLibrary: options.action === 'connect' ? 'none' : 'initialize',
    };
    const fingerprint = initPlanFingerprint({
      action: options.action,
      branch: options.branch,
      configuration: { after: configuration.next, before: configuration.previous ?? null },
      effects,
      remote: {
        cloneUrl: options.remote.cloneUrl,
        identity: options.remote.identity,
        transport: options.remote.transport,
      },
      repository: options.repository,
      revision: options.revision,
      validation: options.validation,
      visibility: options.visibility,
    });
    return {
      action: options.action,
      applied: false,
      branch: options.branch,
      configuration: {
        beforeFingerprint: initConfigurationFingerprint(configuration.previous),
        changed: configuration.changed,
        nextIdentity: options.remote.identity,
        previousIdentity: configuration.previous?.library?.identity ?? null,
      },
      dryRun: true,
      effects,
      fingerprint,
      operation: 'init',
      remote: options.remote,
      remoteState: options.remoteState,
      repository: options.repository,
      revision: options.revision,
      validation: options.validation,
      visibility: options.visibility,
    };
  }

  private async plannedLibraryConfiguration(
    remote: NormalizedGitRemote,
    branch: string,
  ): Promise<{
    readonly changed: boolean;
    readonly next: UserConfig;
    readonly previous?: UserConfig;
  }> {
    const previous = await this.config.read();
    const next: UserConfig = {
      ...(previous?.defaults === undefined ? {} : { defaults: previous.defaults }),
      library: {
        branch,
        identity: remote.identity,
        remote: remote.cloneUrl,
        transport: remote.transport,
      },
      schemaVersion: USER_CONFIG_SCHEMA_VERSION,
    };
    return {
      changed: initConfigurationFingerprint(previous) !== initConfigurationFingerprint(next),
      next,
      ...(previous === undefined ? {} : { previous }),
    };
  }

  private async assertPlannedConfiguration(plan: LibraryInitPlan): Promise<void> {
    const current = await this.config.read();
    if (initConfigurationFingerprint(current) !== plan.configuration.beforeFingerprint) {
      throw new LibraryLifecycleError(
        'INIT_PLAN_CHANGED',
        'The saved configuration changed after review. Review the current plan before applying it.',
      );
    }
  }

  private async persistPlannedLibraryConfig(
    plan: LibraryInitPlan,
    recovery?: InitializationRecoverySession,
  ): Promise<boolean> {
    await this.assertPlannedConfiguration(plan);
    const configuration = await this.plannedLibraryConfiguration(plan.remote, plan.branch);
    if (!configuration.changed) return false;
    try {
      await recovery?.begin('configuration');
      await this.config.replace(configuration.next);
      await recovery?.confirm('configuration');
    } catch (error) {
      try {
        await this.config.replace(configuration.previous);
        await recovery?.markRolledBack('configuration');
      } catch (rollbackError) {
        recovery?.markRecoveryRequired();
        throw new RecoveryIntegrityError(
          'failed-rollback',
          `The library configuration write failed and the previous configuration could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: error },
        );
      }
      throw new LibraryLifecycleError(
        'CONFIG_PERSIST_FAILED',
        `The library was prepared but configuration persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  }

  private async assertInitializationBranch(
    branch: string,
    git: LibraryGitPort = this.git,
  ): Promise<void> {
    try {
      await git.run(['check-ref-format', '--branch', branch], { profile: 'content' });
    } catch (error) {
      throw new LibraryLifecycleError(
        'LIBRARY_VALIDATION_FAILED',
        `The initialization branch is invalid: ${gitFailureDiagnostic(error)}`,
      );
    }
  }

  private defaultBranchFromAdvertisement(advertised: string): string {
    for (const line of advertised.split(/\r?\n/u)) {
      const match = /^ref:\s+refs\/heads\/(.+)\tHEAD$/u.exec(line);
      if (match?.[1] !== undefined) return match[1];
    }
    throw new LibraryLifecycleError(
      'REMOTE_ACCESS_FAILED',
      'The remote did not advertise a default branch. Specify one explicitly with --branch <name>.',
    );
  }

  private async inspectRemoteLibrary(
    remote: NormalizedGitRemote,
    advertised: string,
    requestedBranch: string | undefined,
    git: LibraryGitPort,
    inspection: string,
  ): Promise<{
    readonly branch: string;
    readonly revision: string;
    readonly library: LibraryValidationResult;
    readonly repositoryDirectory: string;
  }> {
    const branch = requestedBranch ?? this.defaultBranchFromAdvertisement(advertised);
    await this.assertInitializationBranch(branch, git);
    try {
      const repository = join(inspection, 'repository.git');
      await git.run(['init', '--quiet', '--bare', repository], { profile: 'content' });
      await git.run(['remote', 'add', 'origin', remote.cloneUrl], {
        cwd: repository,
        profile: 'network',
      });
      const remoteReference = `refs/remotes/origin/${branch}`;
      await git.run(
        [
          'fetch',
          '--force',
          '--prune',
          '--no-tags',
          '--no-recurse-submodules',
          'origin',
          `+refs/heads/${branch}:${remoteReference}`,
        ],
        { cwd: repository, profile: 'network' },
      );
      const resolved = await git.run(
        ['rev-parse', '--verify', '--end-of-options', `${remoteReference}^{commit}`],
        { cwd: repository, profile: 'content' },
      );
      const revision = resolved.stdout.trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision)) {
        throw new LibraryLifecycleError(
          'REMOTE_ACCESS_FAILED',
          'Git did not resolve an exact commit for the initialization plan.',
        );
      }
      const checkout = await createCheckout({
        git,
        stagingRoot: inspection,
        cacheRepository: repository,
        revision,
        remote,
      });
      const library = await validateLibrary(checkout);
      if (!library.valid) {
        throw new LibraryLifecycleError(
          'INCOMPATIBLE_LIBRARY',
          'The nonempty remote is not a compatible skill-sync library. Its contents and your saved library configuration were left unchanged. Next: preview a compatible or empty repository with skill-sync init <repository-url> --dry-run, or preview a new one with skill-sync init --create <owner/name> --dry-run.',
          { errors: library.errors },
        );
      }
      return { branch, revision, library, repositoryDirectory: repository };
    } catch (error) {
      if (error instanceof LibraryLifecycleError) throw error;
      throw new LibraryLifecycleError(
        'REMOTE_ACCESS_FAILED',
        `The selected library branch could not be inspected: ${gitFailureDiagnostic(error)}`,
      );
    }
  }

  private async initializeEmptyRemoteUnderLock(
    remote: NormalizedGitRemote,
    branch: string,
    git: LibraryGitPort = this.git,
    signal?: AbortSignal,
    recovery?: InitializationRecoverySession,
  ): Promise<string> {
    await this.assertInitializationBranch(branch, git);
    const advertised = await this.listRemote(remote, git);
    if (advertised.trim().length > 0) {
      throw new LibraryLifecycleError(
        'REMOTE_NOT_EMPTY',
        'The remote advanced before initialization; refusing to overwrite it.',
      );
    }
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const checkout = await mkdtemp(join(this.stagingRoot, 'initialize-'));
    try {
      await git.run(['init', '--quiet', `--initial-branch=${branch}`, checkout], {
        profile: 'content',
      });
      await mkdir(join(checkout, '.skill-sync'), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(
        join(checkout, LIBRARY_MANIFEST_PATH),
        { schemaVersion: LIBRARY_SCHEMA_VERSION },
        { mode: 0o644 },
      );
      const validation = await validateLibrary(checkout);
      if (!validation.valid) throw validationFailure(validation);
      await configureCommitIdentity(git, checkout);
      await git.run(['add', '--all', '--', '.'], { cwd: checkout, profile: 'content' });
      await git.run(
        [
          'commit',
          '--quiet',
          '--no-gpg-sign',
          '--no-verify',
          '-m',
          'skill-sync: initialize library',
        ],
        { cwd: checkout, profile: 'content' },
      );
      const revision = await exactHead(git, checkout);
      await git.run(['remote', 'add', 'origin', remote.cloneUrl], {
        cwd: checkout,
        profile: 'network',
      });
      await recovery?.begin('push');
      await git.run(['push', '--porcelain', '--no-verify', 'origin', `HEAD:refs/heads/${branch}`], {
        cwd: checkout,
        profile: 'network',
      });
      await recovery?.confirm('push', { expectedRevision: revision });
      const cached = await this.cache.refresh({
        remote,
        branch,
        access: 'mutation',
        ...(signal === undefined ? {} : { signal }),
      });
      if (cached.revision !== revision) {
        throw new LibraryLifecycleError(
          'LIBRARY_DIVERGED',
          'The remote advanced immediately after initialization.',
          { initializedRevision: revision, fetchedRevision: cached.revision },
        );
      }
      return revision;
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }

  private async validateCachedRevision(
    remote: NormalizedGitRemote,
    cached: LibraryCacheRevision,
  ): Promise<LibraryValidationResult> {
    if (cached.treeDirectory !== undefined) {
      return await validateLibrary(cached.treeDirectory);
    }
    const checkout = await createCheckout({
      git: this.git,
      stagingRoot: this.stagingRoot,
      cacheRepository: cached.repositoryDirectory,
      revision: cached.revision,
      remote,
    });
    try {
      return await validateLibrary(checkout);
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }

  private async resolveConnection(
    explicitUrl: string | undefined,
    explicitBranch: string | undefined,
  ): Promise<ResolvedLibraryConnection> {
    if (explicitUrl !== undefined) {
      return {
        remote: this.normalizeRemote(explicitUrl),
        ...(explicitBranch === undefined ? {} : { branch: explicitBranch }),
      };
    }
    const config = await this.config.read();
    if (config?.library === undefined) {
      throw new LibraryLifecycleError(
        'REMOTE_ACCESS_FAILED',
        'No default skill library is configured. Preview setup with skill-sync init <repository-url> --dry-run or skill-sync init --create <owner/name> --dry-run, then run the exact --expect-plan command printed by the preview.',
      );
    }
    const branch = explicitBranch ?? config.library.branch;
    return {
      remote: this.normalizeRemote(config.library.remote),
      ...(branch === undefined ? {} : { branch }),
    };
  }

  private parseNonRootGroup(value: string): GroupPath {
    const group = parseGroupPath(value);
    if (group.length === 0) {
      throw new LibraryLifecycleError(
        'GROUP_NOT_FOUND',
        'The root skills directory is not a removable or renameable group.',
      );
    }
    return group;
  }

  private async readRequiredProjectState(projectRoot: string): Promise<{
    readonly manifest: ProjectManifest;
    readonly lock: ProjectLock;
  }> {
    const [manifest, lock] = await Promise.all([
      this.projectState.readManifest(projectRoot),
      this.projectState.readLock(projectRoot),
    ]);
    if (manifest === undefined || lock === undefined) {
      throw new LibraryLifecycleError(
        'PROJECT_STATE_REQUIRED',
        'Publishing tracked skills requires both project manifest and lock state.',
      );
    }
    assertProjectStatePair(manifest, lock);
    return { manifest, lock };
  }

  private async resolvePublicationSource(
    id: QualifiedSkillId,
    request: LibraryPublishRequest,
    project: { readonly manifest: ProjectManifest; readonly lock: ProjectLock } | undefined,
  ): Promise<PublicationSource> {
    const explicitPath = request.sourcePaths?.[id];
    if (explicitPath !== undefined) {
      const validation = await validateSkillDirectory(explicitPath, id);
      if (!validation.valid || validation.skill === null) {
        throw new LibraryLifecycleError(
          'INVALID_SKILL_SOURCE',
          `The explicit source for ${id} is invalid.`,
          { errors: validation.errors },
        );
      }
      const expectedBaseDigest = request.expectedBaseDigests?.[id];
      return {
        id,
        skill: validation.skill,
        ...(expectedBaseDigest === undefined ? {} : { expectedBaseDigest }),
        projectionDigests: new Map(),
      };
    }

    const projectRoot = request.projectRoot;
    if (project === undefined || projectRoot === undefined) {
      throw new LibraryLifecycleError(
        'PROJECT_STATE_REQUIRED',
        `No explicit source or tracked project source was provided for ${id}.`,
      );
    }
    const desired = project.manifest.skills.find((skill) => skill.id === id);
    const resolvedSkill = project.lock.skills.find((skill) => skill.id === id);
    if (desired === undefined || resolvedSkill === undefined) {
      throw new LibraryLifecycleError(
        'PROJECT_SKILL_NOT_TRACKED',
        `Skill ${id} is not tracked by the selected project.`,
      );
    }

    const candidates = await Promise.all(
      desired.projections.map(async (projection) => {
        const sourcePath = resolve(projectRoot, ...projection.destination.split('/'));
        const validation = await validateSkillDirectory(sourcePath, id);
        if (!validation.valid || validation.skill === null) {
          throw new LibraryLifecycleError(
            'INVALID_SKILL_SOURCE',
            `The managed ${projection.target} source for ${id} is invalid.`,
            { errors: validation.errors },
          );
        }
        return { projection, skill: validation.skill };
      }),
    );
    const projectionDigests = new Map(
      candidates.map((candidate) => [candidate.projection.target, candidate.skill.digest]),
    );
    const distinctDigests = new Set(candidates.map((candidate) => candidate.skill.digest));
    let selected: (typeof candidates)[number] | undefined;
    if (request.fromTarget !== undefined) {
      selected = candidates.find((candidate) => candidate.projection.target === request.fromTarget);
      if (selected === undefined) {
        throw new LibraryLifecycleError(
          'TARGET_SOURCE_NOT_FOUND',
          `Target ${request.fromTarget} is not a managed source for ${id}.`,
        );
      }
    } else if (distinctDigests.size > 1) {
      throw new LibraryLifecycleError(
        'DIVERGENT_TARGETS',
        `Managed target copies for ${id} differ; select one explicitly with fromTarget.`,
        { targets: candidates.map((candidate) => candidate.projection.target) },
      );
    } else {
      selected = candidates[0];
    }
    if (selected === undefined) {
      throw new LibraryLifecycleError(
        'INVALID_SKILL_SOURCE',
        `No managed target source exists for ${id}.`,
      );
    }
    return {
      id,
      skill: selected.skill,
      expectedBaseDigest: resolvedSkill.baseDigest,
      projectionDigests,
    };
  }

  private async updatePublishedProjectState(
    projectRoot: string,
    lock: ProjectLock,
    sources: readonly PublicationSource[],
    revision: string,
  ): Promise<void> {
    const byId = new Map(sources.map((source) => [source.id, source]));
    const next: ProjectLock = {
      ...lock,
      library: { ...lock.library, revision },
      skills: lock.skills.map((skill) => {
        const source = byId.get(parseQualifiedSkillId(skill.id));
        if (source === undefined) return skill;
        return {
          ...skill,
          baseDigest: source.skill.digest,
          canonicalDigest: source.skill.digest,
          projections: skill.projections.map((projection) => ({
            ...projection,
            digest: source.projectionDigests.get(projection.target) ?? projection.digest,
          })),
        };
      }),
    };
    await this.projectState.writeLock(projectRoot, next);
  }

  private previewPublication(
    sources: readonly PublicationSource[],
    library: LibraryValidationResult,
  ): LibraryPublishResult['skills'] {
    return sources.map((source) => {
      const canonical = library.skills.find((skill) => skill.id === source.id);
      if (canonical === undefined) {
        throw new LibraryLifecycleError(
          'SKILL_NOT_FOUND',
          `The canonical skill ${source.id} does not exist.`,
        );
      }
      if (
        source.expectedBaseDigest !== undefined &&
        source.expectedBaseDigest !== canonical.digest
      ) {
        throw new LibraryLifecycleError(
          'REMOTE_BASE_DIVERGED',
          `The canonical skill ${source.id} changed since the recorded project base.`,
          {
            id: source.id,
            expectedDigest: source.expectedBaseDigest,
            fetchedDigest: canonical.digest,
          },
        );
      }
      const canonicalFiles = new Map(canonical.files.map((file) => [file.relativePath, file]));
      const sourceFiles = new Map(source.skill.files.map((file) => [file.relativePath, file]));
      const added = [...sourceFiles.keys()]
        .filter((path) => !canonicalFiles.has(path))
        .sort(comparePortableStrings);
      const removed = [...canonicalFiles.keys()]
        .filter((path) => !sourceFiles.has(path))
        .sort(comparePortableStrings);
      const modified = [...sourceFiles.entries()]
        .filter(([path, file]) => {
          const previous = canonicalFiles.get(path);
          return previous !== undefined && previous.sha256 !== file.sha256;
        })
        .map(([path]) => path)
        .sort(comparePortableStrings);
      return {
        id: source.id,
        digest: source.skill.digest,
        previousDigest: canonical.digest,
        changed: canonical.digest !== source.skill.digest,
        diff: { added, modified, removed },
      };
    });
  }
}
