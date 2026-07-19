import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GitClient,
  GitExecutionError,
  GitRemoteUrlError,
  normalizeGitRemote,
  redactGitCredentials,
  type GitProcessRunner,
} from '../../src/infrastructure/git.js';
import { withTempDirectory } from '../helpers/temp.js';

describe('Git remote normalization', () => {
  it('upgrades HTTP before use and creates a credential-free identity', () => {
    const remote = normalizeGitRemote('http://GitHub.com/Example/Skills.git');

    expect(remote).toEqual({
      identity: 'github.com/example/skills',
      host: 'github.com',
      owner: 'Example',
      repository: 'Skills',
      transport: 'https',
      cloneUrl: 'https://github.com/Example/Skills.git',
      upgradedFromHttp: true,
    });
  });

  it('normalizes HTTPS, ssh URL, and scp syntax to the same repository identity', () => {
    const https = normalizeGitRemote('https://github.com/example/skills');
    const ssh = normalizeGitRemote('ssh://git@github.com/example/skills.git');
    const scp = normalizeGitRemote('git@github.com:example/skills.git');

    expect(ssh.identity).toBe(https.identity);
    expect(scp.identity).toBe(https.identity);
    expect(ssh).toMatchObject({
      transport: 'ssh',
      cloneUrl: 'ssh://git@github.com/example/skills.git',
    });
    expect(scp).toMatchObject({
      transport: 'ssh',
      cloneUrl: 'git@github.com:example/skills.git',
    });
  });

  it('rejects embedded credentials without retaining them in the error', () => {
    const secret = 'super-secret-token';

    let error: unknown;
    try {
      normalizeGitRemote(`https://oauth:${secret}@github.com/example/skills.git`);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitRemoteUrlError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });

  it('redacts URL user information, query parameters, and common secret assignments', () => {
    const diagnostic =
      'fatal https://oauth:secret@github.com/example/skills.git?token=secret token=another';

    const redacted = redactGitCredentials(diagnostic);

    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('another');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).toContain('github.com/example/skills.git');
  });
});

describe('safe Git execution', () => {
  it('uses an executable and argument array while preserving external authentication', async () => {
    await withTempDirectory('skill-sync-git-runner-', async (directory) => {
      const calls: {
        executable: string;
        arguments_: readonly string[];
        environment: NodeJS.ProcessEnv;
      }[] = [];
      const runner: GitProcessRunner = (executable, arguments_, options) => {
        calls.push({ executable, arguments_, environment: options.env });
        return Promise.resolve({ stdout: 'ok\n', stderr: '' });
      };
      const client = new GitClient({
        processRunner: runner,
        safetyDirectory: join(directory, 'safety'),
        environment: {
          SSH_AUTH_SOCK: '/external/agent.sock',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/unsafe/hooks',
        },
      });
      const untrustedArgument = 'value; touch should-not-run';

      await client.run(['fetch', '--no-recurse-submodules', 'origin', untrustedArgument]);

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.executable).toBe('git');
      expect(call?.arguments_.at(-1)).toBe(untrustedArgument);
      expect(call?.arguments_).toContain('submodule.recurse=false');
      expect(call?.arguments_).toContain('fetch.recurseSubmodules=false');
      expect(call?.arguments_.some((argument) => argument.startsWith('core.hooksPath='))).toBe(
        true,
      );
      expect(call?.environment.SSH_AUTH_SOCK).toBe('/external/agent.sock');
      expect(call?.environment.GIT_CONFIG_COUNT).toBeUndefined();
      expect(call?.environment.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(call?.environment.GIT_CONFIG_VALUE_0).toBeUndefined();
    });
  });

  it('isolates system and global filters for content materialization', async () => {
    await withTempDirectory('skill-sync-git-content-', async (directory) => {
      let environment: NodeJS.ProcessEnv | undefined;
      const runner: GitProcessRunner = (_executable, _arguments, options) => {
        environment = options.env;
        return Promise.resolve({ stdout: '', stderr: '' });
      };
      const client = new GitClient({
        processRunner: runner,
        safetyDirectory: join(directory, 'safety'),
      });

      await client.run(['checkout', '--detach', 'deadbeef'], { profile: 'content' });

      expect(environment?.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(environment?.GIT_CONFIG_GLOBAL).toContain('global-empty.gitconfig');
      expect(environment?.GIT_LFS_SKIP_SMUDGE).toBe('1');
    });
  });

  it('refuses recursive submodules before spawning Git', async () => {
    let spawned = false;
    const runner: GitProcessRunner = () => {
      spawned = true;
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const client = new GitClient({ processRunner: runner });

    await expect(client.run(['submodule', 'update', '--init'])).rejects.toMatchObject({
      code: 'GIT_ARGUMENT_REJECTED',
    });
    await expect(client.run(['fetch', '--recurse-submodules=yes'])).rejects.toMatchObject({
      code: 'GIT_ARGUMENT_REJECTED',
    });
    expect(spawned).toBe(false);
  });

  it('redacts process failures in errors and serialized diagnostics', async () => {
    const secret = 'dependency-secret';
    const runner: GitProcessRunner = () =>
      Promise.reject(
        Object.assign(
          new Error(`fatal: https://oauth:${secret}@github.com/example/skills.git?token=${secret}`),
          {
            code: 128,
            stderr: `authorization=${secret}`,
            stdout: '',
          },
        ),
      );
    const client = new GitClient({ processRunner: runner });

    let error: unknown;
    try {
      await client.run(['fetch', 'origin']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GitExecutionError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
    expect(JSON.stringify(error)).toContain('[REDACTED]');
  });
});
