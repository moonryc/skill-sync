import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  LibraryLifecycleService,
  type LibraryConfigStore,
} from '../../src/application/library-lifecycle.js';
import {
  installProjectSkills,
  type ProjectMutationStorage,
} from '../../src/application/project-installation.js';
import { inspectRegularFileTree, sha256TreeDigest } from '../../src/domain/digest.js';
import type { UserConfig } from '../../src/infrastructure/config.js';
import { GitClient, type NormalizedGitRemote } from '../../src/infrastructure/git.js';
import { LibraryCache } from '../../src/infrastructure/library-cache.js';
import { readProjectLock, readProjectManifest } from '../../src/infrastructure/project-state.js';
import { withTempDirectory } from '../helpers/temp.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface SkillBytes {
  readonly bytes: Buffer;
  readonly path: string;
}

class MemoryConfigStore implements LibraryConfigStore {
  value: UserConfig | undefined;

  read(): Promise<UserConfig | undefined> {
    return Promise.resolve(this.value);
  }

  replace(config: UserConfig | undefined): Promise<void> {
    this.value = config;
    return Promise.resolve();
  }
}

function localRemote(path: string): NormalizedGitRemote {
  return {
    cloneUrl: path,
    host: 'github.com',
    identity: 'github.com/skill-sync-tests/private-openspec-library',
    owner: 'skill-sync-tests',
    repository: 'private-openspec-library',
    transport: 'ssh',
    upgradedFromHttp: false,
  };
}

function projectStorage(root: string): ProjectMutationStorage {
  const runtime = join(root, 'project-runtime');
  return {
    backupRoot: join(runtime, 'backups'),
    journalDirectory: join(runtime, 'journals'),
    lockPath: join(runtime, 'locks', 'project.lock'),
    stagingRoot: join(runtime, 'staging'),
  };
}

async function snapshotOpenSpecSkillBytes(skillsRoot: string): Promise<readonly SkillBytes[]> {
  const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('openspec-'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const snapshot: SkillBytes[] = [];

  for (const skillDirectory of skillDirectories) {
    const skillRoot = join(skillsRoot, skillDirectory);
    const tree = await inspectRegularFileTree(skillRoot, { rejectNestedSkillRoots: true });
    for (const file of tree.files) {
      snapshot.push({
        bytes: await readFile(join(skillRoot, ...file.relativePath.split('/'))),
        path: `${skillDirectory}/${file.relativePath}`,
      });
    }
  }

  return snapshot;
}

async function createPrivateBareRemote(root: string): Promise<string> {
  const remote = join(root, 'private-openspec-library.git');
  await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote], {
    cwd: root,
  });
  await chmod(remote, 0o700);
  return remote;
}

describe('OpenSpec skill dogfood workflow', () => {
  it('groups the existing skills in a private fixture library and installs copies without adopting the repository sources', async () => {
    const codexSources = join(repositoryRoot, '.codex', 'skills');
    const claudeSources = join(repositoryRoot, '.claude', 'skills');
    const codexBefore = await snapshotOpenSpecSkillBytes(codexSources);
    const claudeBefore = await snapshotOpenSpecSkillBytes(claudeSources);
    expect(codexBefore.map(({ path }) => path)).toEqual(claudeBefore.map(({ path }) => path));
    const sourceNames = [
      ...new Set(
        codexBefore.map(({ path }) => {
          const sourceName = path.split('/')[0];
          if (sourceName === undefined) throw new Error('OpenSpec source has no directory name.');
          return sourceName;
        }),
      ),
    ];
    expect(sourceNames).toHaveLength(5);

    await withTempDirectory('skill-sync-openspec-dogfood-', async (root) => {
      const remote = await createPrivateBareRemote(root);
      const git = new GitClient({ safetyDirectory: join(root, 'git-safety') });
      const cache = new LibraryCache({ rootDirectory: join(root, 'cache'), git });
      const config = new MemoryConfigStore();
      const service = new LibraryLifecycleService({
        cache,
        config,
        git,
        normalizeRemote: localRemote,
        stagingRoot: join(root, 'library-staging'),
      });

      const initialized = await service.init({
        branch: 'main',
        initializeEmpty: true,
        url: remote,
      });
      expect(initialized).toMatchObject({ initialized: true, changed: true });

      await service.groupCreate({
        description: 'OpenSpec workflows used to dogfood skill-sync',
        group: 'workflows/openspec',
      });

      for (const sourceName of sourceNames) {
        await service.add({
          group: 'workflows/openspec',
          sourcePath: join(codexSources, sourceName),
        });
      }

      const projectRoot = join(root, 'consumer-project');
      await mkdir(projectRoot);
      const installation = await service.withValidatedLibrary({}, async (snapshot) => {
        const expectedIds = sourceNames.map((name) => `workflows/openspec/${name}`);
        expect(snapshot.identity).toBe(localRemote(remote).identity);
        expect(snapshot.library.groups.map((group) => group.path)).toEqual([
          'workflows',
          'workflows/openspec',
        ]);
        expect(snapshot.library.skills.map((skill) => skill.id)).toEqual(expectedIds);

        const selected = snapshot.library.skills.map(({ digest, id, name, rootPath }) => ({
          digest,
          id,
          name,
          rootPath,
        }));
        const plan = await installProjectSkills({
          gitignore: 'unmanaged',
          libraryIdentity: snapshot.identity,
          libraryRevision: snapshot.revision,
          operationId: 'dogfood-openspec-install',
          projectRoot,
          skills: selected,
          storage: projectStorage(root),
          targets: ['codex', 'claude'],
        });
        return { plan, revision: snapshot.revision, selected };
      });

      expect(installation.plan).toMatchObject({ applied: true, operation: 'install' });
      expect(installation.plan.skills).toHaveLength(5);
      for (const skill of installation.selected) {
        for (const target of ['codex', 'claude'] as const) {
          const destination = join(projectRoot, `.${target}`, 'skills', skill.name);
          expect(await sha256TreeDigest(destination, { rejectNestedSkillRoots: true })).toBe(
            skill.digest,
          );
          expect(await readFile(join(destination, 'SKILL.md'))).toEqual(
            await readFile(join(codexSources, skill.name, 'SKILL.md')),
          );
        }
      }

      const manifest = await readProjectManifest(projectRoot);
      const lock = await readProjectLock(projectRoot);
      expect(manifest?.skills.map((skill) => skill.id)).toEqual(
        installation.selected.map((skill) => skill.id),
      );
      expect(
        manifest?.skills.every(
          (skill) =>
            skill.projections.map((projection) => projection.target).join(',') === 'claude,codex',
        ),
      ).toBe(true);
      expect(lock?.library).toEqual({
        identity: localRemote(remote).identity,
        revision: installation.revision,
      });
    });

    expect(await snapshotOpenSpecSkillBytes(codexSources)).toEqual(codexBefore);
    expect(await snapshotOpenSpecSkillBytes(claudeSources)).toEqual(claudeBefore);
  });
});
