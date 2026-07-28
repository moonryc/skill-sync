import { lstat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

import { validateSkillDirectory } from '../domain/library.js';
import type { ProjectLock, ProjectManifest } from '../domain/project-state.js';
import {
  assertProjectStatePair,
  readProjectLock,
  readProjectManifest,
} from '../infrastructure/project-state.js';
import { readGlobalLock, readGlobalManifest } from '../infrastructure/global-state.js';
import type { ApplicationPaths } from '../infrastructure/config.js';
import { resolveContainedGlobalDestination, TargetRegistry } from '../targets/index.js';

export type UnmanagedInventoryStatus = 'invalid' | 'managed' | 'unmanaged' | 'unknown';

export interface UnmanagedSkillInventoryEntry {
  /** True only when selected-scope state is reliable and this exact target copy is untracked. */
  readonly adoptable: boolean;
  readonly issues: readonly string[];
  readonly name: string;
  readonly path: string;
  readonly status: UnmanagedInventoryStatus;
  readonly target: string;
}

export interface UnmanagedSkillInventoryIssue {
  readonly code: 'INACCESSIBLE_TARGET_ROOT' | 'INVALID_PROJECT_STATE' | 'INCOMPLETE_PROJECT_STATE';
  readonly message: string;
  readonly path?: string;
}

export interface UnmanagedSkillInventory {
  readonly entries: readonly UnmanagedSkillInventoryEntry[];
  readonly issues: readonly UnmanagedSkillInventoryIssue[];
  readonly stateIsReliable: boolean;
}

function projectionKey(target: string, path: string): string {
  return `${target}\0${path}`;
}

function managedProjectionKeys(
  projectRoot: string,
  manifest: ProjectManifest,
): ReadonlySet<string> {
  return new Set(
    manifest.skills.flatMap((skill) =>
      skill.projections.map((projection) =>
        projectionKey(projection.target, join(projectRoot, ...projection.destination.split('/'))),
      ),
    ),
  );
}

function assertCompletePair(manifest: ProjectManifest, lock: ProjectLock): void {
  assertProjectStatePair(manifest, lock);
  const locked = new Set(lock.skills.map((skill) => skill.id));
  if (
    manifest.skills.some((skill) => !locked.has(skill.id)) ||
    manifest.skills.length !== lock.skills.length
  ) {
    throw new Error('Every manifest skill must have exactly one lock entry.');
  }
}

async function readManagedState(projectRoot: string): Promise<{
  readonly issue?: UnmanagedSkillInventoryIssue;
  readonly keys: ReadonlySet<string>;
  readonly reliable: boolean;
}> {
  try {
    const [manifest, lock] = await Promise.all([
      readProjectManifest(projectRoot),
      readProjectLock(projectRoot),
    ]);
    if (manifest === undefined && lock === undefined) {
      return { keys: new Set(), reliable: true };
    }
    if (manifest === undefined || lock === undefined) {
      return {
        issue: {
          code: 'INCOMPLETE_PROJECT_STATE',
          message:
            'Both skill-sync.json and skill-sync.lock.json must be present to classify skills.',
        },
        keys: new Set(),
        reliable: false,
      };
    }
    assertCompletePair(manifest, lock);
    return { keys: managedProjectionKeys(projectRoot, manifest), reliable: true };
  } catch (error) {
    return {
      issue: {
        code: 'INVALID_PROJECT_STATE',
        message: error instanceof Error ? error.message : 'Unable to read managed project state.',
      },
      keys: new Set(),
      reliable: false,
    };
  }
}

/**
 * Inspect only direct skill directories in known target roots. Discovered content is validated as
 * data and never executed; unreliable managed state deliberately leaves entries unclassified.
 */
export async function inspectProjectUnmanagedSkills(options: {
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
}): Promise<UnmanagedSkillInventory> {
  const registry = options.registry ?? new TargetRegistry();
  const state = await readManagedState(options.projectRoot);
  const entries: UnmanagedSkillInventoryEntry[] = [];
  const issues: UnmanagedSkillInventoryIssue[] = state.issue === undefined ? [] : [state.issue];

  for (const adapter of registry.list()) {
    const root = join(
      options.projectRoot,
      adapter.relativeDestination('__skill-sync-inventory__'),
      '..',
    );
    let candidates: readonly Dirent[];
    try {
      candidates = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      issues.push({
        code: 'INACCESSIBLE_TARGET_ROOT',
        message: error instanceof Error ? error.message : `Unable to inspect ${root}.`,
        path: root,
      });
      continue;
    }

    for (const candidate of candidates) {
      if (!candidate.isDirectory()) continue;
      const path = join(root, candidate.name);
      try {
        const information = await lstat(path);
        if (!information.isDirectory() || information.isSymbolicLink()) continue;
      } catch (error) {
        entries.push({
          adoptable: false,
          issues: [error instanceof Error ? error.message : 'Unable to inspect skill directory.'],
          name: candidate.name,
          path,
          status: 'invalid',
          target: adapter.name,
        });
        continue;
      }

      const validation = await validateSkillDirectory(path);
      if (!validation.valid) {
        entries.push({
          adoptable: false,
          issues: validation.errors.map((issue) => `${issue.path}: ${issue.message}`),
          name: candidate.name,
          path,
          status: 'invalid',
          target: adapter.name,
        });
        continue;
      }

      const key = projectionKey(adapter.name, path);
      const status = state.reliable ? (state.keys.has(key) ? 'managed' : 'unmanaged') : 'unknown';
      entries.push({
        adoptable: status === 'unmanaged',
        issues: [],
        name: candidate.name,
        path,
        status,
        target: adapter.name,
      });
    }
  }

  entries.sort(
    (left, right) => left.target.localeCompare(right.target) || left.path.localeCompare(right.path),
  );
  return { entries, issues, stateIsReliable: state.reliable };
}

async function globalManagedProjectionKeys(
  paths: ApplicationPaths,
  registry: TargetRegistry,
  manifest: ProjectManifest,
): Promise<ReadonlySet<string>> {
  const keys = new Set<string>();
  for (const skill of manifest.skills) {
    for (const projection of skill.projections) {
      const adapter = registry.get(projection.target);
      if (adapter?.globalDestination === undefined || adapter.globalRoot === undefined) {
        throw new Error(`Global target ${projection.target} is unavailable.`);
      }
      const path = await resolveContainedGlobalDestination(
        adapter.globalRoot(),
        adapter.globalDestination(projection.destination),
      );
      keys.add(projectionKey(projection.target, path));
    }
  }
  return keys;
}

async function readGlobalManagedState(
  paths: ApplicationPaths,
  registry: TargetRegistry,
): Promise<{
  readonly issue?: UnmanagedSkillInventoryIssue;
  readonly keys: ReadonlySet<string>;
  readonly reliable: boolean;
}> {
  try {
    const [manifest, lock] = await Promise.all([readGlobalManifest(paths), readGlobalLock(paths)]);
    if (manifest === undefined && lock === undefined) return { keys: new Set(), reliable: true };
    if (manifest === undefined || lock === undefined) {
      return {
        issue: {
          code: 'INCOMPLETE_PROJECT_STATE',
          message: 'Both global manifest and lock files must be present to classify skills.',
        },
        keys: new Set(),
        reliable: false,
      };
    }
    assertCompletePair(manifest, lock);
    return { keys: await globalManagedProjectionKeys(paths, registry, manifest), reliable: true };
  } catch (error) {
    return {
      issue: {
        code: 'INVALID_PROJECT_STATE',
        message: error instanceof Error ? error.message : 'Unable to read global managed state.',
      },
      keys: new Set(),
      reliable: false,
    };
  }
}

/** Inspect direct user-level target directories without executing their discovered content. */
export async function inspectGlobalUnmanagedSkills(options: {
  readonly paths: ApplicationPaths;
  readonly registry?: TargetRegistry;
}): Promise<UnmanagedSkillInventory> {
  const registry = options.registry ?? new TargetRegistry();
  const state = await readGlobalManagedState(options.paths, registry);
  const entries: UnmanagedSkillInventoryEntry[] = [];
  const issues: UnmanagedSkillInventoryIssue[] = state.issue === undefined ? [] : [state.issue];

  for (const adapter of registry.list()) {
    if (adapter.globalDestination === undefined || adapter.globalRoot === undefined) {
      issues.push({
        code: 'INACCESSIBLE_TARGET_ROOT',
        message: `Target ${adapter.name} has no supported global destination.`,
      });
      continue;
    }
    let root: string;
    try {
      root = join(
        await resolveContainedGlobalDestination(
          adapter.globalRoot(),
          adapter.globalDestination('__skill-sync-inventory__'),
        ),
        '..',
      );
    } catch (error) {
      issues.push({
        code: 'INACCESSIBLE_TARGET_ROOT',
        message: error instanceof Error ? error.message : 'Unable to resolve global target root.',
      });
      continue;
    }
    let candidates: readonly Dirent[];
    try {
      candidates = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      issues.push({
        code: 'INACCESSIBLE_TARGET_ROOT',
        message: error instanceof Error ? error.message : `Unable to inspect ${root}.`,
        path: root,
      });
      continue;
    }
    for (const candidate of candidates) {
      if (!candidate.isDirectory()) continue;
      const path = join(root, candidate.name);
      try {
        const information = await lstat(path);
        if (!information.isDirectory() || information.isSymbolicLink()) continue;
      } catch (error) {
        entries.push({
          adoptable: false,
          issues: [error instanceof Error ? error.message : 'Unable to inspect skill directory.'],
          name: candidate.name,
          path,
          status: 'invalid',
          target: adapter.name,
        });
        continue;
      }
      const validation = await validateSkillDirectory(path);
      if (!validation.valid) {
        entries.push({
          adoptable: false,
          issues: validation.errors.map((issue) => `${issue.path}: ${issue.message}`),
          name: candidate.name,
          path,
          status: 'invalid',
          target: adapter.name,
        });
        continue;
      }
      const status = state.reliable
        ? state.keys.has(projectionKey(adapter.name, path))
          ? 'managed'
          : 'unmanaged'
        : 'unknown';
      entries.push({
        adoptable: status === 'unmanaged',
        issues: [],
        name: candidate.name,
        path,
        status,
        target: adapter.name,
      });
    }
  }
  entries.sort(
    (left, right) => left.target.localeCompare(right.target) || left.path.localeCompare(right.path),
  );
  return { entries, issues, stateIsReliable: state.reliable };
}
