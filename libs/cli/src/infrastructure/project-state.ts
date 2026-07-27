import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  PROJECT_LOCK_FILENAME,
  PROJECT_LOCK_SCHEMA_VERSION,
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  canonicalizeProjectLock,
  canonicalizeProjectManifest,
  portableRelativePathSchema,
  projectLockSchema,
  projectManifestSchema,
  type ProjectLock,
  type ProjectManifest,
} from '../domain/project-state.js';
import { writeJsonAtomic } from './stable-json.js';

const execFileAsync = promisify(execFile);

export type ProjectStateFileKind = 'manifest' | 'lock';

export class ProjectStateVersionError extends Error {
  public readonly actualVersion: number | undefined;
  public readonly expectedVersion: number;
  public readonly fileKind: ProjectStateFileKind;

  public constructor(options: {
    readonly actualVersion: number | undefined;
    readonly expectedVersion: number;
    readonly fileKind: ProjectStateFileKind;
  }) {
    const detail =
      options.actualVersion === undefined
        ? 'does not declare an integer schemaVersion'
        : options.actualVersion < options.expectedVersion
          ? `uses schema version ${String(options.actualVersion)} and requires migration to ${String(options.expectedVersion)}`
          : `uses unsupported future schema version ${String(options.actualVersion)} (this CLI supports ${String(options.expectedVersion)})`;
    super(`The project ${options.fileKind} ${detail}.`);
    this.name = 'ProjectStateVersionError';
    this.actualVersion = options.actualVersion;
    this.expectedVersion = options.expectedVersion;
    this.fileKind = options.fileKind;
  }
}

function schemaVersionOf(input: unknown): number | undefined {
  if (typeof input !== 'object' || input === null || !('schemaVersion' in input)) {
    return undefined;
  }
  const value = (input as { readonly schemaVersion?: unknown }).schemaVersion;
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function assertProjectStateVersion(input: unknown, fileKind: ProjectStateFileKind): void {
  const expectedVersion =
    fileKind === 'manifest' ? PROJECT_MANIFEST_SCHEMA_VERSION : PROJECT_LOCK_SCHEMA_VERSION;
  const actualVersion = schemaVersionOf(input);
  if (actualVersion !== expectedVersion) {
    throw new ProjectStateVersionError({ actualVersion, expectedVersion, fileKind });
  }
}

/**
 * Migration entry points are deliberately explicit. The initial schema has no legacy shape to
 * guess at, so older/future versions are reported instead of being silently rewritten.
 */
export function migrateProjectManifest(input: unknown): ProjectManifest {
  assertProjectStateVersion(input, 'manifest');
  return canonicalizeProjectManifest(projectManifestSchema.parse(input));
}

export function migrateProjectLock(input: unknown): ProjectLock {
  assertProjectStateVersion(input, 'lock');
  return canonicalizeProjectLock(projectLockSchema.parse(input));
}

export const parseProjectManifest = migrateProjectManifest;
export const parseProjectLock = migrateProjectLock;

async function readJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(contents) as unknown;
}

export async function readProjectManifest(
  projectRoot: string,
): Promise<ProjectManifest | undefined> {
  const value = await readJson(join(projectRoot, PROJECT_MANIFEST_FILENAME));
  return value === undefined ? undefined : parseProjectManifest(value);
}

export async function readProjectLock(projectRoot: string): Promise<ProjectLock | undefined> {
  const value = await readJson(join(projectRoot, PROJECT_LOCK_FILENAME));
  return value === undefined ? undefined : parseProjectLock(value);
}

export async function writeProjectManifest(
  projectRoot: string,
  input: unknown,
): Promise<ProjectManifest> {
  const manifest = parseProjectManifest(input);
  await writeJsonAtomic(join(projectRoot, PROJECT_MANIFEST_FILENAME), manifest, { mode: 0o644 });
  return manifest;
}

export async function writeProjectLock(projectRoot: string, input: unknown): Promise<ProjectLock> {
  const lock = parseProjectLock(input);
  await writeJsonAtomic(join(projectRoot, PROJECT_LOCK_FILENAME), lock, { mode: 0o644 });
  return lock;
}

export interface ProjectRootResolutionOptions {
  readonly cwd?: string;
  readonly explicitPath?: string;
  readonly gitRootResolver?: (cwd: string) => Promise<string | undefined>;
}

async function defaultGitRootResolver(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: '',
      },
      windowsHide: true,
    });
    const result = stdout.trim();
    return result === '' ? undefined : result;
  } catch {
    return undefined;
  }
}

async function assertDirectory(path: string): Promise<void> {
  const information = await stat(path);
  if (!information.isDirectory()) {
    throw new Error(`Project root is not a directory: ${path}`);
  }
}

/** Resolve explicit path, then enclosing Git root, then current directory. */
export async function resolveProjectRoot(
  options: ProjectRootResolutionOptions = {},
): Promise<string> {
  const cwd = await realpath(options.cwd ?? process.cwd());
  if (options.explicitPath !== undefined) {
    const candidate = isAbsolute(options.explicitPath)
      ? options.explicitPath
      : resolve(cwd, options.explicitPath);
    const explicitRoot = await realpath(candidate);
    await assertDirectory(explicitRoot);
    return explicitRoot;
  }

  const gitRoot = await (options.gitRootResolver ?? defaultGitRootResolver)(cwd);
  if (gitRoot !== undefined) {
    const resolvedGitRoot = await realpath(isAbsolute(gitRoot) ? gitRoot : resolve(cwd, gitRoot));
    await assertDirectory(resolvedGitRoot);
    return resolvedGitRoot;
  }

  await assertDirectory(cwd);
  return cwd;
}

export function isPathContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  );
}

/**
 * Resolve a portable destination while following every existing symlink. A nonexistent suffix is
 * accepted only after its nearest existing ancestor is proven to remain inside the real root.
 */
export async function resolveContainedProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  const normalizedRelativePath = portableRelativePathSchema.parse(relativePath);
  const realRoot = await realpath(projectRoot);
  let cursor = realRoot;
  const segments = normalizedRelativePath.split('/');

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new Error('Unexpected empty destination segment.');
    const next = join(cursor, segment);
    try {
      cursor = await realpath(next);
      if (!isPathContained(realRoot, cursor)) {
        throw new Error(`Managed destination escapes the selected project root: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const remainder = segments.slice(index).join('/');
      const unresolved = resolve(cursor, remainder);
      if (!isPathContained(realRoot, unresolved)) {
        throw new Error(`Managed destination escapes the selected project root: ${relativePath}`, {
          cause: error,
        });
      }
      return unresolved;
    }
  }

  return cursor;
}

export function assertProjectStatePair(manifest: ProjectManifest, lock: ProjectLock): void {
  if (manifest.library.identity !== lock.library.identity) {
    throw new Error('Project manifest and lock reference different library identities.');
  }

  const manifestById = new Map(manifest.skills.map((skill) => [skill.id, skill]));
  for (const lockedSkill of lock.skills) {
    const desiredSkill = manifestById.get(lockedSkill.id);
    if (desiredSkill === undefined) {
      throw new Error(`Project lock contains unrequested skill ${lockedSkill.id}.`);
    }
    const desired = desiredSkill.projections.map(
      (projection) => `${projection.target}:${projection.destination}`,
    );
    const resolved = lockedSkill.projections.map(
      (projection) => `${projection.target}:${projection.destination}`,
    );
    if (desired.join('\n') !== resolved.join('\n')) {
      throw new Error(`Project manifest and lock projections differ for ${lockedSkill.id}.`);
    }
  }
}

/** Return the containing directory for diagnostics without normalizing away the filename. */
export function projectStateDirectory(path: string): string {
  return dirname(path);
}
