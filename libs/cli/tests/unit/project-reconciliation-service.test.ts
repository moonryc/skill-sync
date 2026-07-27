import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CachedLibraryRevisionProvider,
  formatProjectDiffHuman,
  formatProjectStatusHuman,
  inspectProjectDiff,
  inspectProjectStatus,
  syncProjectSkills,
  updateProjectSkills,
  type LibraryRevisionProvider,
  type LibraryRevisionRequest,
  type ResolvedLibraryRevision,
} from '../../src/application/project-reconciliation.js';
import {
  installProjectSkills,
  type ProjectMutationStorage,
  type ResolvedInstallSkill,
} from '../../src/application/project-installation.js';
import { sha256TreeDigest } from '../../src/domain/digest.js';
import { EXIT_CODES } from '../../src/domain/result.js';
import { validateLibrary } from '../../src/domain/library.js';
import type { NormalizedGitRemote } from '../../src/infrastructure/git.js';
import { readProjectLock } from '../../src/infrastructure/project-state.js';
import { withTempDirectory } from '../helpers/temp.js';

const identity = 'github.com/acme/skills';
const firstRevision = '1'.repeat(40);
const secondRevision = '2'.repeat(40);

function storage(root: string): ProjectMutationStorage {
  return {
    backupRoot: join(root, 'runtime', 'backups'),
    journalDirectory: join(root, 'runtime', 'journals'),
    lockPath: join(root, 'runtime', 'locks', 'project.lock'),
    stagingRoot: join(root, 'runtime', 'staging'),
  };
}

class StaticRevisionProvider implements LibraryRevisionProvider {
  public readonly requests: LibraryRevisionRequest[] = [];

  public constructor(private readonly revision: ResolvedLibraryRevision) {}

  public resolve(request: LibraryRevisionRequest): Promise<ResolvedLibraryRevision> {
    this.requests.push(request);
    return Promise.resolve(this.revision);
  }
}

function provider(
  libraryRoot: string,
  revision = secondRevision,
  options: {
    readonly freshness?: ResolvedLibraryRevision['freshness'];
    readonly stale?: boolean;
    readonly usableForMutation?: boolean;
  } = {},
): StaticRevisionProvider {
  const stale = options.stale ?? false;
  return new StaticRevisionProvider({
    branch: 'main',
    freshness: options.freshness ?? 'fetched',
    identity,
    libraryRoot,
    refreshedAt: '2026-07-19T12:00:00.000Z',
    revision,
    stale,
    usableForMutation: options.usableForMutation ?? !stale,
    ...(stale
      ? {
          warning: {
            code: options.freshness === 'offline-revision' ? 'OFFLINE_REVISION' : 'STALE_CACHE',
            message: 'Cached data is not current with the remote.',
          },
        }
      : {}),
  });
}

async function createLibrary(
  root: string,
  skills: Readonly<Record<string, string>>,
): Promise<string> {
  const library = join(root, 'library');
  await mkdir(join(library, '.skill-sync'), { recursive: true });
  await writeFile(join(library, '.skill-sync', 'library.json'), '{"schemaVersion":1}\n');
  const markedGroups = new Set<string>();
  for (const [id, body] of Object.entries(skills)) {
    const segments = id.split('/');
    const name = segments.at(-1);
    if (name === undefined) throw new Error('Fixture skill needs a name.');
    for (let index = 1; index < segments.length; index += 1) {
      const groupSegments = segments.slice(0, index);
      const group = groupSegments.join('/');
      if (markedGroups.has(group)) continue;
      const groupRoot = join(library, 'skills', ...groupSegments);
      await mkdir(groupRoot, { recursive: true });
      await writeFile(join(groupRoot, '.skill-sync-group.json'), '{}\n');
      markedGroups.add(group);
    }
    const skillRoot = join(library, 'skills', ...segments);
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}`,
    );
    await mkdir(join(skillRoot, 'assets'));
    await writeFile(join(skillRoot, 'assets', 'notes.txt'), `${id} notes\n`);
  }
  const validation = await validateLibrary(library);
  expect(validation.errors).toEqual([]);
  return library;
}

async function resolvedSkills(library: string): Promise<readonly ResolvedInstallSkill[]> {
  const validation = await validateLibrary(library);
  if (!validation.valid) throw new Error('Fixture library is invalid.');
  return validation.skills.map((skill) => ({
    digest: skill.digest,
    id: skill.id,
    name: skill.name,
    rootPath: skill.rootPath,
  }));
}

async function install(
  root: string,
  project: string,
  library: string,
  targets: readonly ('codex' | 'claude')[] = ['codex'],
): Promise<void> {
  await installProjectSkills({
    libraryIdentity: identity,
    libraryRevision: firstRevision,
    operationId: `install-${targets.join('-')}`,
    projectRoot: project,
    skills: await resolvedSkills(library),
    storage: storage(root),
    targets,
  });
}

async function replaceSkillBody(library: string, id: string, body: string): Promise<string> {
  const file = join(library, 'skills', ...id.split('/'), 'SKILL.md');
  const name = id.split('/').at(-1);
  await writeFile(
    file,
    `---\nname: ${name ?? ''}\ndescription: ${name ?? ''} fixture\n---\n\n${body}`,
  );
  return await sha256TreeDigest(join(library, 'skills', ...id.split('/')));
}

async function readBytes(project: string, relativePath: string): Promise<Buffer> {
  return await readFile(join(project, ...relativePath.split('/')));
}

describe('project reconciliation application service', () => {
  it('uses the cache exact-revision snapshot without another checkout or staging write', async () => {
    await withTempDirectory('skill-sync-revision-provider-', async (root) => {
      const library = await createLibrary(root, { 'group/alpha': '# Alpha one\n' });
      const remote: NormalizedGitRemote = {
        cloneUrl: 'https://github.com/acme/skills.git',
        host: 'github.com',
        identity,
        owner: 'acme',
        repository: 'skills',
        transport: 'https',
        upgradedFromHttp: false,
      };
      const requests: { readonly kind: string; readonly value: unknown }[] = [];
      const cachedRevision = {
        branch: 'main',
        freshness: 'fetched' as const,
        identity,
        refreshedAt: '2026-07-19T12:00:00.000Z',
        repositoryDirectory: join(root, 'unused-repository.git'),
        revision: secondRevision,
        stale: false,
        treeDirectory: library,
        usableForMutation: true,
      };
      const exactProvider = new CachedLibraryRevisionProvider({
        cache: {
          inspect: (request) => {
            requests.push({ kind: 'inspect', value: request });
            return Promise.resolve({
              ...cachedRevision,
              freshness: 'cache-only',
              stale: true,
              usableForMutation: false,
            });
          },
          refresh: (request) => {
            requests.push({ kind: 'refresh', value: request });
            return Promise.resolve(cachedRevision);
          },
        },
        remote,
        stagingRoot: join(root, 'must-not-be-created'),
      });

      const resolved = await exactProvider.resolve({ purpose: 'inspection' });
      expect(resolved.libraryRoot).toBe(library);
      const offline = await exactProvider.resolve({ cacheOnly: true, purpose: 'inspection' });
      expect(offline).toMatchObject({ freshness: 'cache-only', stale: true });
      expect(requests).toEqual([
        { kind: 'refresh', value: { access: 'read-only', remote } },
        { kind: 'inspect', value: { remote } },
      ]);
      await expect(stat(join(root, 'must-not-be-created'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('reports stale three-way status and target-specific diff without writing project state', async () => {
    await withTempDirectory('skill-sync-status-', async (root) => {
      const library = await createLibrary(root, { 'frontend/review-ui': '# Version one\n' });
      const project = join(root, 'project');
      await mkdir(project);
      await install(root, project, library, ['codex', 'claude']);
      const codexFile = join(project, '.codex', 'skills', 'review-ui', 'SKILL.md');
      const claudeFile = join(project, '.claude', 'skills', 'review-ui', 'SKILL.md');
      await writeFile(codexFile, 'codex local version\n');
      await writeFile(claudeFile, 'claude local version\n');
      const manifestBefore = await readBytes(project, 'skill-sync.json');
      const lockBefore = await readBytes(project, 'skill-sync.lock.json');
      const stale = provider(library, firstRevision, {
        freshness: 'stale-cache',
        stale: true,
        usableForMutation: false,
      });

      const statusReport = await inspectProjectStatus({ library: stale, projectRoot: project });
      expect(statusReport).toMatchObject({
        authoritative: false,
        freshness: 'stale-cache',
        libraryRevision: firstRevision,
        stale: true,
      });
      expect(statusReport.skills[0]).toMatchObject({
        id: 'frontend/review-ui',
        state: 'conflicted',
      });
      expect(statusReport.skills[0]?.assessment.divergentTargets).toEqual(['claude', 'codex']);
      expect(formatProjectStatusHuman(statusReport)).toContain('not current');

      const cacheOnlyStatus = await inspectProjectStatus({
        library: stale,
        offline: true,
        projectRoot: project,
      });
      expect(cacheOnlyStatus.authoritative).toBe(false);

      const diffReport = await inspectProjectDiff({
        library: stale,
        projectRoot: project,
        selector: 'review-ui',
      });
      expect(diffReport.targets.map((target) => target.target)).toEqual(['claude', 'codex']);
      expect(diffReport.targets.every((target) => target.divergentFromOtherTargets)).toBe(true);
      expect(
        diffReport.targets.every((target) =>
          target.differences.some(
            (difference) => difference.kind === 'different' && difference.path === 'SKILL.md',
          ),
        ),
      ).toBe(true);
      expect(formatProjectDiffHuman(diffReport)).toContain('different: SKILL.md');
      expect(stale.requests).toEqual([
        { allowStale: true, purpose: 'inspection' },
        { cacheOnly: true, purpose: 'inspection' },
        { allowStale: true, purpose: 'inspection' },
      ]);
      expect(await readBytes(project, 'skill-sync.json')).toEqual(manifestBefore);
      expect(await readBytes(project, 'skill-sync.lock.json')).toEqual(lockBefore);
    });
  });

  it('syncs safe skills from one revision while preserving dirty skills as a partial result', async () => {
    await withTempDirectory('skill-sync-bulk-', async (root) => {
      const library = await createLibrary(root, {
        'group/alpha': '# Alpha one\n',
        'group/beta': '# Beta one\n',
      });
      const project = join(root, 'project');
      await mkdir(project);
      await install(root, project, library);
      const betaInstalled = join(project, '.codex', 'skills', 'beta', 'SKILL.md');
      await writeFile(betaInstalled, 'precious beta work\n');
      const alphaDigest = await replaceSkillBody(library, 'group/alpha', '# Alpha two\n');
      await replaceSkillBody(library, 'group/beta', '# Beta two\n');
      const fresh = provider(library);

      const result = await syncProjectSkills({
        library: fresh,
        operationId: 'bulk-sync',
        projectRoot: project,
        storage: storage(root),
      });

      expect(result.exitCode).toBe(EXIT_CODES.partial);
      expect(result.skills.map((skill) => [skill.id, skill.outcome])).toEqual([
        ['group/alpha', 'updated'],
        ['group/beta', 'skipped'],
      ]);
      expect(await sha256TreeDigest(join(project, '.codex', 'skills', 'alpha'))).toBe(alphaDigest);
      expect(await readFile(betaInstalled, 'utf8')).toBe('precious beta work\n');
      const lock = await readProjectLock(project);
      expect(lock?.library.revision).toBe(secondRevision);
      expect(lock?.skills.find((skill) => skill.id === 'group/alpha')?.baseDigest).toBe(
        alphaDigest,
      );
      expect(lock?.skills.find((skill) => skill.id === 'group/beta')?.baseDigest).not.toBe(
        (await resolvedSkills(library)).find((skill) => skill.id === 'group/beta')?.digest,
      );
      expect(fresh.requests).toEqual([{ purpose: 'application' }]);
    });
  });

  it('restores a missing projection and advances all projections atomically', async () => {
    await withTempDirectory('skill-sync-restore-', async (root) => {
      const library = await createLibrary(root, { 'group/alpha': '# Alpha one\n' });
      const project = join(root, 'project');
      await mkdir(project);
      await install(root, project, library, ['codex', 'claude']);
      await rm(join(project, '.claude', 'skills', 'alpha'), { recursive: true });
      const advancedDigest = await replaceSkillBody(library, 'group/alpha', '# Alpha two\n');

      const result = await syncProjectSkills({
        library: provider(library),
        operationId: 'restore-alpha',
        projectRoot: project,
        storage: storage(root),
      });

      expect(result.skills[0]).toMatchObject({ outcome: 'restored', state: 'missing' });
      for (const target of ['.codex', '.claude']) {
        expect(await sha256TreeDigest(join(project, target, 'skills', 'alpha'))).toBe(
          advancedDigest,
        );
      }
      expect(
        (await readProjectLock(project))?.skills[0]?.projections.every(
          (projection) => projection.digest === advancedDigest,
        ),
      ).toBe(true);
    });
  });

  it('updates only explicit tracked selectors and makes update --all use the bulk engine', async () => {
    await withTempDirectory('skill-sync-update-', async (root) => {
      const library = await createLibrary(root, {
        'group/alpha': '# Alpha one\n',
        'group/beta': '# Beta one\n',
      });
      const project = join(root, 'project');
      await mkdir(project);
      await install(root, project, library);
      const oldBeta = await sha256TreeDigest(join(project, '.codex', 'skills', 'beta'));
      await replaceSkillBody(library, 'group/alpha', '# Alpha two\n');
      const betaDigest = await replaceSkillBody(library, 'group/beta', '# Beta two\n');

      const selected = await updateProjectSkills({
        library: provider(library),
        operationId: 'update-alpha',
        projectRoot: project,
        selectors: ['alpha', 'alpha'],
        storage: storage(root),
      });
      expect(selected.selectedIds).toEqual(['group/alpha']);
      expect(selected.skills[0]?.outcome).toBe('updated');
      expect(await sha256TreeDigest(join(project, '.codex', 'skills', 'beta'))).toBe(oldBeta);

      const all = await updateProjectSkills({
        all: true,
        library: provider(library),
        operationId: 'update-all',
        projectRoot: project,
        storage: storage(root),
      });
      expect(all.selectedIds).toEqual(['group/alpha', 'group/beta']);
      expect(all.skills.map((skill) => skill.outcome)).toEqual(['unchanged', 'updated']);
      expect(await sha256TreeDigest(join(project, '.codex', 'skills', 'beta'))).toBe(betaDigest);
    });
  });

  it('previews discard with zero writes, requires confirmation, then backs up and replaces every target', async () => {
    await withTempDirectory('skill-sync-discard-update-', async (root) => {
      const library = await createLibrary(root, { 'group/alpha': '# Alpha one\n' });
      const project = join(root, 'project');
      await mkdir(project);
      await install(root, project, library, ['codex', 'claude']);
      const codexFile = join(project, '.codex', 'skills', 'alpha', 'SKILL.md');
      const claudeFile = join(project, '.claude', 'skills', 'alpha', 'SKILL.md');
      await writeFile(codexFile, 'codex precious work\n');
      await writeFile(claudeFile, 'claude precious work\n');
      const advancedDigest = await replaceSkillBody(library, 'group/alpha', '# Alpha two\n');
      const runtime = storage(root);
      const backupsBefore = await readdir(runtime.backupRoot).catch(() => []);
      const lockBefore = await readBytes(project, 'skill-sync.lock.json');

      const preview = await updateProjectSkills({
        discardLocal: true,
        dryRun: true,
        library: provider(library),
        projectRoot: project,
        selectors: ['group/alpha'],
      });
      expect(preview.skills[0]).toMatchObject({
        action: 'discard-local',
        outcome: 'planned',
      });
      expect(preview.skills[0]?.backupPaths).toEqual([
        '.claude/skills/alpha',
        '.codex/skills/alpha',
        'skill-sync.json',
        'skill-sync.lock.json',
      ]);
      expect(await readFile(codexFile, 'utf8')).toBe('codex precious work\n');
      expect(await readBytes(project, 'skill-sync.lock.json')).toEqual(lockBefore);
      expect(await readdir(runtime.backupRoot).catch(() => [])).toEqual(backupsBefore);

      await expect(
        updateProjectSkills({
          discardLocal: true,
          library: provider(library),
          projectRoot: project,
          selectors: ['group/alpha'],
          storage: runtime,
        }),
      ).rejects.toMatchObject({
        code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED',
        exitCode: EXIT_CODES.usage,
      });
      expect(await readFile(codexFile, 'utf8')).toBe('codex precious work\n');

      const applied = await updateProjectSkills({
        confirmed: true,
        discardLocal: true,
        library: provider(library),
        operationId: 'confirmed-discard',
        projectRoot: project,
        selectors: ['group/alpha'],
        storage: runtime,
      });
      expect(applied.skills[0]?.outcome).toBe('discarded-local');
      expect(await sha256TreeDigest(join(project, '.codex', 'skills', 'alpha'))).toBe(
        advancedDigest,
      );
      expect(await sha256TreeDigest(join(project, '.claude', 'skills', 'alpha'))).toBe(
        advancedDigest,
      );
      const backups = await readdir(runtime.backupRoot);
      expect(backups).toHaveLength(1);
      const backupRoot = join(runtime.backupRoot, backups[0] ?? '', 'files');
      expect(
        await readFile(join(backupRoot, '.codex', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      ).toBe('codex precious work\n');
      expect(
        await readFile(join(backupRoot, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8'),
      ).toBe('claude precious work\n');
      expect(await stat(join(backupRoot, 'skill-sync.json'))).toBeDefined();
      expect(await stat(join(backupRoot, 'skill-sync.lock.json'))).toBeDefined();
    });
  });

  it('rolls back every target of a failed skill while keeping independent progress', async () => {
    await withTempDirectory('skill-sync-reconcile-rollback-', async (root) => {
      const library = await createLibrary(root, {
        'group/alpha': '# Alpha one\n',
        'group/beta': '# Beta one\n',
      });
      const project = join(root, 'project');
      await mkdir(project);
      await install(root, project, library, ['codex', 'claude']);
      const alphaDigest = await replaceSkillBody(library, 'group/alpha', '# Alpha two\n');
      await replaceSkillBody(library, 'group/beta', '# Beta two\n');
      const betaBefore = await Promise.all(
        ['.codex', '.claude'].map(
          async (target) => await readFile(join(project, target, 'skills', 'beta', 'SKILL.md')),
        ),
      );
      const betaBaseBefore = (await readProjectLock(project))?.skills.find(
        (skill) => skill.id === 'group/beta',
      )?.baseDigest;

      const result = await syncProjectSkills({
        hooks: {
          beforeCommit: ({ index, skillId }) => {
            if (skillId === 'group/beta' && index === 1) {
              throw new Error('simulated second-target failure');
            }
          },
        },
        library: provider(library),
        operationId: 'rollback-batch',
        projectRoot: project,
        storage: storage(root),
      });

      expect(result.exitCode).toBe(EXIT_CODES.partial);
      expect(result.skills.map((skill) => [skill.id, skill.outcome])).toEqual([
        ['group/alpha', 'updated'],
        ['group/beta', 'failed'],
      ]);
      for (const [index, target] of ['.codex', '.claude'].entries()) {
        expect(await readFile(join(project, target, 'skills', 'beta', 'SKILL.md'))).toEqual(
          betaBefore[index],
        );
      }
      expect(await sha256TreeDigest(join(project, '.codex', 'skills', 'alpha'))).toBe(alphaDigest);
      const lock = await readProjectLock(project);
      expect(lock?.skills.find((skill) => skill.id === 'group/beta')?.baseDigest).toBe(
        betaBaseBefore,
      );
      expect(lock?.skills.find((skill) => skill.id === 'group/alpha')?.baseDigest).toBe(
        alphaDigest,
      );
    });
  });

  it('makes check read-only and applies only an explicitly selected cached revision without claiming freshness', async () => {
    await withTempDirectory('skill-sync-check-offline-', async (root) => {
      const library = await createLibrary(root, { 'group/alpha': '# Alpha one\n' });
      const project = join(root, 'project');
      await mkdir(project);
      await install(root, project, library);
      const advancedDigest = await replaceSkillBody(library, 'group/alpha', '# Alpha two\n');
      const lockBefore = await readBytes(project, 'skill-sync.lock.json');
      const destinationBefore = await readBytes(project, '.codex/skills/alpha/SKILL.md');

      const checked = await syncProjectSkills({
        check: true,
        library: provider(library),
        projectRoot: project,
      });
      expect(checked).toMatchObject({
        applied: false,
        check: true,
        dryRun: true,
        exitCode: EXIT_CODES.conflict,
        wouldChange: true,
      });
      expect(await readBytes(project, 'skill-sync.lock.json')).toEqual(lockBefore);
      expect(await readBytes(project, '.codex/skills/alpha/SKILL.md')).toEqual(destinationBefore);

      const offline = provider(library, secondRevision, {
        freshness: 'offline-revision',
        stale: true,
        usableForMutation: true,
      });
      const applied = await syncProjectSkills({
        library: offline,
        offlineRevision: secondRevision,
        operationId: 'offline-apply',
        projectRoot: project,
        storage: storage(root),
      });
      expect(applied).toMatchObject({
        authoritative: false,
        exitCode: EXIT_CODES.success,
        freshness: 'offline-revision',
        stale: true,
      });
      expect(offline.requests).toEqual([
        { offlineRevision: secondRevision, purpose: 'application' },
      ]);
      expect(await sha256TreeDigest(join(project, '.codex', 'skills', 'alpha'))).toBe(
        advancedDigest,
      );
    });
  });
});
