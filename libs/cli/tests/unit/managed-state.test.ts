import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256TreeDigest } from '../../src/domain/digest.js';
import {
  projectLockSchema,
  projectManifestSchema,
  type ProjectLock,
  type ProjectManifest,
} from '../../src/domain/project-state.js';
import { loadManagedStatePair } from '../../src/infrastructure/managed-state.js';
import { withTempDirectory } from '../helpers/temp.js';

const identity = 'github.com/acme/skills';

function leafName(id: string): string {
  const leaf = id.split('/').at(-1);
  if (leaf === undefined) throw new Error(`Invalid test skill ID: ${id}`);
  return leaf;
}

function manifest(ids: readonly string[] = ['group/example']): ProjectManifest {
  return projectManifestSchema.parse({
    gitignore: 'unmanaged',
    library: { identity },
    schemaVersion: 1,
    skills: ids.map((id) => ({
      id,
      projections: [{ destination: `.codex/skills/${leafName(id)}`, target: 'codex' }],
    })),
  });
}

function lock(digest: string, ids: readonly string[] = ['group/example']): ProjectLock {
  return projectLockSchema.parse({
    library: { identity, revision: '1'.repeat(40) },
    schemaVersion: 1,
    skills: ids.map((id) => ({
      baseDigest: digest,
      canonicalDigest: digest,
      id,
      projections: [
        {
          destination: `.codex/skills/${leafName(id)}`,
          digest,
          target: 'codex',
        },
      ],
    })),
  });
}

describe('managed state-pair loader', () => {
  it('validates pair metadata and compares managed content with recorded digests', async () =>
    withTempDirectory('skill-sync-managed-state-', async (root) => {
      const destination = join(root, '.codex', 'skills', 'example');
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'SKILL.md'), 'managed');
      const recordedDigest = await sha256TreeDigest(destination);

      const loaded = await loadManagedStatePair({
        readLock: () => Promise.resolve(lock(recordedDigest)),
        readManifest: () => Promise.resolve(manifest()),
        resolveDestination: () => Promise.resolve(destination),
        scope: 'project',
      });
      expect(loaded.content).toEqual([
        expect.objectContaining({
          digest: recordedDigest,
          exists: true,
          matchesRecordedDigest: true,
        }),
      ]);

      await writeFile(join(destination, 'SKILL.md'), 'locally changed');
      const changed = await loadManagedStatePair({
        readLock: () => Promise.resolve(lock(recordedDigest)),
        readManifest: () => Promise.resolve(manifest()),
        resolveDestination: () => Promise.resolve(destination),
        scope: 'project',
      });
      expect(changed.content[0]).toMatchObject({
        exists: true,
        matchesRecordedDigest: false,
      });
    }));

  it('rejects missing halves and mismatched IDs with scope-specific errors', async () => {
    const digest = 'a'.repeat(64);
    await expect(
      loadManagedStatePair({
        readLock: () => Promise.resolve(undefined),
        readManifest: () => Promise.resolve(manifest()),
        resolveDestination: () => Promise.resolve('/unused'),
        scope: 'global',
      }),
    ).rejects.toMatchObject({ code: 'INCOMPLETE_GLOBAL_STATE' });

    await expect(
      loadManagedStatePair({
        readLock: () => Promise.resolve(lock(digest, ['group/other'])),
        readManifest: () => Promise.resolve(manifest()),
        resolveDestination: () => Promise.resolve('/unused'),
        scope: 'project',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROJECT_STATE' });
  });

  it('rejects unsafe managed content before returning state for planning', async () =>
    withTempDirectory('skill-sync-managed-state-unsafe-', async (root) => {
      const external = join(root, 'external');
      const destination = join(root, '.codex', 'skills', 'example');
      await mkdir(external);
      await mkdir(join(root, '.codex', 'skills'), { recursive: true });
      await writeFile(join(external, 'SKILL.md'), 'external');
      await symlink(external, destination);

      await expect(
        loadManagedStatePair({
          readLock: () => Promise.resolve(lock('a'.repeat(64))),
          readManifest: () => Promise.resolve(manifest()),
          resolveDestination: () => Promise.resolve(destination),
          scope: 'project',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PROJECT_STATE' });
    }));
});
