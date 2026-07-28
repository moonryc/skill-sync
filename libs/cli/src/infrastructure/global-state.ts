import { readFile } from 'node:fs/promises';

import {
  PROJECT_LOCK_SCHEMA_VERSION,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  canonicalizeProjectLock,
  canonicalizeProjectManifest,
  type ProjectLock,
  type ProjectManifest,
} from '../domain/project-state.js';
import { parseProjectLock, parseProjectManifest } from './project-state.js';
import type { ApplicationPaths } from './config.js';
import { writeJsonAtomic } from './stable-json.js';

/** Global state is deliberately separate by location while retaining the proven projection shape. */
export const GLOBAL_MANIFEST_SCHEMA_VERSION = PROJECT_MANIFEST_SCHEMA_VERSION;
export const GLOBAL_LOCK_SCHEMA_VERSION = PROJECT_LOCK_SCHEMA_VERSION;
export const GLOBAL_MANIFEST_FILENAME = 'skill-sync.json' as const;
export const GLOBAL_LOCK_FILENAME = 'skill-sync.lock.json' as const;

export type GlobalManifest = ProjectManifest;
export type GlobalLock = ProjectLock;

function requireGlobalPaths(paths: ApplicationPaths): {
  readonly manifest: string;
  readonly lock: string;
} {
  if (paths.globalManifestFile === undefined || paths.globalLockFile === undefined) {
    throw new Error('Global skill state paths are unavailable.');
  }
  return { manifest: paths.globalManifestFile, lock: paths.globalLockFile };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readGlobalManifest(
  paths: ApplicationPaths,
): Promise<GlobalManifest | undefined> {
  const value = await readJson(requireGlobalPaths(paths).manifest);
  return value === undefined ? undefined : canonicalizeProjectManifest(parseProjectManifest(value));
}

export async function readGlobalLock(paths: ApplicationPaths): Promise<GlobalLock | undefined> {
  const value = await readJson(requireGlobalPaths(paths).lock);
  return value === undefined ? undefined : canonicalizeProjectLock(parseProjectLock(value));
}

export async function writeGlobalManifest(
  paths: ApplicationPaths,
  input: unknown,
): Promise<GlobalManifest> {
  const manifest = canonicalizeProjectManifest(parseProjectManifest(input));
  await writeJsonAtomic(requireGlobalPaths(paths).manifest, manifest, { mode: 0o600 });
  return manifest;
}

export async function writeGlobalLock(
  paths: ApplicationPaths,
  input: unknown,
): Promise<GlobalLock> {
  const lock = canonicalizeProjectLock(parseProjectLock(input));
  await writeJsonAtomic(requireGlobalPaths(paths).lock, lock, { mode: 0o600 });
  return lock;
}
