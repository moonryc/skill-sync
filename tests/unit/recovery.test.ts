import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inspectRecoveryState, recoveryWarningLines } from '../../src/application/recovery.js';
import { resolveApplicationPaths } from '../../src/infrastructure/config.js';
import {
  acquireAdvisoryLock,
  createOperationJournal,
} from '../../src/infrastructure/transactions.js';
import { withTempDirectory } from '../helpers/temp.js';

describe('startup recovery inspection', () => {
  it('detects locks, incomplete journals, and backups without changing them', async () =>
    withTempDirectory('skill-sync-recovery-', async (root) => {
      const env = { SKILL_SYNC_CONFIG_HOME: root };
      const paths = resolveApplicationPaths({ cwd: root, env });
      const lockPath = join(paths.locksDirectory, 'project.lock');
      const lock = await acquireAdvisoryLock(lockPath, {
        operationId: 'test-operation',
        now: new Date('2026-07-19T00:00:00.000Z'),
        pid: 123,
        hostname: 'test-host',
      });
      const journal = await createOperationJournal(paths.journalsDirectory, {
        kind: 'install',
        operationId: 'test-operation',
        now: new Date('2026-07-19T00:00:00.000Z'),
      });
      const backup = join(paths.backupsDirectory, 'backup-one');
      await mkdir(backup, { recursive: true });
      await writeFile(join(backup, 'backup.json'), '{}');
      const journalBefore = await readFile(journal.path, 'utf8');

      const inspection = await inspectRecoveryState(paths);
      expect(inspection.locks).toHaveLength(1);
      expect(inspection.journals).toHaveLength(1);
      expect(inspection.backups).toHaveLength(1);
      expect(recoveryWarningLines(inspection)[0]).toContain('Recovery state detected');
      expect(await readFile(journal.path, 'utf8')).toBe(journalBefore);

      await lock.release();
    }));

  it('reports clean missing state directories without creating them', async () =>
    withTempDirectory('skill-sync-recovery-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'absent') },
      });
      const inspection = await inspectRecoveryState(paths);
      expect(inspection).toMatchObject({ locks: [], journals: [], backups: [] });
      expect(recoveryWarningLines(inspection)).toEqual([]);
    }));
});
