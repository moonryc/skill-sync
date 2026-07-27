import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  installProjectSkills,
  uninstallProjectSkills,
  type ProjectMutationStorage,
  type ResolvedInstallSkill,
} from '../../src/application/project-installation.js';
import { sha256TreeDigest } from '../../src/domain/digest.js';
import { SkillSyncError } from '../../src/domain/result.js';
import { readProjectLock, readProjectManifest } from '../../src/infrastructure/project-state.js';
import { withTempDirectory } from '../helpers/temp.js';

const libraryIdentity = 'github.com/acme/skills';
const firstRevision = 'a'.repeat(40);
const secondRevision = 'b'.repeat(40);

function storage(root: string): ProjectMutationStorage {
  const runtime = join(root, 'runtime');
  return {
    backupRoot: join(runtime, 'backups'),
    journalDirectory: join(runtime, 'journals'),
    lockPath: join(runtime, 'locks', 'project.lock'),
    stagingRoot: join(runtime, 'staging'),
  };
}

async function createResolvedSkill(
  root: string,
  id = 'frontend/review-ui',
  body = '# Review UI\n',
): Promise<ResolvedInstallSkill> {
  const name = id.split('/').at(-1);
  if (name === undefined) throw new Error('Fixture skill ID has no leaf name.');
  const skillRoot = join(root, 'library', 'skills', ...id.split('/'));
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Fixture skill\n---\n\n${body}`,
  );
  await mkdir(join(skillRoot, 'assets'));
  await writeFile(join(skillRoot, 'assets', 'notes.txt'), `notes for ${id}\n`);
  return {
    digest: await sha256TreeDigest(skillRoot, { rejectNestedSkillRoots: true }),
    id,
    name,
    rootPath: skillRoot,
  };
}

async function expectSkillSyncError(
  promise: Promise<unknown>,
  code: string,
): Promise<SkillSyncError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SkillSyncError);
    expect((error as SkillSyncError).code).toBe(code);
    return error as SkillSyncError;
  }
  throw new Error(`Expected ${code}.`);
}

describe('project installation application service', () => {
  it('installs one canonical revision identically into multiple targets and tracks one skill', async () => {
    await withTempDirectory('skill-sync-install-service-', async (root) => {
      const project = join(root, 'project');
      await mkdir(project);
      await writeFile(join(project, '.gitignore'), '# user rule\n.env\n');
      const skill = await createResolvedSkill(root);

      const result = await installProjectSkills({
        gitignore: 'managed',
        libraryIdentity,
        libraryRevision: firstRevision,
        operationId: 'install-review-ui',
        projectRoot: project,
        skills: [skill],
        storage: storage(root),
        targets: ['codex', 'claude'],
      });

      expect(result.applied).toBe(true);
      expect(result.skills).toEqual([expect.objectContaining({ id: skill.id, status: 'install' })]);
      const codex = join(project, '.codex', 'skills', 'review-ui');
      const claude = join(project, '.claude', 'skills', 'review-ui');
      expect(await sha256TreeDigest(codex, { rejectNestedSkillRoots: true })).toBe(skill.digest);
      expect(await sha256TreeDigest(claude, { rejectNestedSkillRoots: true })).toBe(skill.digest);
      expect(await readFile(join(codex, 'SKILL.md'), 'utf8')).toBe(
        await readFile(join(claude, 'SKILL.md'), 'utf8'),
      );

      const manifest = await readProjectManifest(project);
      const lock = await readProjectLock(project);
      expect(manifest?.skills).toHaveLength(1);
      expect(manifest?.skills[0]?.projections.map((projection) => projection.target)).toEqual([
        'claude',
        'codex',
      ]);
      expect(lock?.library.revision).toBe(firstRevision);
      expect(lock?.skills[0]).toMatchObject({
        baseDigest: skill.digest,
        canonicalDigest: skill.digest,
      });
      const gitignore = await readFile(join(project, '.gitignore'), 'utf8');
      expect(gitignore).toContain('# user rule\n.env\n');
      expect(gitignore).toContain('/.claude/skills/review-ui/');
      expect(gitignore).toContain('/.codex/skills/review-ui/');
      expect(gitignore).not.toContain('/skill-sync.json/');
    });
  });

  it('makes an identical reinstall a byte-and-mtime no-op', async () => {
    await withTempDirectory('skill-sync-idempotent-service-', async (root) => {
      const project = join(root, 'project');
      await mkdir(project);
      const skill = await createResolvedSkill(root);
      const common = {
        gitignore: 'unmanaged' as const,
        libraryIdentity,
        libraryRevision: firstRevision,
        projectRoot: project,
        skills: [skill],
        storage: storage(root),
        targets: ['codex'] as const,
      };
      await installProjectSkills({ ...common, operationId: 'first-install' });
      const copy = join(project, '.codex', 'skills', 'review-ui', 'SKILL.md');
      const manifestPath = join(project, 'skill-sync.json');
      const before = {
        copy: await stat(copy),
        copyBytes: await readFile(copy),
        manifest: await stat(manifestPath),
        manifestBytes: await readFile(manifestPath),
      };

      const result = await installProjectSkills({
        ...common,
        libraryRevision: secondRevision,
        operationId: 'repeat-install',
      });
      expect(result.applied).toBe(false);
      expect(result.writes).toEqual([]);
      expect(result.skills[0]?.status).toBe('already-installed');
      expect((await stat(copy)).mtimeMs).toBe(before.copy.mtimeMs);
      expect((await stat(manifestPath)).mtimeMs).toBe(before.manifest.mtimeMs);
      expect(await readFile(copy)).toEqual(before.copyBytes);
      expect(await readFile(manifestPath)).toEqual(before.manifestBytes);
      expect((await readProjectLock(project))?.library.revision).toBe(firstRevision);
    });
  });

  it('expands an unmodified tracked skill to a new target without rewriting its old copy', async () => {
    await withTempDirectory('skill-sync-expand-service-', async (root) => {
      const project = join(root, 'project');
      await mkdir(project);
      const skill = await createResolvedSkill(root);
      await installProjectSkills({
        libraryIdentity,
        libraryRevision: firstRevision,
        operationId: 'install-codex',
        projectRoot: project,
        skills: [skill],
        storage: storage(root),
        targets: ['codex'],
      });
      const codexFile = join(project, '.codex', 'skills', 'review-ui', 'SKILL.md');
      const codexMtime = (await stat(codexFile)).mtimeMs;

      const expanded = await installProjectSkills({
        libraryIdentity,
        libraryRevision: secondRevision,
        operationId: 'expand-claude',
        projectRoot: project,
        skills: [skill],
        storage: storage(root),
        targets: ['claude'],
      });
      expect(expanded.skills[0]?.status).toBe('expand-targets');
      expect((await stat(codexFile)).mtimeMs).toBe(codexMtime);
      expect(await sha256TreeDigest(join(project, '.claude', 'skills', 'review-ui'))).toBe(
        skill.digest,
      );
      expect((await readProjectManifest(project))?.skills[0]?.projections).toHaveLength(2);
      expect((await readProjectLock(project))?.library.revision).toBe(secondRevision);
    });
  });

  it('refuses to turn install into an update or overwrite local edits', async () => {
    await withTempDirectory('skill-sync-refuse-install-service-', async (root) => {
      const project = join(root, 'project');
      await mkdir(project);
      const skill = await createResolvedSkill(root);
      await installProjectSkills({
        libraryIdentity,
        libraryRevision: firstRevision,
        operationId: 'initial-install',
        projectRoot: project,
        skills: [skill],
        storage: storage(root),
        targets: ['codex'],
      });
      const installedFile = join(project, '.codex', 'skills', 'review-ui', 'SKILL.md');
      const originalInstalled = await readFile(installedFile, 'utf8');

      await writeFile(join(skill.rootPath, 'SKILL.md'), `${originalInstalled}\nremote change\n`);
      const advanced = { ...skill, digest: await sha256TreeDigest(skill.rootPath) };
      await expectSkillSyncError(
        installProjectSkills({
          libraryIdentity,
          libraryRevision: secondRevision,
          operationId: 'implicit-update',
          projectRoot: project,
          skills: [advanced],
          storage: storage(root),
          targets: ['codex'],
        }),
        'INSTALL_REQUIRES_UPDATE',
      );
      expect(await readFile(installedFile, 'utf8')).toBe(originalInstalled);

      await writeFile(join(skill.rootPath, 'SKILL.md'), originalInstalled);
      await writeFile(installedFile, `${originalInstalled}\nlocal change\n`);
      await expectSkillSyncError(
        installProjectSkills({
          libraryIdentity,
          libraryRevision: firstRevision,
          operationId: 'overwrite-local',
          projectRoot: project,
          skills: [skill],
          storage: storage(root),
          targets: ['codex'],
        }),
        'LOCAL_MODIFICATIONS_REFUSED',
      );
      expect(await readFile(installedFile, 'utf8')).toContain('local change');
    });
  });

  it('uninstalls only managed unmodified copies and updates tracking and gitignore', async () => {
    await withTempDirectory('skill-sync-uninstall-service-', async (root) => {
      const project = join(root, 'project');
      await mkdir(project);
      await writeFile(join(project, '.gitignore'), 'user-rule\n');
      const skill = await createResolvedSkill(root);
      await installProjectSkills({
        gitignore: 'managed',
        libraryIdentity,
        libraryRevision: firstRevision,
        operationId: 'install-before-uninstall',
        projectRoot: project,
        skills: [skill],
        storage: storage(root),
        targets: ['codex', 'claude'],
      });

      const result = await uninstallProjectSkills({
        operationId: 'uninstall-review-ui',
        projectRoot: project,
        skillIds: [skill.id],
        storage: storage(root),
      });
      expect(result.applied).toBe(true);
      await expect(stat(join(project, '.codex', 'skills', 'review-ui'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(stat(join(project, '.claude', 'skills', 'review-ui'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await readProjectManifest(project))?.skills).toEqual([]);
      expect((await readProjectLock(project))?.skills).toEqual([]);
      const gitignore = await readFile(join(project, '.gitignore'), 'utf8');
      expect(gitignore.startsWith('user-rule\n')).toBe(true);
      expect(gitignore).not.toContain('skill-sync managed skills');

      await expectSkillSyncError(
        uninstallProjectSkills({
          projectRoot: project,
          skillIds: ['unmanaged/not-here'],
          storage: storage(root),
        }),
        'SKILL_NOT_MANAGED',
      );
    });
  });

  it('refuses modified uninstall, previews discard without writes, then backs up confirmed discard', async () => {
    await withTempDirectory('skill-sync-discard-service-', async (root) => {
      const project = join(root, 'project');
      await mkdir(project);
      const skill = await createResolvedSkill(root);
      const runtime = storage(root);
      await installProjectSkills({
        libraryIdentity,
        libraryRevision: firstRevision,
        operationId: 'install-before-discard',
        projectRoot: project,
        skills: [skill],
        storage: runtime,
        targets: ['codex'],
      });
      const installed = join(project, '.codex', 'skills', 'review-ui', 'SKILL.md');
      await writeFile(installed, 'precious local work\n');
      const manifestBefore = await readFile(join(project, 'skill-sync.json'));

      await expectSkillSyncError(
        uninstallProjectSkills({
          projectRoot: project,
          skillIds: [skill.id],
          storage: runtime,
        }),
        'LOCAL_MODIFICATIONS_REFUSED',
      );
      expect(await readFile(installed, 'utf8')).toBe('precious local work\n');

      const backupNamesBefore = await readdir(runtime.backupRoot).catch(() => []);
      const preview = await uninstallProjectSkills({
        discardLocal: true,
        dryRun: true,
        projectRoot: project,
        skillIds: [skill.id],
      });
      expect(preview.backup).toMatchObject({ required: true });
      expect(preview.backup.paths).toContain('.codex/skills/review-ui');
      expect(await readFile(installed, 'utf8')).toBe('precious local work\n');
      expect(await readdir(runtime.backupRoot).catch(() => [])).toEqual(backupNamesBefore);
      expect(await readFile(join(project, 'skill-sync.json'))).toEqual(manifestBefore);

      await expectSkillSyncError(
        uninstallProjectSkills({
          discardLocal: true,
          projectRoot: project,
          skillIds: [skill.id],
          storage: runtime,
        }),
        'DESTRUCTIVE_CONFIRMATION_REQUIRED',
      );

      const removed = await uninstallProjectSkills({
        confirmed: true,
        discardLocal: true,
        operationId: 'discard-review-ui',
        projectRoot: project,
        skillIds: [skill.id],
        storage: runtime,
      });
      expect(removed.applied).toBe(true);
      const backups = await readdir(runtime.backupRoot);
      expect(backups).toHaveLength(1);
      const backedUpSkill = join(
        runtime.backupRoot,
        backups[0] ?? '',
        'files',
        '.codex',
        'skills',
        'review-ui',
        'SKILL.md',
      );
      expect(await readFile(backedUpSkill, 'utf8')).toBe('precious local work\n');
      expect(
        await readFile(join(runtime.backupRoot, backups[0] ?? '', 'files', 'skill-sync.json')),
      ).toEqual(manifestBefore);
      await expect(stat(installed)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('produces a complete first-install dry run without writing project or runtime state', async () => {
    await withTempDirectory('skill-sync-dry-install-service-', async (root) => {
      const project = join(root, 'project');
      await mkdir(project);
      await writeFile(join(project, 'keep.txt'), 'unchanged\n');
      const skill = await createResolvedSkill(root);
      const runtime = storage(root);

      const preview = await installProjectSkills({
        dryRun: true,
        gitignore: 'managed',
        libraryIdentity,
        libraryRevision: firstRevision,
        projectRoot: project,
        skills: [skill],
        storage: runtime,
        targets: ['codex'],
      });
      expect(preview.applied).toBe(false);
      expect(preview.dryRun).toBe(true);
      expect(preview.projectRoot).toBe(await realpath(project));
      expect(preview.libraryRevision).toBe(firstRevision);
      expect(preview.writes).toEqual([
        '.codex/skills/review-ui',
        '.gitignore',
        'skill-sync.json',
        'skill-sync.lock.json',
      ]);
      expect(preview.skills[0]?.projections).toEqual([
        { destination: '.codex/skills/review-ui', target: 'codex', write: true },
      ]);
      expect(await readdir(project)).toEqual(['keep.txt']);
      await expect(stat(join(root, 'runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(project, 'keep.txt'), 'utf8')).toBe('unchanged\n');
    });
  });
});
