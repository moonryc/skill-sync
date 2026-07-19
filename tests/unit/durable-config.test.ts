import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CredentialBearingUrlError,
  parseUserConfig,
  redactCredentials,
  resolveApplicationPaths,
  resolveConfiguration,
  writeUserConfig,
} from '../../src/infrastructure/config.js';
import { withTempDirectory } from '../helpers/temp.js';

const validConfig = {
  defaults: { gitignore: 'manage', targets: ['codex', 'claude'] },
  library: {
    branch: 'main',
    identity: 'github.com/acme/skills',
    remote: 'https://github.com/acme/skills.git',
    transport: 'https',
  },
  schemaVersion: 1,
} as const;

describe('durable user configuration', () => {
  it('resolves platform paths and makes the config-home override fully isolated', () => {
    expect(
      resolveApplicationPaths({
        env: {
          XDG_CACHE_HOME: '/xdg/cache',
          XDG_CONFIG_HOME: '/xdg/config',
          XDG_STATE_HOME: '/xdg/state',
        },
        homedir: '/home/person',
        platform: 'linux',
      }),
    ).toMatchObject({
      cacheDirectory: '/xdg/cache/skill-sync',
      configFile: '/xdg/config/skill-sync/config.json',
      stateDirectory: '/xdg/state/skill-sync',
    });

    expect(
      resolveApplicationPaths({
        cwd: '/workspace',
        env: { SKILL_SYNC_CONFIG_HOME: '.isolated' },
        homedir: '/home/person',
        platform: 'linux',
      }),
    ).toEqual({
      backupsDirectory: '/workspace/.isolated/state/backups',
      cacheDirectory: '/workspace/.isolated/cache',
      configDirectory: '/workspace/.isolated',
      configFile: '/workspace/.isolated/config.json',
      journalsDirectory: '/workspace/.isolated/state/journals',
      locksDirectory: '/workspace/.isolated/state/locks',
      stateDirectory: '/workspace/.isolated/state',
    });

    expect(
      resolveApplicationPaths({ env: {}, homedir: '/Users/person', platform: 'darwin' }).configFile,
    ).toBe('/Users/person/Library/Application Support/skill-sync/config.json');
    expect(
      resolveApplicationPaths({
        env: { APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' },
        homedir: 'C:\\Users\\person',
        platform: 'win32',
      }).configFile,
    ).toBe('C:\\Roaming\\skill-sync\\config.json');
  });

  it('applies CLI, environment, user, then built-in precedence', () => {
    const user = parseUserConfig(validConfig);
    const resolved = resolveConfiguration({
      cli: { branch: 'cli-branch', defaultTargets: ['claude'] },
      env: {
        SKILL_SYNC_BRANCH: 'env-branch',
        SKILL_SYNC_GITIGNORE: 'leave',
        SKILL_SYNC_TARGETS: 'codex',
        SKILL_SYNC_TRANSPORT: 'ssh',
      },
      user,
    });

    expect(resolved.value).toEqual({
      branch: 'cli-branch',
      defaultTargets: ['claude'],
      gitignore: 'leave',
      libraryUrl: 'https://github.com/acme/skills.git',
      transport: 'ssh',
    });
    expect(resolved.sources).toEqual({
      branch: 'cli',
      defaultTargets: 'cli',
      gitignore: 'environment',
      libraryUrl: 'user',
      transport: 'environment',
    });
    expect(user).toEqual(parseUserConfig(validConfig));
  });

  it('refuses embedded credentials and redacts dependency diagnostics', () => {
    const secret = 'super-secret-password';
    expect(() =>
      parseUserConfig({
        ...validConfig,
        library: {
          ...validConfig.library,
          remote: `https://person:${secret}@github.com/acme/skills.git`,
        },
      }),
    ).toThrow(/external Git authentication/u);

    expect(() =>
      resolveConfiguration({
        env: { SKILL_SYNC_LIBRARY: `https://person:${secret}@github.com/acme/skills.git` },
      }),
    ).toThrow(CredentialBearingUrlError);

    const diagnostic = redactCredentials(
      `fatal: https://person:${secret}@github.com/x/y?token=another-secret Authorization: Bearer ghp_1234567890abcdefghijkl`,
    );
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain('another-secret');
    expect(diagnostic).not.toContain('ghp_1234567890abcdefghijkl');
    expect(diagnostic.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it('validates before atomic stable persistence and preserves prior bytes on failure', async () => {
    await withTempDirectory('skill-sync-config-', async (root) => {
      const path = join(root, 'settings', 'config.json');
      await writeUserConfig(path, {
        ...validConfig,
        defaults: { gitignore: 'manage', targets: ['claude', 'codex', 'claude'] },
      });
      const original = await readFile(path, 'utf8');
      expect(original).toContain('"targets": [\n      "claude",\n      "codex"');

      await expect(
        writeUserConfig(path, { ...validConfig, unsupportedSecret: 'do-not-store' }),
      ).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(original);
      expect((await readdir(join(root, 'settings'))).sort()).toEqual(['config.json']);

      await writeFile(join(root, 'expected.json'), original);
    });
  });
});
