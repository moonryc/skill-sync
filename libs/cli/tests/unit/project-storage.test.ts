import { basename } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectMutationStorage } from '../../src/application/project-storage.js';
import type { ApplicationPaths } from '../../src/infrastructure/config.js';

const paths: ApplicationPaths = {
  backupsDirectory: '/state/backups',
  cacheDirectory: '/cache',
  configDirectory: '/config',
  configFile: '/config/config.json',
  journalsDirectory: '/state/journals',
  locksDirectory: '/state/locks',
  stateDirectory: '/state',
};

describe('project mutation storage', () => {
  it('is deterministic, project-specific, and does not expose a project path', () => {
    const first = projectMutationStorage(paths, '/work/acme/private-project');
    const repeated = projectMutationStorage(paths, '/work/acme/private-project');
    const second = projectMutationStorage(paths, '/work/acme/other-project');

    expect(first).toEqual(repeated);
    expect(second).not.toEqual(first);
    expect(JSON.stringify(first)).not.toContain('private-project');
    expect(basename(first.lockPath)).toMatch(/^project-[a-f0-9]{64}\.lock$/u);
  });
});
