import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  applyRecoveryUnlock,
  listRecoveryRecords,
  planRecoveryUnlock,
} from '../../src/application/recovery.js';
import { resolveApplicationPaths } from '../../src/infrastructure/config.js';
import { acquireAdvisoryLock } from '../../src/infrastructure/transactions.js';
import { withTempDirectory } from '../helpers/temp.js';

const execFileAsync = promisify(execFile);

describe('cross-process filesystem lock', () => {
  it('preserves a crashed process lock and blocks a later process', async () =>
    withTempDirectory('skill-sync-cross-process-lock-', async (root) => {
      const lockPath = join(root, 'locks', 'project.lock');
      const script = `
        import { mkdir, open, utimes } from 'node:fs/promises';
        import { dirname } from 'node:path';
        import { randomUUID } from 'node:crypto';
        const path = process.argv[1];
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({
          createdAt: '2026-01-01T00:00:00.000Z',
          hostname: 'crashed-child',
          operationId: 'child-operation',
          ownerToken: randomUUID(),
          pid: process.pid,
          schemaVersion: 1,
          scope: { id: 'project-child', kind: 'project' }
        }));
        await handle.sync();
        await handle.close();
        const lastHeartbeat = new Date('2026-01-01T00:00:00.000Z');
        await utimes(path, lastHeartbeat, lastHeartbeat);
      `;
      await execFileAsync(process.execPath, ['--input-type=module', '-e', script, lockPath]);

      await expect(
        acquireAdvisoryLock(lockPath, {
          now: new Date('2026-01-03T00:00:00.000Z'),
          operationId: 'parent-operation',
          staleAfterMs: 1_000,
        }),
      ).rejects.toMatchObject({
        owner: {
          hostname: 'crashed-child',
          operationId: 'child-operation',
          scope: { id: 'project-child', kind: 'project' },
        },
        stale: true,
      });
      expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({
        operationId: 'child-operation',
      });
    }));

  it('refuses a live local owner and unlocks the exact crash-left lock after it exits', async () =>
    withTempDirectory('skill-sync-cross-process-unlock-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
      });
      const lockPath = join(paths.locksDirectory, 'project-child.lock');
      const script = `
        import { randomUUID } from 'node:crypto';
        import { mkdir, open, utimes } from 'node:fs/promises';
        import { hostname } from 'node:os';
        import { dirname } from 'node:path';
        const path = process.argv[1];
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(path, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          hostname: hostname(),
          operationId: 'live-child-operation',
          ownerToken: randomUUID(),
          pid: process.pid,
          schemaVersion: 1,
          scope: { id: 'project-child', kind: 'project' }
        }));
        await handle.sync();
        await handle.close();
        const oldHeartbeat = new Date(Date.now() - 120_000);
        await utimes(path, oldHeartbeat, oldHeartbeat);
        process.stdout.write('ready\\n');
        setInterval(() => {}, 1_000);
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, lockPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await once(child.stdout, 'data');
        const record = (await listRecoveryRecords(paths)).find(
          (candidate) => candidate.kind === 'lock',
        );
        if (record === undefined) throw new Error('Expected child lock recovery record.');
        await expect(planRecoveryUnlock(paths, record.id)).rejects.toThrow(/still active/u);
        expect(await readFile(lockPath, 'utf8')).toContain('live-child-operation');

        child.kill('SIGTERM');
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
        const plan = await planRecoveryUnlock(paths, record.id);
        expect(await readFile(lockPath, 'utf8')).toContain('live-child-operation');
        await applyRecoveryUnlock(paths, record.id, {
          expectedFingerprint: plan.fingerprint,
        });
        await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await once(child, 'exit');
        }
      }
    }));
});
