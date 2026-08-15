import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  adoptGlobalSkill,
  formatGlobalDiffHuman,
  formatGlobalReconciliationHuman,
  formatGlobalStatusHuman,
  inspectGlobalDiff,
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
      const statusHuman = formatGlobalStatusHuman(before);
      expect(statusHuman).toContain('Scope: global');
      expect(statusHuman).toContain('Library: github.com/acme/skills @');
      expect(statusHuman).toContain('(fetched)');
      expect(statusHuman).toContain('Managed skills: 1 (outdated 1)');
      expect(statusHuman).toContain('Next: Run skill-sync sync --global');
      const firstStatus = before.skills[0];
      if (firstStatus === undefined) throw new Error('Expected a global status entry.');
      const orphanedStatus = formatGlobalStatusHuman({
        ...before,
        skills: [{ ...firstStatus, state: 'orphaned' }],
      });
      expect(orphanedStatus).toContain(
        'Preview removal with skill-sync uninstall examples/hello --global --dry-run',
      );
      expect(orphanedStatus).not.toContain('before deciding whether to sync');

      const diff = await inspectGlobalDiff({
        library: revisionProvider,
        paths: applicationPaths,
        registry: targets,
        selector: 'examples/hello',
      });
      const diffHuman = formatGlobalDiffHuman(diff);
      const globalStateDirectory = applicationPaths.globalStateDirectory;
      if (globalStateDirectory === undefined) throw new Error('Expected global state paths.');
      expect(diffHuman).toContain(`Scope: global (${globalStateDirectory})`);
      expect(diffHuman).toContain('Skill: examples/hello');
      expect(diffHuman).toContain('Targets: 1; differences: 1');
      expect(diffHuman).toContain('library-only: CHANGELOG.md');
      expect(diffHuman).toContain('Next: Run skill-sync sync --global');
      const orphanedDiff = formatGlobalDiffHuman({ ...diff, state: 'orphaned' });
      expect(orphanedDiff).toContain(
        'Preview removal with skill-sync uninstall examples/hello --global --dry-run',
      );
      expect(orphanedDiff).not.toContain('sync --global to reconcile');

      const synced = await syncGlobalSkills({
        library: revisionProvider,
        paths: applicationPaths,
        registry: targets,
        storage: globalMutationStorage(applicationPaths),
      });
      expect(synced).toMatchObject({ applied: true, scope: 'global' });
      const reconciliationHuman = formatGlobalReconciliationHuman(synced);
      expect(reconciliationHuman).toContain(`Sync apply: global ${globalStateDirectory}`);
      expect(reconciliationHuman).toContain('Result: complete; selected 1');
      expect(reconciliationHuman).toContain('Outcomes: updated 1');
      expect(reconciliationHuman).toContain('Next: Verify with skill-sync status --global.');
      const reconciledSkill = synced.skills[0];
      if (reconciledSkill === undefined)
        throw new Error('Expected a global reconciliation result.');
      const orphanedReconciliation = formatGlobalReconciliationHuman({
        ...synced,
        applied: false,
        selectedIds: [reconciledSkill.id],
        skills: [
          {
            ...reconciledSkill,
            action: 'skip-orphaned',
            outcome: 'skipped',
            state: 'orphaned',
          },
        ],
      });
      expect(orphanedReconciliation).toContain(
        'Preview removal with skill-sync uninstall examples/hello --global --dry-run',
      );
      expect(orphanedReconciliation).not.toContain('retry skill-sync sync --global');
      const updatePreview = formatGlobalReconciliationHuman({
        ...synced,
        applied: false,
        dryRun: true,
        operation: 'update',
        skills: synced.skills.map((skill) => ({ ...skill, outcome: 'planned' as const })),
        wouldChange: true,
      });
      expect(updatePreview).toContain('Update dry-run: global');
      expect(updatePreview).toContain(
        'Next: Apply with skill-sync update examples/hello --global, then verify with skill-sync status --global.',
      );
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

  it('refuses a changed reviewed global install before staging or journaling', async () => {
    await withTempDirectory('skill-sync-global-reviewed-', async (root) => {
      const library = join(root, 'library');
      const home = join(root, 'home');
      const applicationPaths = paths(root);
      const targets = registry(home);
      await createFixtureLibrary(library);
      const source = join(library, 'skills', 'examples', 'hello');
      const digest = await sha256TreeDigest(source, { rejectNestedSkillRoots: true });
      const common = {
        libraryIdentity: 'github.com/acme/skills',
        paths: applicationPaths,
        registry: targets,
        skills: [{ digest, id: 'examples/hello', name: 'hello', rootPath: source }],
        storage: globalMutationStorage(applicationPaths),
        targets: ['codex'] as const,
      };
      const preview = await installGlobalSkills({
        ...common,
        dryRun: true,
        libraryRevision: 'a'.repeat(40),
      });

      expect(preview.fingerprint).toMatch(/^install-v1-[a-f0-9]{64}$/u);
      await expect(
        installGlobalSkills({
          ...common,
          expectedPlanFingerprint: preview.fingerprint,
          libraryRevision: 'b'.repeat(40),
        }),
      ).rejects.toMatchObject({
        code: 'INSTALL_PLAN_CHANGED',
        details: { expectedFingerprint: preview.fingerprint, scope: 'global' },
        exitCode: 5,
      });

      expect(await readGlobalManifest(applicationPaths)).toBeUndefined();
      expect(await readGlobalLock(applicationPaths)).toBeUndefined();
      expect(
        await readFile(join(home, '.codex', 'skills', 'hello', 'SKILL.md'), 'utf8').catch(
          () => undefined,
        ),
      ).toBeUndefined();
      expect(
        await readdir(globalMutationStorage(applicationPaths).journalDirectory).catch(() => []),
      ).toEqual([]);
    });
  });

  it('applies only the exact reviewed global install plan', async () => {
    await withTempDirectory('skill-sync-global-reviewed-apply-', async (root) => {
      const library = join(root, 'library');
      const home = join(root, 'home');
      const applicationPaths = paths(root);
      const targets = registry(home);
      await createFixtureLibrary(library);
      const source = join(library, 'skills', 'examples', 'hello');
      const digest = await sha256TreeDigest(source, { rejectNestedSkillRoots: true });
      const common = {
        libraryIdentity: 'github.com/acme/skills',
        libraryRevision: 'a'.repeat(40),
        paths: applicationPaths,
        registry: targets,
        skills: [{ digest, id: 'examples/hello', name: 'hello', rootPath: source }],
        storage: globalMutationStorage(applicationPaths),
        targets: ['codex'] as const,
      };
      const preview = await installGlobalSkills({ ...common, dryRun: true });
      const installed = await installGlobalSkills({
        ...common,
        expectedPlanFingerprint: preview.fingerprint,
      });

      expect(installed).toMatchObject({ applied: true, fingerprint: preview.fingerprint });
      expect(await readGlobalManifest(applicationPaths)).toBeDefined();
      await expect(
        stat(join(home, '.codex', 'skills', 'hello', 'SKILL.md')),
      ).resolves.toBeDefined();
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
