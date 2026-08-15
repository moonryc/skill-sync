import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyRecoveryUnlock,
  applyRecoveryPrune,
  inspectRecoveryRecord,
  inspectRecoveryState,
  listRecoveryRecords,
  planRecoveryUnlock,
  planRecoveryPrune,
  RecoveryUnlockValidationError,
  recoveryUnlockActionLockPath,
  recoveryWarningLines,
} from '../../src/application/recovery.js';
import { resolveApplicationPaths } from '../../src/infrastructure/config.js';
import {
  acquireAdvisoryLock,
  createOperationJournal,
  createOperationJournalV2,
  createRecoverableBackup,
  deterministicOperationPaths,
  planOperationJournalRestore,
  planOperationJournalResume,
  readOperationJournal,
  transactionContentDigest,
  transactionRootFingerprint,
  updateOperationJournalV2,
} from '../../src/infrastructure/transactions.js';
import { OperationGuard } from '../../src/runtime/operation-guard.js';
import {
  formatRecoveryRecordHuman,
  formatRecoveryRecordsHuman,
} from '../../src/ui/recovery-output.js';
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
      expect(recoveryWarningLines(inspection)[0]).toContain('1 backup(s)');
      expect(recoveryWarningLines(inspection)[1]).toBe(
        'Next: run `skill-sync recovery list` to get a record ID, then `skill-sync recovery inspect <id>`.',
      );
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
      expect(
        recoveryWarningLines({
          backups: [{ path: '/owned/backup/backup.json', scopePath: 'project-example' }],
          journals: [],
          locks: [],
          problems: [],
          remediation: ['Keep the backup until managed state is verified.'],
        })[0],
      ).toContain('1 backup(s)');
    }));

  it('discovers nested scope evidence without following unsafe or unrelated entries', async () =>
    withTempDirectory('skill-sync-recovery-nested-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: root },
      });
      const scopeKey = 'project-abc123';
      const journalDirectory = join(paths.journalsDirectory, scopeKey);
      const lockDirectory = join(paths.locksDirectory, scopeKey);
      const nestedJournal = await createOperationJournal(journalDirectory, {
        kind: 'install',
        operationId: 'nested-operation',
        now: new Date('2026-07-19T00:00:00.000Z'),
      });
      const nestedLock = await acquireAdvisoryLock(join(lockDirectory, 'scope.lock'), {
        operationId: 'nested-operation',
      });
      await writeFile(join(journalDirectory, 'notes.txt'), 'unrelated');

      const outside = join(root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'foreign.json'), '{"schemaVersion":1}');
      await symlink(outside, join(journalDirectory, 'unsafe-link'));

      const inspection = await inspectRecoveryState(paths);
      expect(inspection.journals).toEqual([
        expect.objectContaining({
          path: nestedJournal.path,
          scopePath: scopeKey,
        }),
      ]);
      expect(inspection.locks).toHaveLength(1);
      expect(inspection.problems).toEqual([
        expect.objectContaining({
          blocking: true,
          kind: 'unsafe-entry',
          path: join(journalDirectory, 'unsafe-link'),
        }),
      ]);
      expect(inspection.journals.map((entry) => entry.path)).not.toContain(
        join(outside, 'foreign.json'),
      );
      const records = await listRecoveryRecords(paths, { scope: 'project-abc123' });
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'lock', operationId: 'nested-operation' }),
          expect.objectContaining({
            inspectOnly: true,
            kind: 'journal',
            operationId: 'nested-operation',
            scope: scopeKey,
            status: 'preparing',
          }),
        ]),
      );
      const record = records.find((candidate) => candidate.kind === 'journal');
      expect(record).toEqual(
        expect.objectContaining({
          inspectOnly: true,
          kind: 'journal',
          operationId: 'nested-operation',
          scope: scopeKey,
          status: 'preparing',
        }),
      );
      expect(formatRecoveryRecordsHuman(records)).toContain('nested-operation');
      if (record === undefined) throw new Error('Expected a recovery record.');
      const detail = await inspectRecoveryRecord(paths, record.id);
      expect(detail?.record.id).toBe(record.id);
      if (detail === undefined) throw new Error('Expected recovery detail.');
      expect(formatRecoveryRecordHuman(detail)).toContain('inspect-only');
      expect(formatRecoveryRecordHuman(detail)).toContain('Available actions: inspection only');

      await nestedLock.release();
    }));

  it('reports malformed owned evidence as blocking without changing it', async () =>
    withTempDirectory('skill-sync-recovery-invalid-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: root },
      });
      const journalPath = join(paths.journalsDirectory, 'project-key', 'broken.json');
      await mkdir(join(paths.journalsDirectory, 'project-key'), { recursive: true });
      await writeFile(journalPath, '{"schemaVersion":2,"operationId":"broken"}\n');
      const before = await readFile(journalPath, 'utf8');

      const inspection = await inspectRecoveryState(paths);
      expect(inspection.journals).toEqual([]);
      expect(inspection.problems).toEqual([
        expect.objectContaining({
          blocking: true,
          kind: 'journal',
          path: journalPath,
        }),
      ]);
      expect(await readFile(journalPath, 'utf8')).toBe(before);
    }));

  it('previews and removes only a valid same-host lock whose owner process is absent', async () =>
    withTempDirectory('skill-sync-recovery-unlock-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
      });
      const lockPath = join(paths.locksDirectory, 'user-configuration.lock');
      await acquireAdvisoryLock(lockPath, {
        hostname: 'local-test-host',
        operationId: 'abandoned-setup',
        pid: 424_242,
        scope: { id: 'user-configuration', kind: 'global' },
      });
      const records = await listRecoveryRecords(paths);
      const record = records.find((candidate) => candidate.kind === 'lock');
      if (record === undefined) throw new Error('Expected lock recovery record.');
      expect(record).toMatchObject({
        inspectOnly: false,
        scope: 'global:user-configuration',
        scopeKind: 'global',
      });
      const processState = (pid: number) => {
        expect(pid).toBe(424_242);
        return 'absent' as const;
      };
      const plan = await planRecoveryUnlock(paths, record.id, {
        currentHostname: 'local-test-host',
        minimumAgeMs: 0,
        processState,
      });
      const siblingPath = join(paths.locksDirectory, 'cache-sibling.lock');
      const sibling = await acquireAdvisoryLock(siblingPath, {
        hostname: 'local-test-host',
        operationId: 'active-cache-refresh',
        pid: process.pid,
        scope: { id: 'library-sibling', kind: 'library' },
      });
      expect(plan).toMatchObject({
        id: record.id,
        owner: {
          hostname: 'local-test-host',
          operationId: 'abandoned-setup',
          pid: 424_242,
        },
        path: lockPath,
        status: 'abandoned',
      });
      expect(JSON.stringify(plan)).not.toContain('ownerToken');
      const inspected = await inspectRecoveryRecord(paths, record.id);
      expect(JSON.stringify(inspected)).not.toContain('ownerToken');
      expect(await readFile(lockPath, 'utf8')).toContain('abandoned-setup');

      const competingAction = await acquireAdvisoryLock(
        recoveryUnlockActionLockPath(paths, record.id),
        {
          operationId: 'other-recovery-unlock',
          scope: { id: record.id, kind: 'recovery' },
        },
      );
      await expect(
        applyRecoveryUnlock(paths, record.id, {
          currentHostname: 'local-test-host',
          expectedFingerprint: plan.fingerprint,
          minimumAgeMs: 0,
          processState,
        }),
      ).rejects.toThrow(/already coordinating/u);
      expect(await readFile(lockPath, 'utf8')).toContain('abandoned-setup');
      await competingAction.release();

      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        applyRecoveryUnlock(paths, record.id, {
          currentHostname: 'local-test-host',
          expectedFingerprint: plan.fingerprint,
          minimumAgeMs: 0,
          operationGuard: new OperationGuard(cancelled.signal),
          processState,
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await readFile(lockPath, 'utf8')).toContain('abandoned-setup');

      const guard = new OperationGuard(new AbortController().signal);
      await applyRecoveryUnlock(paths, record.id, {
        currentHostname: 'local-test-host',
        expectedFingerprint: plan.fingerprint,
        minimumAgeMs: 0,
        operationGuard: guard,
        processState,
      });
      expect(guard.state).toBe('committed');
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(siblingPath, 'utf8')).toContain('active-cache-refresh');
      await sibling.release();
    }));

  it('preserves active, foreign-host, unverifiable, malformed, and changed lock evidence', async () =>
    withTempDirectory('skill-sync-recovery-unlock-refusal-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
      });
      const lockPath = join(paths.locksDirectory, 'project-example.lock');
      const original = await acquireAdvisoryLock(lockPath, {
        hostname: 'recorded-host',
        now: new Date('2020-01-01T00:00:00.000Z'),
        operationId: 'project-install',
        pid: 313_131,
        scope: { id: 'project-example', kind: 'project' },
      });
      const lockRecord = (await listRecoveryRecords(paths)).find(
        (candidate) => candidate.kind === 'lock',
      );
      if (lockRecord === undefined) throw new Error('Expected lock recovery record.');

      await expect(
        planRecoveryUnlock(paths, lockRecord.id, {
          currentHostname: 'recorded-host',
          processState: () => 'active',
        }),
      ).rejects.toThrow(/still active/u);
      await expect(
        planRecoveryUnlock(paths, lockRecord.id, {
          currentHostname: 'different-host',
          processState: () => 'absent',
        }),
      ).rejects.toThrow(/cannot prove/u);
      await expect(
        planRecoveryUnlock(paths, lockRecord.id, {
          currentHostname: 'recorded-host',
          processState: () => 'unknown',
        }),
      ).rejects.toThrow(/could not prove/u);
      await expect(
        planRecoveryUnlock(paths, lockRecord.id, {
          currentHostname: 'recorded-host',
          processState: () => 'absent',
        }),
      ).rejects.toThrow(/grace period/u);
      expect(await readFile(lockPath, 'utf8')).toContain(original.metadata.ownerToken);

      const plan = await planRecoveryUnlock(paths, lockRecord.id, {
        currentHostname: 'recorded-host',
        minimumAgeMs: 0,
        processState: () => 'absent',
      });
      await original.release();
      const replacement = await acquireAdvisoryLock(lockPath, {
        hostname: 'recorded-host',
        operationId: 'project-install',
        pid: 313_131,
        scope: { id: 'project-example', kind: 'project' },
      });
      await expect(
        applyRecoveryUnlock(paths, lockRecord.id, {
          currentHostname: 'recorded-host',
          expectedFingerprint: plan.fingerprint,
          minimumAgeMs: 0,
          processState: () => 'absent',
        }),
      ).rejects.toBeInstanceOf(RecoveryUnlockValidationError);
      expect(await readFile(lockPath, 'utf8')).toContain(replacement.metadata.ownerToken);
      await replacement.release();

      const malformedPath = join(paths.locksDirectory, 'malformed.lock');
      await writeFile(malformedPath, '{"broken":true}\n');
      const malformedRecord = (await listRecoveryRecords(paths)).find(
        (candidate) => candidate.kind === 'lock',
      );
      if (malformedRecord === undefined) throw new Error('Expected malformed lock record.');
      await expect(planRecoveryUnlock(paths, malformedRecord.id)).rejects.toThrow(
        /Valid advisory lock record/u,
      );
      expect(await readFile(malformedPath, 'utf8')).toBe('{"broken":true}\n');
    }));

  it('keeps a recovery action record when lock deletion reaches an ambiguous durability boundary', async () =>
    withTempDirectory('skill-sync-recovery-unlock-sync-failure-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
      });
      const lockPath = join(paths.locksDirectory, 'user-configuration.lock');
      await acquireAdvisoryLock(lockPath, {
        hostname: 'local-test-host',
        operationId: 'abandoned-setup',
        pid: 424_242,
        scope: { id: 'user-configuration', kind: 'global' },
      });
      const record = (await listRecoveryRecords(paths)).find(
        (candidate) => candidate.kind === 'lock',
      );
      if (record === undefined) throw new Error('Expected lock recovery record.');
      const plan = await planRecoveryUnlock(paths, record.id, {
        currentHostname: 'local-test-host',
        minimumAgeMs: 0,
        processState: () => 'absent',
      });
      const guard = new OperationGuard(new AbortController().signal);

      await expect(
        applyRecoveryUnlock(paths, record.id, {
          currentHostname: 'local-test-host',
          expectedFingerprint: plan.fingerprint,
          minimumAgeMs: 0,
          operationGuard: guard,
          processState: () => 'absent',
          syncParent: () => Promise.reject(new Error('injected parent sync failure')),
        }),
      ).rejects.toThrow(/injected parent sync failure/u);

      expect(guard.state).toBe('committing');
      await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const remaining = await listRecoveryRecords(paths);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({ kind: 'lock', scopeKind: 'recovery' });
    }));

  it('prunes only selected terminal journals and their deterministic artifacts', async () =>
    withTempDirectory('skill-sync-recovery-prune-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
      });
      const project = join(root, 'project');
      const destinationRelative = '.codex/skills/example';
      const destination = join(project, ...destinationRelative.split('/'));
      const artifacts = deterministicOperationPaths(destinationRelative, 'prune-example', 0);
      const candidate = join(project, ...artifacts.candidate.split('/'));
      const rollback = join(project, ...artifacts.rollback.split('/'));
      await mkdir(destination, { recursive: true });
      await mkdir(candidate, { recursive: true });
      await mkdir(rollback, { recursive: true });
      await writeFile(join(destination, 'SKILL.md'), 'new');
      await writeFile(join(candidate, 'SKILL.md'), 'new');
      await writeFile(join(rollback, 'SKILL.md'), 'old');
      const canonicalCandidate = await realpath(candidate);
      const canonicalRollback = await realpath(rollback);
      const finalDigest = await transactionContentDigest(destination);
      const originalDigest = await transactionContentDigest(rollback);
      const journal = await createOperationJournalV2(join(paths.journalsDirectory, 'project-key'), {
        entries: [
          {
            action: 'replace',
            candidate: artifacts.candidate,
            destination: destinationRelative,
            finalDigest,
            originalDigest,
            rollback: artifacts.rollback,
            sourceDigest: finalDigest,
            state: 'pending',
          },
        ],
        kind: 'install',
        operationId: 'prune-example',
        rootFingerprint: transactionRootFingerprint(await realpath(project)),
        scope: { id: 'project-prune', kind: 'project' },
      });
      const entry = journal.value.entries[0];
      if (entry === undefined) throw new Error('Expected journal entry.');
      const prepared = await updateOperationJournalV2(journal.path, {
        entries: [{ ...entry, state: 'prepared' }],
        status: 'prepared',
      });
      const preparedEntry = prepared.entries[0];
      if (preparedEntry === undefined) throw new Error('Expected prepared entry.');
      const committing = await updateOperationJournalV2(journal.path, {
        entries: [{ ...preparedEntry, state: 'committed' }],
        status: 'committing',
      });
      await updateOperationJournalV2(journal.path, {
        entries: committing.entries,
        status: 'committed',
      });
      const unrelated = join(project, '.codex', 'skills', 'unrelated');
      await mkdir(unrelated, { recursive: true });
      await writeFile(join(unrelated, 'SKILL.md'), 'keep');

      const records = await listRecoveryRecords(paths, {
        includeTerminalJournals: true,
        scope: 'project-prune',
      });
      const record = records.find((candidateRecord) => candidateRecord.kind === 'journal');
      if (record === undefined) throw new Error('Expected terminal journal record.');
      const inspection = await inspectRecoveryRecord(paths, record.id);
      if (inspection === undefined) throw new Error('Expected terminal journal inspection.');
      const humanInspection = formatRecoveryRecordHuman(inspection);
      expect(humanInspection).toContain('Affected destinations (1):');
      expect(humanInspection).toContain(destinationRelative);
      expect(humanInspection).toContain(
        `skill-sync --project <affected-project> recovery prune ${record.id} --dry-run`,
      );
      const plan = await planRecoveryPrune(paths, [record.id], { root: project });
      expect(plan.entries[0]?.paths).toEqual(
        expect.arrayContaining([canonicalCandidate, canonicalRollback, journal.path]),
      );
      expect(await readFile(journal.path, 'utf8')).toContain('"status": "committed"');

      const pruneGuard = new OperationGuard(new AbortController().signal);
      await applyRecoveryPrune(paths, [record.id], {
        expectedFingerprint: plan.fingerprint,
        operationGuard: pruneGuard,
        root: project,
      });
      expect(pruneGuard.state).toBe('committed');
      await expect(readFile(journal.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(candidate, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(readFile(join(rollback, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');
      expect(await readFile(join(unrelated, 'SKILL.md'), 'utf8')).toBe('keep');
    }));

  it('prunes verified backups but refuses unresolved journals', async () =>
    withTempDirectory('skill-sync-recovery-prune-backup-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
      });
      const project = join(root, 'project');
      const source = join(project, 'skill-sync.json');
      await mkdir(project, { recursive: true });
      await writeFile(source, '{"schemaVersion":1}\n');
      const backup = await createRecoverableBackup({
        backupRoot: join(paths.backupsDirectory, 'project-key'),
        entries: [{ path: source, relativePath: 'skill-sync.json' }],
        operationId: 'backup-example',
        projectRoot: project,
      });
      const unresolved = await createOperationJournal(
        join(paths.journalsDirectory, 'project-key'),
        {
          kind: 'install',
          operationId: 'unresolved-example',
        },
      );
      const records = await listRecoveryRecords(paths, { includeTerminalJournals: true });
      const backupRecord = records.find(
        (record) => record.kind === 'backup' && record.operationId === 'backup-example',
      );
      const unresolvedRecord = records.find(
        (record) => record.kind === 'journal' && record.operationId === 'unresolved-example',
      );
      if (backupRecord === undefined || unresolvedRecord === undefined) {
        throw new Error('Expected backup and unresolved records.');
      }

      await expect(
        planRecoveryPrune(paths, [unresolvedRecord.id], { root: project }),
      ).rejects.toThrow(/unresolved or inspect-only/u);
      const plan = await planRecoveryPrune(paths, [backupRecord.id], { root: project });
      expect(await readFile(join(backup.path, 'backup.json'), 'utf8')).toContain('backup-example');
      const cancelledPrune = new AbortController();
      cancelledPrune.abort();
      await expect(
        applyRecoveryPrune(paths, [backupRecord.id], {
          expectedFingerprint: plan.fingerprint,
          operationGuard: new OperationGuard(cancelledPrune.signal),
          root: project,
        }),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await readFile(join(backup.path, 'backup.json'), 'utf8')).toContain('backup-example');

      const pruneGuard = new OperationGuard(new AbortController().signal);
      await applyRecoveryPrune(paths, [backupRecord.id], {
        expectedFingerprint: plan.fingerprint,
        operationGuard: pruneGuard,
        root: project,
      });
      expect(pruneGuard.state).toBe('committed');
      await expect(readFile(join(backup.path, 'backup.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(source, 'utf8')).toBe('{"schemaVersion":1}\n');
      expect(await readFile(unresolved.path, 'utf8')).toContain('unresolved-example');
    }));

  it('keeps raw v1 journals inspect-only without inferring recovery paths', async () =>
    withTempDirectory('skill-sync-recovery-v1-', async (root) => {
      const paths = resolveApplicationPaths({
        cwd: root,
        env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
      });
      const fixtureUrl = new URL(
        '../fixtures/recovery/journal-v1-interrupted.json',
        import.meta.url,
      );
      const fixture = await readFile(fixtureUrl, 'utf8');
      const journalPath = join(
        paths.journalsDirectory,
        'legacy-project',
        'legacy-interrupted.json',
      );
      await mkdir(dirname(journalPath), { recursive: true });
      await writeFile(journalPath, fixture);

      const journal = await readOperationJournal(journalPath);
      expect(journal).toMatchObject({
        entries: [
          {
            destination: '.codex/skills/example',
            state: 'original-moved',
          },
        ],
        operationId: 'legacy-interrupted',
        schemaVersion: 1,
        status: 'failed',
      });
      expect(JSON.stringify(journal)).not.toContain('candidate');
      expect(JSON.stringify(journal)).not.toContain('rollback');

      const records = await listRecoveryRecords(paths);
      const record = records.find(
        (candidate) =>
          candidate.kind === 'journal' && candidate.operationId === 'legacy-interrupted',
      );
      expect(record).toMatchObject({ inspectOnly: true, status: 'failed' });
      if (record === undefined) throw new Error('Expected legacy recovery record.');
      const inspection = await inspectRecoveryRecord(paths, record.id);
      expect(inspection?.evidence).toEqual(journal);
      await expect(planOperationJournalResume(journalPath, root)).rejects.toThrow(/inspect-only/u);
      await expect(planOperationJournalRestore(journalPath, root)).rejects.toThrow(/inspect-only/u);
      await expect(planRecoveryPrune(paths, [record.id], { root })).rejects.toThrow(
        /unresolved or inspect-only/u,
      );
      expect(await readFile(journalPath, 'utf8')).toBe(fixture);
    }));
});
