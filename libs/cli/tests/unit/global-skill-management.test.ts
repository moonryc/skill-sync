import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  adoptGlobalSkill,
  inspectGlobalStatus,
  installGlobalSkills,
  syncGlobalSkills,
  uninstallGlobalSkills,
} from '../../src/application/global-skill-management.js';
import { globalMutationStorage } from '../../src/application/managed-scope.js';
import { inspectGlobalUnmanagedSkills } from '../../src/application/unmanaged-skill-inventory.js';
import { sha256TreeDigest } from '../../src/domain/digest.js';
import type { ApplicationPaths } from '../../src/infrastructure/config.js';
import { readGlobalLock, readGlobalManifest } from '../../src/infrastructure/global-state.js';
import { TargetRegistry } from '../../src/targets/index.js';
import { createFixtureLibrary } from '../helpers/fixtures.js';
import { withTempDirectory } from '../helpers/temp.js';

function paths(root: string): ApplicationPaths {
  const stateDirectory = join(root, 'state');
  return {
    backupsDirectory: join(stateDirectory, 'backups'),
    cacheDirectory: join(root, 'cache'),
    configDirectory: join(root, 'config'),
    configFile: join(root, 'config', 'config.json'),
    globalLockFile: join(stateDirectory, 'global', 'skill-sync.lock.json'),
    globalManifestFile: join(stateDirectory, 'global', 'skill-sync.json'),
    globalStateDirectory: join(stateDirectory, 'global'),
    journalsDirectory: join(stateDirectory, 'journals'),
    locksDirectory: join(stateDirectory, 'locks'),
    stateDirectory,
  };
}

function registry(home: string): TargetRegistry {
  return new TargetRegistry([
    {
      detect: () => Promise.resolve(false),
      globalDestination: (leaf) => join(home, '.codex', 'skills', leaf),
      globalRoot: () => join(home, '.codex'),
      name: 'codex',
      relativeDestination: (leaf) => join('.codex', 'skills', leaf),
    },
  ]);
}

describe('global skill management', () => {
  it('adopts an exact unmanaged global copy without rewriting it', async () => {
    await withTempDirectory('skill-sync-global-adopt-', async (root) => {
      const library = join(root, 'library');
      const home = join(root, 'home');
      const applicationPaths = paths(root);
      const targets = registry(home);
      await createFixtureLibrary(library);
      await writeFile(join(library, 'skills', 'examples', '.skill-sync-group.json'), '{}\n');
      const source = join(library, 'skills', 'examples', 'hello');
      const digest = await sha256TreeDigest(source, { rejectNestedSkillRoots: true });
      const destination = join(home, '.codex', 'skills', 'hello');
      await cp(source, destination, { recursive: true });
      const before = await stat(join(destination, 'SKILL.md'));

      const adopted = await adoptGlobalSkill({
        libraryIdentity: 'github.com/acme/skills',
        libraryRevision: 'a'.repeat(40),
        operationId: 'adopt-global-hello',
        paths: applicationPaths,
        registry: targets,
        skill: {
          compatibleAgents: ['codex'],
          digest,
          id: 'examples/hello',
          name: 'hello',
          rootPath: source,
        },
        storage: globalMutationStorage(applicationPaths),
        target: 'codex',
      });

      expect(adopted).toMatchObject({ applied: true, operation: 'adopt', scope: 'global' });
      expect((await stat(join(destination, 'SKILL.md'))).mtimeMs).toBe(before.mtimeMs);
      expect(await readGlobalManifest(applicationPaths)).toMatchObject({
        skills: [expect.objectContaining({ id: 'examples/hello' })],
      });
      expect(await readGlobalLock(applicationPaths)).toMatchObject({
        library: { revision: 'a'.repeat(40) },
      });
    });
  });

  it('leaves a divergent unmanaged global copy untracked', async () => {
    await withTempDirectory('skill-sync-global-adopt-refuse-', async (root) => {
      const library = join(root, 'library');
      const home = join(root, 'home');
      const applicationPaths = paths(root);
      const targets = registry(home);
      await createFixtureLibrary(library);
      await writeFile(join(library, 'skills', 'examples', '.skill-sync-group.json'), '{}\n');
      const source = join(library, 'skills', 'examples', 'hello');
      const digest = await sha256TreeDigest(source, { rejectNestedSkillRoots: true });
      const destination = join(home, '.codex', 'skills', 'hello');
      await mkdir(destination, { recursive: true });
      const contents = '---\nname: hello\ndescription: Different local skill\n---\n\n# Different\n';
      await writeFile(join(destination, 'SKILL.md'), contents);

      await expect(
        adoptGlobalSkill({
          libraryIdentity: 'github.com/acme/skills',
          libraryRevision: 'a'.repeat(40),
          paths: applicationPaths,
          registry: targets,
          skill: {
            compatibleAgents: ['codex'],
            digest,
            id: 'examples/hello',
            name: 'hello',
            rootPath: source,
          },
          storage: globalMutationStorage(applicationPaths),
          target: 'codex',
        }),
      ).rejects.toMatchObject({ code: 'ADOPTION_DIGEST_MISMATCH' });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe(contents);
      expect(await readGlobalManifest(applicationPaths)).toBeUndefined();
      expect(await readGlobalLock(applicationPaths)).toBeUndefined();
    });
  });

  it('installs, inventories, reconciles, and uninstalls global skills without project metadata', async () => {
    await withTempDirectory('skill-sync-global-', async (root) => {
      const library = join(root, 'library');
      const home = join(root, 'home');
      const applicationPaths = paths(root);
      const targets = registry(home);
      await createFixtureLibrary(library);
      await writeFile(join(library, 'skills', 'examples', '.skill-sync-group.json'), '{}\n');
      const source = join(library, 'skills', 'examples', 'hello');
      const digest = await sha256TreeDigest(source, { rejectNestedSkillRoots: true });

      const installed = await installGlobalSkills({
        libraryIdentity: 'github.com/acme/skills',
        libraryRevision: 'a'.repeat(40),
        paths: applicationPaths,
        registry: targets,
        skills: [{ digest, id: 'examples/hello', name: 'hello', rootPath: source }],
        storage: globalMutationStorage(applicationPaths),
        targets: ['codex'],
      });

      const destination = join(home, '.codex', 'skills', 'hello');
      expect(installed).toMatchObject({ applied: true, scope: 'global' });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toContain('Example skill');
      expect(await readGlobalManifest(applicationPaths)).toMatchObject({
        skills: [expect.objectContaining({ id: 'examples/hello' })],
      });
      expect(await readGlobalLock(applicationPaths)).toMatchObject({
        library: { revision: 'a'.repeat(40) },
      });
      expect(
        await readFile(join(root, 'skill-sync.json'), 'utf8').catch(() => undefined),
      ).toBeUndefined();

      const unmanaged = join(home, '.codex', 'skills', 'unmanaged');
      await mkdir(unmanaged, { recursive: true });
      await writeFile(
        join(unmanaged, 'SKILL.md'),
        '---\nname: unmanaged\ndescription: existing global skill\n---\n\n# Unmanaged\n',
      );
      const outsideTargetRoot = join(home, 'outside-target-root');
      await mkdir(outsideTargetRoot, { recursive: true });
      await writeFile(join(outsideTargetRoot, 'SKILL.md'), '# Never scanned\n');
      const globalManifest = applicationPaths.globalManifestFile;
      if (globalManifest === undefined) throw new Error('Fixture is missing global state paths.');
      const manifestBeforeInventory = await readFile(globalManifest, 'utf8');
      const inventory = await inspectGlobalUnmanagedSkills({
        paths: applicationPaths,
        registry: targets,
      });
      expect(inventory.entries).toEqual([
        expect.objectContaining({ name: 'hello', status: 'managed' }),
        expect.objectContaining({ name: 'unmanaged', status: 'unmanaged' }),
      ]);
      expect(inventory.entries.map((entry) => entry.path)).not.toContain(outsideTargetRoot);
      expect(await readFile(globalManifest, 'utf8')).toBe(manifestBeforeInventory);

      const revisionProvider = {
        resolve: () =>
          Promise.resolve({
            branch: 'main',
            freshness: 'fetched' as const,
            identity: 'github.com/acme/skills',
            libraryRoot: library,
            refreshedAt: '2026-01-01T00:00:00.000Z',
            revision: 'b'.repeat(40),
            stale: false,
            usableForMutation: true,
          }),
      };
      await writeFile(join(source, 'CHANGELOG.md'), 'new canonical bytes\n');
      const updatedDigest = await sha256TreeDigest(source, { rejectNestedSkillRoots: true });
      const before = await inspectGlobalStatus({
        library: revisionProvider,
        paths: applicationPaths,
        registry: targets,
      });
      expect(before.skills[0]).toMatchObject({ state: 'outdated' });
      const synced = await syncGlobalSkills({
        library: revisionProvider,
        paths: applicationPaths,
        registry: targets,
        storage: globalMutationStorage(applicationPaths),
      });
      expect(synced).toMatchObject({ applied: true, scope: 'global' });
      expect(await sha256TreeDigest(destination, { rejectNestedSkillRoots: true })).toBe(
        updatedDigest,
      );

      const removed = await uninstallGlobalSkills({
        paths: applicationPaths,
        registry: targets,
        skillIds: ['examples/hello'],
        storage: globalMutationStorage(applicationPaths),
      });
      expect(removed).toMatchObject({ applied: true, scope: 'global' });
      expect(await readGlobalManifest(applicationPaths)).toMatchObject({ skills: [] });
    });
  });

  it('refuses collisions and edited global copies before mutating state', async () => {
    await withTempDirectory('skill-sync-global-', async (root) => {
      const library = join(root, 'library');
      const home = join(root, 'home');
      const applicationPaths = paths(root);
      const targets = registry(home);
      await createFixtureLibrary(library);
      await writeFile(join(library, 'skills', 'examples', '.skill-sync-group.json'), '{}\n');
      const source = join(library, 'skills', 'examples', 'hello');
      const digest = await sha256TreeDigest(source, { rejectNestedSkillRoots: true });
      const collision = join(home, '.codex', 'skills', 'hello');
      await mkdir(collision, { recursive: true });
      await writeFile(join(collision, 'SKILL.md'), '# unmanaged');

      await expect(
        installGlobalSkills({
          libraryIdentity: 'github.com/acme/skills',
          libraryRevision: 'a'.repeat(40),
          paths: applicationPaths,
          registry: targets,
          skills: [{ digest, id: 'examples/hello', name: 'hello', rootPath: source }],
          storage: globalMutationStorage(applicationPaths),
          targets: ['codex'],
        }),
      ).rejects.toMatchObject({ code: 'UNMANAGED_COLLISION' });
    });
  });
});
