import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { type NormalizedGitRemote } from '../../src/infrastructure/git.js';
import {
  LibraryCache,
  LibraryCacheError,
  type LibraryCacheLock,
} from '../../src/infrastructure/library-cache.js';
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

async function createRemote(root: string): Promise<{
  readonly bare: string;
  readonly worktree: string;
  readonly revision: string;
}> {
  const bare = join(root, 'remote.git');
  const worktree = join(root, 'worktree');
  await mkdir(bare, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await git(root, ['init', '--bare', '--quiet', bare]);
  await git(root, ['init', '--quiet', '--initial-branch=main', worktree]);
  await writeFile(join(worktree, 'README.md'), 'first\n');
  await git(worktree, ['add', 'README.md']);
  await git(worktree, ['commit', '--quiet', '-m', 'first']);
  await git(worktree, ['remote', 'add', 'origin', bare]);
  await git(worktree, ['push', '--quiet', '--set-upstream', 'origin', 'main']);
  await git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { bare, worktree, revision: (await git(worktree, ['rev-parse', 'HEAD'])).trim() };
}

function localRemote(cloneUrl: string): NormalizedGitRemote {
  return {
    identity: 'github.com/example/skills',
    host: 'github.com',
    owner: 'example',
    repository: 'skills',
    transport: 'https',
    cloneUrl,
    upgradedFromHttp: false,
  };
}

describe('library cache', () => {
  it('locks refresh, discovers the default branch, and returns the exact fetched commit', async () => {
    await withTempDirectory('skill-sync-cache-', async (directory) => {
      const fixture = await createRemote(directory);
      const lockKeys: string[] = [];
      const withLock: LibraryCacheLock = async (key, operation) => {
        lockKeys.push(key);
        return await operation();
      };
      const cache = new LibraryCache({
        rootDirectory: join(directory, 'cache'),
        withLock,
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      });

      const result = await cache.refresh({
        remote: localRemote(fixture.bare),
        access: 'read-only',
      });

      expect(lockKeys).toHaveLength(1);
      expect(lockKeys[0]).toMatch(/^[a-f0-9]{64}$/u);
      expect(result).toMatchObject({
        branch: 'main',
        revision: fixture.revision,
        freshness: 'fetched',
        stale: false,
        usableForMutation: true,
        refreshedAt: '2026-07-19T00:00:00.000Z',
      });
    });
  });

  it('refreshes a configured branch to its new exact revision', async () => {
    await withTempDirectory('skill-sync-cache-refresh-', async (directory) => {
      const fixture = await createRemote(directory);
      const cache = new LibraryCache({ rootDirectory: join(directory, 'cache') });
      const remote = localRemote(fixture.bare);

      const first = await cache.refresh({ remote, branch: 'main', access: 'mutation' });
      await writeFile(join(fixture.worktree, 'README.md'), 'second\n');
      await git(fixture.worktree, ['add', 'README.md']);
      await git(fixture.worktree, ['commit', '--quiet', '-m', 'second']);
      await git(fixture.worktree, ['push', '--quiet', 'origin', 'main']);
      const expectedRevision = (await git(fixture.worktree, ['rev-parse', 'HEAD'])).trim();

      const second = await cache.refresh({ remote, branch: 'main', access: 'mutation' });

      expect(second.revision).toBe(expectedRevision);
      expect(second.revision).not.toBe(first.revision);
      expect(second.branch).toBe('main');
      expect(second.freshness).toBe('fetched');
    });
  });

  it('uses a clearly marked read-only stale result but never falls back for mutation', async () => {
    await withTempDirectory('skill-sync-cache-stale-', async (directory) => {
      const fixture = await createRemote(directory);
      const cache = new LibraryCache({ rootDirectory: join(directory, 'cache') });
      const available = localRemote(fixture.bare);
      const first = await cache.refresh({ remote: available, access: 'read-only' });
      const unavailable = localRemote(join(directory, 'missing-remote.git'));

      const stale = await cache.refresh({
        remote: unavailable,
        access: 'read-only',
        allowStale: true,
      });

      expect(stale).toMatchObject({
        revision: first.revision,
        branch: 'main',
        freshness: 'stale-cache',
        stale: true,
        usableForMutation: false,
        warning: { code: 'STALE_CACHE' },
      });
      expect(stale.warning?.message).toContain('must not be reported as current');

      await expect(
        cache.refresh({ remote: unavailable, access: 'mutation' }),
      ).rejects.toMatchObject({ code: 'REMOTE_REFRESH_FAILED' });
    });
  });

  it('resolves only an explicitly requested exact cached revision without network access', async () => {
    await withTempDirectory('skill-sync-cache-offline-', async (directory) => {
      const fixture = await createRemote(directory);
      const cache = new LibraryCache({ rootDirectory: join(directory, 'cache') });
      const available = localRemote(fixture.bare);
      const fetched = await cache.refresh({
        remote: available,
        branch: 'main',
        access: 'mutation',
      });
      const unavailable = localRemote(join(directory, 'missing-remote.git'));

      const offline = await cache.refresh({
        remote: unavailable,
        branch: 'main',
        access: 'mutation',
        offlineRevision: fetched.revision,
      });

      expect(offline).toMatchObject({
        revision: fetched.revision,
        freshness: 'offline-revision',
        stale: true,
        usableForMutation: true,
        warning: { code: 'OFFLINE_REVISION' },
      });
      await expect(
        cache.refresh({
          remote: unavailable,
          access: 'read-only',
          offlineRevision: 'deadbeef',
        }),
      ).rejects.toBeInstanceOf(LibraryCacheError);
    });
  });

  it('inspects only a verified existing cache without creating or updating cache files', async () => {
    await withTempDirectory('skill-sync-cache-inspect-', async (directory) => {
      const fixture = await createRemote(directory);
      const cacheRoot = join(directory, 'cache');
      const cache = new LibraryCache({ rootDirectory: cacheRoot });
      const remote = localRemote(fixture.bare);

      await expect(cache.inspect({ remote, branch: 'main' })).rejects.toMatchObject({
        code: 'STALE_CACHE_UNAVAILABLE',
      });
      await expect(readdir(cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' });

      const fetched = await cache.refresh({ remote, branch: 'main', access: 'read-only' });
      const statePath = join(fetched.repositoryDirectory, '..', 'state.json');
      const beforeState = await readFile(statePath, 'utf8');
      const beforeEntries = await readdir(join(fetched.repositoryDirectory, '..'));
      const inspected = await cache.inspect({ remote, branch: 'main' });

      expect(inspected).toMatchObject({
        revision: fetched.revision,
        freshness: 'cache-only',
        stale: true,
        usableForMutation: false,
        warning: { code: 'CACHE_ONLY' },
      });
      expect(await readFile(statePath, 'utf8')).toBe(beforeState);
      expect(await readdir(join(fetched.repositoryDirectory, '..'))).toEqual(beforeEntries);
    });
  });

  it('rejects a cache-only snapshot whose files no longer match its Git-bound digest', async () => {
    await withTempDirectory('skill-sync-cache-tamper-', async (directory) => {
      const fixture = await createRemote(directory);
      const cache = new LibraryCache({ rootDirectory: join(directory, 'cache') });
      const remote = localRemote(fixture.bare);
      const fetched = await cache.refresh({ remote, branch: 'main', access: 'read-only' });
      if (fetched.treeDirectory === undefined) throw new Error('Expected a materialized snapshot.');
      const statePath = join(fetched.repositoryDirectory, '..', 'state.json');
      const stateBefore = await readFile(statePath, 'utf8');

      await writeFile(join(fetched.treeDirectory, 'README.md'), 'locally tampered\n');

      await expect(cache.inspect({ remote, branch: 'main' })).rejects.toMatchObject({
        code: 'INVALID_CACHE',
      });
      expect(await readFile(statePath, 'utf8')).toBe(stateBefore);
    });
  });
});
