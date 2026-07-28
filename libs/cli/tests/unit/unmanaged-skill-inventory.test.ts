import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inspectProjectUnmanagedSkills } from '../../src/application/unmanaged-skill-inventory.js';
import { sha256TreeDigest } from '../../src/domain/digest.js';
import { writeProjectLock, writeProjectManifest } from '../../src/infrastructure/project-state.js';
import { TargetRegistry } from '../../src/targets/index.js';
import { withTempDirectory } from '../helpers/temp.js';

function registry(): TargetRegistry {
  return new TargetRegistry([
    {
      name: 'codex',
      detect: () => Promise.resolve(true),
      relativeDestination: (leaf) => join('.codex', 'skills', leaf),
    },
  ]);
}

async function createSkill(root: string, name: string): Promise<string> {
  const directory = join(root, '.codex', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n`,
  );
  return directory;
}

describe('unmanaged skill inventory', () => {
  it('reports valid target-root skills as unmanaged and ignores unrelated directories', async () => {
    await withTempDirectory('skill-sync-inventory-', async (root) => {
      await createSkill(root, 'review-ui');
      const unrelated = join(root, 'tools', 'unrelated');
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(unrelated, 'SKILL.md'), 'not a managed target skill');

      const inventory = await inspectProjectUnmanagedSkills({
        projectRoot: root,
        registry: registry(),
      });

      expect(inventory.stateIsReliable).toBe(true);
      expect(inventory.entries).toEqual([
        expect.objectContaining({
          adoptable: true,
          name: 'review-ui',
          status: 'unmanaged',
          target: 'codex',
        }),
      ]);
    });
  });

  it('keeps valid skills unclassified when project state is corrupt', async () => {
    await withTempDirectory('skill-sync-inventory-', async (root) => {
      await createSkill(root, 'review-ui');
      await writeFile(join(root, 'skill-sync.json'), '{not valid json');

      const inventory = await inspectProjectUnmanagedSkills({
        projectRoot: root,
        registry: registry(),
      });

      expect(inventory.stateIsReliable).toBe(false);
      expect(inventory.entries).toEqual([
        expect.objectContaining({ adoptable: false, status: 'unknown' }),
      ]);
      expect(inventory.issues).toEqual([
        expect.objectContaining({ code: 'INVALID_PROJECT_STATE' }),
      ]);
    });
  });

  it('reports invalid target-root candidates without treating them as managed', async () => {
    await withTempDirectory('skill-sync-inventory-', async (root) => {
      await mkdir(join(root, '.codex', 'skills', 'incomplete'), { recursive: true });

      const inventory = await inspectProjectUnmanagedSkills({
        projectRoot: root,
        registry: registry(),
      });

      expect(inventory.entries).toEqual([
        expect.objectContaining({
          adoptable: false,
          name: 'incomplete',
          status: 'invalid',
          target: 'codex',
        }),
      ]);
    });
  });

  it('recognizes projections represented by a valid manifest and lock', async () => {
    await withTempDirectory('skill-sync-inventory-', async (root) => {
      const directory = await createSkill(root, 'review-ui');
      const digest = await sha256TreeDigest(directory, { rejectNestedSkillRoots: true });
      const id = 'a'.repeat(40);
      await writeProjectManifest(root, {
        gitignore: 'unmanaged',
        library: { identity: 'github.com/acme/skills' },
        schemaVersion: 1,
        skills: [
          {
            id: 'review-ui',
            projections: [{ destination: '.codex/skills/review-ui', target: 'codex' }],
          },
        ],
      });
      await writeProjectLock(root, {
        library: { identity: 'github.com/acme/skills', revision: id },
        schemaVersion: 1,
        skills: [
          {
            baseDigest: digest,
            canonicalDigest: digest,
            id: 'review-ui',
            projections: [{ destination: '.codex/skills/review-ui', digest, target: 'codex' }],
          },
        ],
      });

      const inventory = await inspectProjectUnmanagedSkills({
        projectRoot: root,
        registry: registry(),
      });

      expect(inventory.entries).toEqual([
        expect.objectContaining({ adoptable: false, status: 'managed' }),
      ]);
    });
  });
});
