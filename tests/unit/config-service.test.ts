import { describe, expect, it } from 'vitest';

import { ConfigService } from '../../src/application/config-service.js';
import { resolveApplicationPaths } from '../../src/infrastructure/config.js';
import { withTempDirectory } from '../helpers/temp.js';

describe('ConfigService', () => {
  it('sets, lists, gets, and unsets supported values atomically', async () =>
    withTempDirectory('skill-sync-config-service-', async (root) => {
      const env = { SKILL_SYNC_CONFIG_HOME: root };
      const service = new ConfigService(env, resolveApplicationPaths({ cwd: root, env }));
      await service.set('library.remote', 'http://github.com/example/skills.git');
      await service.set('library.branch', 'stable');
      await service.set('defaults.targets', 'claude,codex,claude');
      await service.set('defaults.gitignore', 'manage');

      expect(await service.get('library.remote')).toBe('https://github.com/example/skills.git');
      expect(await service.get('defaults.targets')).toEqual(['claude', 'codex']);
      const listing = await service.list();
      expect(listing.effective.value).toMatchObject({ branch: 'stable', gitignore: 'manage' });

      await service.unset('library.branch');
      expect(await service.get('library.branch')).toBeUndefined();
    }));

  it('rejects unknown keys, invalid values, and credential URLs without changing config', async () =>
    withTempDirectory('skill-sync-config-service-', async (root) => {
      const env = { SKILL_SYNC_CONFIG_HOME: root };
      const service = new ConfigService(env, resolveApplicationPaths({ cwd: root, env }));
      await expect(service.set('unknown', 'value')).rejects.toThrow(/Unsupported/);
      await expect(service.set('defaults.targets', 'cursor')).rejects.toThrow(/codex or claude/);
      await expect(
        service.set('library.remote', 'https://user:secret@github.com/example/skills.git'),
      ).rejects.toThrow(/credentials/i);
      expect((await service.read()).schemaVersion).toBe(1);
    }));

  it('uses explicit environment values only in the effective layer', async () =>
    withTempDirectory('skill-sync-config-service-', async (root) => {
      const env = { SKILL_SYNC_CONFIG_HOME: root, SKILL_SYNC_GITIGNORE: 'manage' };
      const service = new ConfigService(env, resolveApplicationPaths({ cwd: root, env }));
      const listing = await service.list();
      expect(listing.configured['defaults.gitignore']).toBeUndefined();
      expect(listing.effective.value.gitignore).toBe('manage');
      expect(listing.effective.sources.gitignore).toBe('environment');
    }));
});
