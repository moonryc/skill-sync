import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  GhCliRepositoryClient,
  LibraryLifecycleService,
  LibraryMutationCoordinator,
  type GitHubCreateRequest,
  type GitHubRepositoryPort,
  type LibraryConfigStore,
  type LibraryGitPort,
  type LibraryProjectStateStore,
} from '../../src/application/library-lifecycle.js';
import { validateSkillDirectory } from '../../src/domain/library.js';
import type { ProjectLock, ProjectManifest } from '../../src/domain/project-state.js';
import type { UserConfig } from '../../src/infrastructure/config.js';
import {
  GitClient,
  GitExecutionError,
  type GitProcessResult,
  type GitRunOptions,
  type NormalizedGitRemote,
} from '../../src/infrastructure/git.js';
import { LibraryCache } from '../../src/infrastructure/library-cache.js';
import { withTempDirectory } from '../helpers/temp.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync('git', [...arguments_], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'tests@skill-sync.invalid',
      GIT_AUTHOR_NAME: 'Skill Sync Tests',
      GIT_COMMITTER_EMAIL: 'tests@skill-sync.invalid',
      GIT_COMMITTER_NAME: 'Skill Sync Tests',
    },
  });
  return result.stdout;
}

async function createBareRemote(root: string, name: string): Promise<string> {
  const remote = join(root, `${name}.git`);
  await git(root, ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  return remote;
}

async function initializeLibrary(
  root: string,
  name: string,
): Promise<{
  readonly remote: string;
  readonly worktree: string;
}> {
  const remote = await createBareRemote(root, name);
  const worktree = join(root, `${name}-worktree`);
  await git(root, ['init', '--quiet', '--initial-branch=main', worktree]);
  await mkdir(join(worktree, '.skill-sync'), { recursive: true });
  await writeFile(join(worktree, '.skill-sync', 'library.json'), '{"schemaVersion":1}\n');
  await git(worktree, ['add', '.']);
  await git(worktree, ['commit', '--quiet', '-m', 'initialize']);
  await git(worktree, ['remote', 'add', 'origin', remote]);
  await git(worktree, ['push', '--quiet', '--set-upstream', 'origin', 'main']);
  return { remote, worktree };
}

async function initializeIncompatibleRemote(root: string, name: string): Promise<string> {
  const remote = await createBareRemote(root, name);
  const worktree = join(root, `${name}-worktree`);
  await git(root, ['init', '--quiet', '--initial-branch=main', worktree]);
  await writeFile(join(worktree, 'README.md'), 'not a library\n');
  await git(worktree, ['add', '.']);
  await git(worktree, ['commit', '--quiet', '-m', 'incompatible']);
  await git(worktree, ['remote', 'add', 'origin', remote]);
  await git(worktree, ['push', '--quiet', '--set-upstream', 'origin', 'main']);
  return remote;
}

async function writeSkill(root: string, name: string, body: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`,
  );
}

function localRemote(value: string): NormalizedGitRemote {
  const repository = basename(value)
    .replace(/\.git$/u, '')
    .replace(/[^a-z0-9-]/giu, '-');
  return {
    identity: `github.com/tests/${repository.toLowerCase()}`,
    host: 'github.com',
    owner: 'tests',
    repository,
    transport: 'https',
    cloneUrl: value,
    upgradedFromHttp: false,
  };
}

class MemoryConfigStore implements LibraryConfigStore {
  value: UserConfig | undefined;
  writes = 0;

  constructor(initial?: UserConfig) {
    this.value = initial;
  }

  read(): Promise<UserConfig | undefined> {
    return Promise.resolve(this.value);
  }

  replace(config: UserConfig | undefined): Promise<void> {
    this.value = config;
    this.writes += 1;
    return Promise.resolve();
  }
}

class MemoryProjectStateStore implements LibraryProjectStateStore {
  writes = 0;

  constructor(
    public manifest: ProjectManifest | undefined,
    public lock: ProjectLock | undefined,
  ) {}

  readManifest(): Promise<ProjectManifest | undefined> {
    return Promise.resolve(this.manifest);
  }

  readLock(): Promise<ProjectLock | undefined> {
    return Promise.resolve(this.lock);
  }

  writeLock(_projectRoot: string, lock: ProjectLock): Promise<void> {
    this.lock = lock;
    this.writes += 1;
    return Promise.resolve();
  }
}

function configuredLibrary(remote: string): UserConfig {
  const normalized = localRemote(remote);
  return {
    library: {
      branch: 'main',
      identity: normalized.identity,
      remote,
      transport: 'https',
    },
    schemaVersion: 1,
  };
}

function createHarness(
  root: string,
  config: MemoryConfigStore,
  options: {
    readonly github?: GitHubRepositoryPort;
    readonly projectState?: LibraryProjectStateStore;
    readonly git?: LibraryGitPort;
    readonly coordinatorHook?: ConstructorParameters<typeof LibraryMutationCoordinator>[0]['hooks'];
  } = {},
): {
  readonly service: LibraryLifecycleService;
  readonly cache: LibraryCache;
  readonly gitClient: GitClient;
} {
  const gitClient = new GitClient({ safetyDirectory: join(root, 'git-safety') });
  const cache = new LibraryCache({ rootDirectory: join(root, 'cache'), git: gitClient });
  const lifecycleGit = options.git ?? gitClient;
  const coordinator = new LibraryMutationCoordinator({
    git: lifecycleGit,
    cache,
    stagingRoot: join(root, 'staging'),
    ...(options.coordinatorHook === undefined ? {} : { hooks: options.coordinatorHook }),
  });
  const service = new LibraryLifecycleService({
    cache,
    config,
    coordinator,
    git: lifecycleGit,
    stagingRoot: join(root, 'staging'),
    normalizeRemote: localRemote,
    ...(options.github === undefined ? {} : { github: options.github }),
    ...(options.projectState === undefined ? {} : { projectState: options.projectState }),
  });
  return { service, cache, gitClient };
}

async function remoteHead(root: string, remote: string): Promise<string> {
  return (await git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).trim();
}

async function remoteFile(root: string, remote: string, path: string): Promise<string> {
  return await git(root, ['--git-dir', remote, 'show', `refs/heads/main:${path}`]);
}

describe('library initialization lifecycle', () => {
  it('requires confirmation for empty remotes, initializes safely, reconnects idempotently, and refuses incompatible remotes', async () => {
    await withTempDirectory('skill-sync-lifecycle-init-', async (root) => {
      const empty = await createBareRemote(root, 'empty');
      const config = new MemoryConfigStore();
      const { service } = createHarness(root, config);

      await expect(service.init({ url: empty, branch: 'main' })).rejects.toMatchObject({
        code: 'REMOTE_EMPTY_CONFIRMATION_REQUIRED',
      });
      expect(await git(root, ['--git-dir', empty, 'for-each-ref'])).toBe('');

      const initialized = await service.init({
        url: empty,
        branch: 'main',
        initializeEmpty: true,
      });
      expect(initialized).toMatchObject({ initialized: true, branch: 'main', changed: true });
      expect(await remoteFile(root, empty, '.skill-sync/library.json')).toContain(
        '"schemaVersion": 1',
      );

      const writesAfterInit = config.writes;
      const reconnected = await service.init({ url: empty, branch: 'main' });
      expect(reconnected).toMatchObject({ initialized: false, changed: false });
      expect(config.writes).toBe(writesAfterInit);
      const stagingEntriesBeforeCacheOnly = await readdir(join(root, 'staging'));
      const cacheOnlyRevision = await service.withValidatedLibrary(
        { cacheOnly: true },
        (snapshot) => {
          expect(snapshot).toMatchObject({ freshness: 'cache-only', stale: true });
          expect(snapshot.identity).toBe(localRemote(empty).identity);
          expect(snapshot.library.valid).toBe(true);
          return Promise.resolve(snapshot.revision);
        },
      );
      expect(cacheOnlyRevision).toBe(reconnected.revision);
      expect(await readdir(join(root, 'staging'))).toEqual(stagingEntriesBeforeCacheOnly);

      const incompatible = await initializeIncompatibleRemote(root, 'incompatible');
      const prior = config.value;
      const incompatibleHead = await remoteHead(root, incompatible);
      await expect(service.init({ url: incompatible, branch: 'main' })).rejects.toMatchObject({
        code: 'INCOMPATIBLE_LIBRARY',
      });
      expect(config.value).toEqual(prior);
      expect(await remoteHead(root, incompatible)).toBe(incompatibleHead);
    });
  });

  it('upgrades a GitHub HTTP URL before the first Git operation', async () => {
    const argumentsSeen: readonly string[][] = [];
    const gitPort: LibraryGitPort = {
      run: (arguments_) => {
        (argumentsSeen as string[][]).push([...arguments_]);
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    };
    const cache = {
      refresh: (): Promise<never> => Promise.reject(new Error('cache must not be reached')),
    };
    const service = new LibraryLifecycleService({
      cache,
      config: new MemoryConfigStore(),
      git: gitPort,
      stagingRoot: '/tmp/unused-skill-sync-staging',
    });

    await expect(
      service.init({ url: 'http://github.com/example/skills.git' }),
    ).rejects.toMatchObject({ code: 'REMOTE_EMPTY_CONFIRMATION_REQUIRED' });
    expect(argumentsSeen[0]).toContain('https://github.com/example/skills.git');
    expect(argumentsSeen[0]).not.toContain('http://github.com/example/skills.git');
  });
});

describe('GitHub creation lifecycle', () => {
  it('uses private visibility by default and leaves prior config unchanged when initialization fails', async () => {
    await withTempDirectory('skill-sync-lifecycle-create-', async (root) => {
      const successfulRemote = await createBareRemote(root, 'created');
      const createRequests: GitHubCreateRequest[] = [];
      const github: GitHubRepositoryPort = {
        createRepository: (request) => {
          createRequests.push(request);
          return Promise.resolve({ cloneUrl: successfulRemote });
        },
      };
      const config = new MemoryConfigStore();
      const { service } = createHarness(root, config, { github });
      await service.create({ repository: 'tests/created', branch: 'main' });
      expect(createRequests[0]?.visibility).toBe('private');
      expect(config.value?.library?.remote).toBe(successfulRemote);

      const failingRemote = await createBareRemote(root, 'push-fails');
      const prior = config.value;
      const baseGit = new GitClient({ safetyDirectory: join(root, 'failing-git-safety') });
      const failingGit: LibraryGitPort = {
        run: async (arguments_, options?: GitRunOptions): Promise<GitProcessResult> => {
          if (arguments_[0] === 'push') {
            throw new GitExecutionError({
              code: 'GIT_EXECUTION_FAILED',
              message: 'simulated push rejection',
              command: ['git', ...arguments_],
              exitCode: 1,
            });
          }
          return await baseGit.run(arguments_, options);
        },
      };
      const failingGithub: GitHubRepositoryPort = {
        createRepository: () => Promise.resolve({ cloneUrl: failingRemote }),
      };
      const failingHarness = createHarness(join(root, 'failure'), config, {
        github: failingGithub,
        git: failingGit,
      });
      await expect(
        failingHarness.service.create({ repository: 'tests/push-fails', branch: 'main' }),
      ).rejects.toBeInstanceOf(GitExecutionError);
      expect(config.value).toEqual(prior);
      expect(await git(root, ['--git-dir', failingRemote, 'for-each-ref'])).toBe('');
    });
  });

  it('uses argument arrays and refuses an existing repository through the gh adapter', async () => {
    const calls: readonly string[][] = [];
    const client = new GhCliRepositoryClient({
      processRunner: (_executable, arguments_) => {
        (calls as string[][]).push([...arguments_]);
        return Promise.resolve({ stdout: '{}\n', stderr: '' });
      },
    });

    await expect(
      client.createRepository({
        repository: 'tests/existing',
        transport: 'https',
        visibility: 'private',
      }),
    ).rejects.toMatchObject({ code: 'GITHUB_REPOSITORY_EXISTS' });
    expect(calls).toEqual([
      ['auth', 'status'],
      ['repo', 'view', 'tests/existing', '--json', 'nameWithOwner'],
    ]);
  });
});

describe('validated optimistic library mutations', () => {
  it('rolls back a rejected push without changing the remote or configured library', async () => {
    await withTempDirectory('skill-sync-lifecycle-push-rollback-', async (root) => {
      const fixture = await initializeLibrary(root, 'push-rollback');
      const config = new MemoryConfigStore(configuredLibrary(fixture.remote));
      const baseGit = new GitClient({ safetyDirectory: join(root, 'failing-git-safety') });
      let rejectedPushes = 0;
      const failingGit: LibraryGitPort = {
        run: async (arguments_, options): Promise<GitProcessResult> => {
          if (arguments_[0] === 'push') {
            rejectedPushes += 1;
            throw new GitExecutionError({
              code: 'GIT_EXECUTION_FAILED',
              message: 'simulated push rejection',
              command: ['git', ...arguments_],
              exitCode: 1,
            });
          }
          return await baseGit.run(arguments_, options);
        },
      };
      const { service } = createHarness(root, config, { git: failingGit });
      const source = join(root, 'review-ui');
      await writeSkill(source, 'review-ui', '# Candidate content');
      const headBefore = await remoteHead(root, fixture.remote);
      const configBefore = config.value;

      await expect(service.add({ sourcePath: source, group: 'frontend' })).rejects.toMatchObject({
        code: 'GIT_EXECUTION_FAILED',
      });

      expect(rejectedPushes).toBe(1);
      expect(await remoteHead(root, fixture.remote)).toBe(headBefore);
      await expect(
        remoteFile(root, fixture.remote, 'skills/frontend/review-ui/SKILL.md'),
      ).rejects.toThrow();
      expect(config.value).toEqual(configBefore);
      expect(config.writes).toBe(0);
      expect(await readdir(join(root, 'staging'))).toEqual([]);
    });
  });

  it('retries an unrelated remote advance and preserves both changes', async () => {
    await withTempDirectory('skill-sync-lifecycle-race-', async (root) => {
      const fixture = await initializeLibrary(root, 'race');
      const config = new MemoryConfigStore(configuredLibrary(fixture.remote));
      let raced = false;
      const { service } = createHarness(root, config, {
        coordinatorHook: {
          beforePush: async ({ attempt }) => {
            if (attempt !== 0 || raced) return;
            raced = true;
            await writeFile(
              join(fixture.worktree, '.skill-sync', 'library.json'),
              '{"schemaVersion":1,"settings":{"raced":true}}\n',
            );
            await git(fixture.worktree, ['add', '.skill-sync/library.json']);
            await git(fixture.worktree, ['commit', '--quiet', '-m', 'unrelated race']);
            await git(fixture.worktree, ['push', '--quiet', 'origin', 'main']);
          },
        },
      });

      await service.groupCreate({ group: 'frontend' });

      expect(await remoteFile(root, fixture.remote, '.skill-sync/library.json')).toContain('raced');
      expect(
        await remoteFile(root, fixture.remote, 'skills/frontend/.skill-sync-group.json'),
      ).toContain('schemaVersion');
      expect(await git(root, ['--git-dir', fixture.remote, 'rev-list', '--count', 'main'])).toBe(
        '3\n',
      );
    });
  });

  it('refuses to retry when a remote advance changes a touched path', async () => {
    await withTempDirectory('skill-sync-lifecycle-divergence-', async (root) => {
      const fixture = await initializeLibrary(root, 'divergence');
      const config = new MemoryConfigStore(configuredLibrary(fixture.remote));
      let raced = false;
      const { service } = createHarness(root, config, {
        coordinatorHook: {
          beforePush: async ({ attempt }) => {
            if (attempt !== 0 || raced) return;
            raced = true;
            await mkdir(join(fixture.worktree, 'skills', 'frontend'), { recursive: true });
            await writeFile(
              join(fixture.worktree, 'skills', 'frontend', '.skill-sync-group.json'),
              '{"description":"remote winner"}\n',
            );
            await git(fixture.worktree, ['add', '.']);
            await git(fixture.worktree, ['commit', '--quiet', '-m', 'touch same group']);
            await git(fixture.worktree, ['push', '--quiet', 'origin', 'main']);
          },
        },
      });

      await expect(service.groupCreate({ group: 'frontend' })).rejects.toMatchObject({
        code: 'LIBRARY_DIVERGED',
      });
      expect(
        await remoteFile(root, fixture.remote, 'skills/frontend/.skill-sync-group.json'),
      ).toContain('remote winner');
      expect(await git(root, ['--git-dir', fixture.remote, 'rev-list', '--count', 'main'])).toBe(
        '2\n',
      );
    });
  });

  it('adds grouped skills, manages group paths, and protects nonempty removal', async () => {
    await withTempDirectory('skill-sync-lifecycle-groups-', async (root) => {
      const fixture = await initializeLibrary(root, 'groups');
      const config = new MemoryConfigStore(configuredLibrary(fixture.remote));
      const { service } = createHarness(root, config);
      const source = join(root, 'review-ui');
      await writeSkill(source, 'review-ui', '# Initial review');

      const beforeAddPreview = await remoteHead(root, fixture.remote);
      const addPreview = await service.add({
        sourcePath: source,
        group: 'frontend',
        dryRun: true,
      });
      expect(addPreview).toMatchObject({ changed: true, dryRun: true });
      expect(await remoteHead(root, fixture.remote)).toBe(beforeAddPreview);
      const added = await service.add({ sourcePath: source, group: 'frontend' });
      expect(added.id).toBe('frontend/review-ui');
      expect(
        await remoteFile(root, fixture.remote, 'skills/frontend/review-ui/SKILL.md'),
      ).toContain('# Initial review');
      await expect(service.add({ sourcePath: source, group: 'frontend' })).rejects.toMatchObject({
        code: 'SKILL_EXISTS',
      });

      const beforeGroupPreview = await remoteHead(root, fixture.remote);
      const groupPreview = await service.groupCreate({
        group: 'frontend/react',
        description: 'React skills',
        dryRun: true,
      });
      expect(groupPreview).toMatchObject({ changed: true, dryRun: true });
      expect(await remoteHead(root, fixture.remote)).toBe(beforeGroupPreview);
      await service.groupCreate({ group: 'frontend/react', description: 'React skills' });
      expect(await service.groupList()).toEqual(
        expect.arrayContaining([
          { path: 'frontend', description: null },
          { path: 'frontend/react', description: 'React skills' },
        ]),
      );
      const beforeRenamePreview = await remoteHead(root, fixture.remote);
      const renamePreview = await service.groupRename({
        from: 'frontend',
        to: 'engineering',
        dryRun: true,
      });
      expect(renamePreview.affectedIds).toContain('frontend/review-ui -> engineering/review-ui');
      expect(renamePreview.warning).toContain('orphaned');
      expect(await remoteHead(root, fixture.remote)).toBe(beforeRenamePreview);
      const renamed = await service.groupRename({ from: 'frontend', to: 'engineering' });
      expect(renamed.affectedIds).toContain('frontend/review-ui -> engineering/review-ui');
      expect(
        await remoteFile(root, fixture.remote, 'skills/engineering/review-ui/SKILL.md'),
      ).toContain('# Initial review');

      await expect(
        service.groupRemove({ group: 'engineering', confirmed: true }),
      ).rejects.toMatchObject({ code: 'GROUP_NOT_EMPTY' });
      const removePreview = await service.groupRemove({
        group: 'engineering',
        confirmed: false,
        dryRun: true,
      });
      expect(removePreview).toMatchObject({ dryRun: true, requiresRecursive: true });
      const removed = await service.groupRemove({
        group: 'engineering',
        confirmed: true,
        recursive: true,
      });
      expect(removed.affectedIds).toContain('engineering/review-ui');
      expect(removed.warning).toContain('orphaned');
      await expect(
        remoteFile(root, fixture.remote, 'skills/engineering/review-ui/SKILL.md'),
      ).rejects.toThrow();
    });
  });
});

describe('publication and canonical deletion', () => {
  it('requires a source for divergent targets, checks the recorded base, updates project state, and never uninstalls on library remove', async () => {
    await withTempDirectory('skill-sync-lifecycle-publish-', async (root) => {
      const fixture = await initializeLibrary(root, 'publish');
      const config = new MemoryConfigStore(configuredLibrary(fixture.remote));
      const projectRoot = join(root, 'project');
      const codex = join(projectRoot, '.codex', 'skills', 'review-ui');
      const claude = join(projectRoot, '.claude', 'skills', 'review-ui');
      const source = join(root, 'review-ui');
      await writeSkill(source, 'review-ui', '# Base');
      await writeSkill(codex, 'review-ui', '# Base');
      await writeSkill(claude, 'review-ui', '# Base');

      const baseHarness = createHarness(root, config);
      const added = await baseHarness.service.add({ sourcePath: source, group: 'frontend' });
      const baseValidation = await validateSkillDirectory(source, 'frontend/review-ui');
      if (baseValidation.skill === null) throw new Error('Invalid publication fixture.');
      const baseDigest = baseValidation.skill.digest;
      const manifest: ProjectManifest = {
        gitignore: 'unmanaged',
        library: { identity: localRemote(fixture.remote).identity },
        schemaVersion: 1,
        skills: [
          {
            id: 'frontend/review-ui',
            projections: [
              { target: 'codex', destination: '.codex/skills/review-ui' },
              { target: 'claude', destination: '.claude/skills/review-ui' },
            ],
          },
        ],
      };
      const lock: ProjectLock = {
        library: { identity: localRemote(fixture.remote).identity, revision: added.revision },
        schemaVersion: 1,
        skills: [
          {
            id: 'frontend/review-ui',
            baseDigest,
            canonicalDigest: baseDigest,
            projections: [
              { target: 'codex', destination: '.codex/skills/review-ui', digest: baseDigest },
              { target: 'claude', destination: '.claude/skills/review-ui', digest: baseDigest },
            ],
          },
        ],
      };
      const projectState = new MemoryProjectStateStore(manifest, lock);
      const { service } = createHarness(join(root, 'publication-harness'), config, {
        projectState,
      });
      await writeSkill(codex, 'review-ui', '# Codex publication');
      await writeSkill(claude, 'review-ui', '# Claude publication');

      await expect(
        service.publish({ ids: ['frontend/review-ui'], projectRoot }),
      ).rejects.toMatchObject({ code: 'DIVERGENT_TARGETS' });
      const beforePublishPreview = await remoteHead(root, fixture.remote);
      const publishPreview = await service.publish({
        ids: ['frontend/review-ui'],
        projectRoot,
        fromTarget: 'codex',
        dryRun: true,
      });
      expect(publishPreview).toMatchObject({
        changed: true,
        dryRun: true,
        projectStateUpdated: false,
      });
      expect(publishPreview.skills[0]).toMatchObject({ changed: true, previousDigest: baseDigest });
      expect(publishPreview.skills[0]?.diff.modified).toContain('SKILL.md');
      expect(projectState.writes).toBe(0);
      expect(await remoteHead(root, fixture.remote)).toBe(beforePublishPreview);
      const published = await service.publish({
        ids: ['frontend/review-ui'],
        projectRoot,
        fromTarget: 'codex',
      });
      expect(published).toMatchObject({ changed: true, projectStateUpdated: true });
      expect(
        await remoteFile(root, fixture.remote, 'skills/frontend/review-ui/SKILL.md'),
      ).toContain('# Codex publication');
      expect(projectState.writes).toBe(1);
      expect(projectState.lock?.library.revision).toBe(published.revision);
      expect(projectState.lock?.skills[0]?.baseDigest).toBe(published.skills[0]?.digest);

      const external = join(root, 'external-publisher');
      await git(root, ['clone', '--quiet', '--branch', 'main', fixture.remote, external]);
      await writeSkill(
        join(external, 'skills', 'frontend', 'review-ui'),
        'review-ui',
        '# Remote divergence',
      );
      await git(external, ['add', '.']);
      await git(external, ['commit', '--quiet', '-m', 'remote divergence']);
      await git(external, ['push', '--quiet', 'origin', 'main']);
      await writeSkill(codex, 'review-ui', '# Another local publication');
      await writeSkill(claude, 'review-ui', '# Another local publication');
      await expect(
        service.publish({ ids: ['frontend/review-ui'], projectRoot }),
      ).rejects.toMatchObject({ code: 'REMOTE_BASE_DIVERGED' });

      const writesBeforeRemove = projectState.writes;
      const beforeRemovePreview = await remoteHead(root, fixture.remote);
      const removalPreview = await service.libraryRemove({
        id: 'frontend/review-ui',
        confirmed: false,
        dryRun: true,
      });
      expect(removalPreview).toMatchObject({ changed: true, dryRun: true });
      expect(projectState.writes).toBe(writesBeforeRemove);
      expect(await remoteHead(root, fixture.remote)).toBe(beforeRemovePreview);
      const removal = await service.libraryRemove({
        id: 'frontend/review-ui',
        confirmed: true,
      });
      expect(removal.warning).toContain('not uninstalled');
      expect(projectState.writes).toBe(writesBeforeRemove);
      expect(await readFile(join(codex, 'SKILL.md'), 'utf8')).toContain(
        '# Another local publication',
      );
      await expect(
        remoteFile(root, fixture.remote, 'skills/frontend/review-ui/SKILL.md'),
      ).rejects.toThrow();
    });
  });
});
