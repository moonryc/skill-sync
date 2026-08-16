import { lstat } from 'node:fs/promises';

import { inspectRegularFileTree } from '../domain/digest.js';
import type { ProjectLock, ProjectManifest } from '../domain/project-state.js';
import { EXIT_CODES, SkillSyncError } from '../domain/result.js';
import { assertProjectStatePair } from './project-state.js';

export type ManagedStateScope = 'global' | 'project';

export interface ManagedContentObservation {
  readonly destination: string;
  readonly digest?: string;
  readonly exists: boolean;
  readonly id: string;
  readonly matchesRecordedDigest: boolean;
  readonly path: string;
  readonly recordedDigest: string;
  readonly target: string;
}

export interface ManagedStatePair {
  readonly content: readonly ManagedContentObservation[];
  readonly lock: ProjectLock | undefined;
  readonly manifest: ProjectManifest | undefined;
}

function stateError(
  scope: ManagedStateScope,
  kind: 'incomplete' | 'invalid' | 'required',
  message: string,
): SkillSyncError {
  const prefix = scope.toUpperCase();
  const code =
    kind === 'incomplete'
      ? `INCOMPLETE_${prefix}_STATE`
      : kind === 'required'
        ? `${prefix}_STATE_REQUIRED`
        : `INVALID_${prefix}_STATE`;
  return new SkillSyncError(code, message, EXIT_CODES.validation);
}

/**
 * Loads and validates the manifest/lock pair before a mutation plan can use it.
 * Recorded digests are compared with regular managed content; missing content is
 * represented explicitly so reconciliation can plan a restore.
 */
export async function loadManagedStatePair(options: {
  readonly expectedLibraryIdentity?: string;
  readonly readLock: () => Promise<ProjectLock | undefined>;
  readonly readManifest: () => Promise<ProjectManifest | undefined>;
  readonly required?: boolean;
  readonly resolveDestination: (projection: {
    readonly destination: string;
    readonly target: string;
  }) => Promise<string>;
  readonly scope: ManagedStateScope;
}): Promise<ManagedStatePair> {
  const [manifest, lock] = await Promise.all([options.readManifest(), options.readLock()]);
  if ((manifest === undefined) !== (lock === undefined)) {
    throw stateError(
      options.scope,
      'incomplete',
      `The ${options.scope} manifest and lock must be present together.`,
    );
  }
  if (manifest === undefined || lock === undefined) {
    if (options.required === true) {
      throw stateError(
        options.scope,
        'required',
        `Both the ${options.scope} manifest and lock are required.`,
      );
    }
    return { content: [], lock, manifest };
  }

  try {
    assertProjectStatePair(manifest, lock);
  } catch (error) {
    throw stateError(
      options.scope,
      'invalid',
      error instanceof Error ? error.message : `The ${options.scope} state pair is invalid.`,
    );
  }
  if (
    options.expectedLibraryIdentity !== undefined &&
    manifest.library.identity !== options.expectedLibraryIdentity
  ) {
    throw stateError(
      options.scope,
      'invalid',
      `Managed state references ${manifest.library.identity}, not ${options.expectedLibraryIdentity}.`,
    );
  }

  const content: ManagedContentObservation[] = [];
  for (const skill of lock.skills) {
    for (const projection of skill.projections) {
      const path = await options.resolveDestination(projection);
      try {
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          content.push({
            destination: projection.destination,
            exists: false,
            id: skill.id,
            matchesRecordedDigest: false,
            path,
            recordedDigest: projection.digest,
            target: projection.target,
          });
          continue;
        }
        throw error;
      }
      try {
        const tree = await inspectRegularFileTree(path, { rejectNestedSkillRoots: true });
        content.push({
          destination: projection.destination,
          digest: tree.digest,
          exists: true,
          id: skill.id,
          matchesRecordedDigest: tree.digest === projection.digest,
          path,
          recordedDigest: projection.digest,
          target: projection.target,
        });
      } catch (error) {
        throw stateError(
          options.scope,
          'invalid',
          `Managed content for ${skill.id} at ${projection.destination} is unsafe: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return { content, lock, manifest };
}
