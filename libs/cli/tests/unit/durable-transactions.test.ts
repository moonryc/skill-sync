import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  acquireAdvisoryLock,
  createOperationJournal,
  createOperationJournalV2,
  createRecoverableBackup,
  createStagingDirectory,
  deterministicOperationPaths,
  listOperationJournals,
  operationJournalV2Schema,
  planOperationJournalRestore,
  planOperationJournalResume,
  readOperationJournal,
  replacePathsAtomically,
  restoreOperationJournal,
  resumeOperationJournal,
  stageRegularPath,
  type TransactionDurableStep,
  transactionRootFingerprint,
  transactionContentDigest,
  updateOperationJournal,
  updateOperationJournalV2,
} from '../../src/infrastructure/transactions.js';
import { OperationGuard } from '../../src/runtime/operation-guard.js';
import { withTempDirectory } from '../helpers/temp.js';

describe('transaction primitives', () => {
  it('uses owner-checked exclusive advisory locks', async () => {
    await withTempDirectory('skill-sync-lock-', async (root) => {
      const path = join(root, 'locks', 'library.lock');
      const first = await acquireAdvisoryLock(path, {
        hostname: 'test-host',
        now: new Date('2026-01-01T00:00:00.000Z'),
        operationId: 'first-operation',
        pid: 123,
        scope: { id: 'project-test', kind: 'project' },
      });
      await expect(
        acquireAdvisoryLock(path, { operationId: 'second-operation' }),
      ).rejects.toMatchObject({
        owner: {
          operationId: 'first-operation',
          pid: 123,
          scope: { id: 'project-test', kind: 'project' },
        },
      });
      await first.release();
      await first.release();
      const second = await acquireAdvisoryLock(path, { operationId: 'second-operation' });
      await second.release();
    });
  });

  it('heartbeats an owned advisory lock and stops before release', async () => {
    await withTempDirectory('skill-sync-lock-heartbeat-', async (root) => {
      const path = join(root, 'locks', 'library.lock');
      const lock = await acquireAdvisoryLock(path, {
        heartbeatIntervalMs: 10,
        operationId: 'heartbeat-operation',
      });
      const oldHeartbeat = new Date('2020-01-01T00:00:00.000Z');
      await utimes(path, oldHeartbeat, oldHeartbeat);

      await delay(40);

      expect((await stat(path)).mtimeMs).toBeGreaterThan(oldHeartbeat.getTime());
      await lock.release();
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('reports stale locks without removing crash evidence and verifies release ownership', async () => {
    await withTempDirectory('skill-sync-stale-lock-', async (root) => {
      const path = join(root, 'locks', 'project.lock');
      const stale = await acquireAdvisoryLock(path, {
        heartbeatIntervalMs: 0,
        now: new Date('2026-01-01T00:00:00.000Z'),
        operationId: 'crashed-operation',
        scope: { id: 'project-stale', kind: 'project' },
      });
      const lastHeartbeat = new Date('2026-01-01T00:00:00.000Z');
      await utimes(path, lastHeartbeat, lastHeartbeat);

      await expect(
        acquireAdvisoryLock(path, {
          now: new Date('2026-01-02T00:00:00.001Z'),
          operationId: 'next-operation',
          staleAfterMs: 24 * 60 * 60 * 1_000,
        }),
      ).rejects.toMatchObject({ stale: true });
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        operationId: 'crashed-operation',
      });

      const tampered = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...tampered, ownerToken: randomUUID() }));
      await expect(stale.release()).rejects.toMatchObject({
        kind: 'lock-ownership',
        recoveryRequired: true,
      });
      expect(await readFile(path, 'utf8')).toContain('ownerToken');
    });
  });

  it('persists stable operation journals with checked state transitions', async () => {
    await withTempDirectory('skill-sync-journal-', async (root) => {
      const created = await createOperationJournal(join(root, 'journals'), {
        entries: [
          {
            action: 'replace',
            destination: '.codex/skills/example',
            state: 'pending',
          },
        ],
        kind: 'install',
        now: new Date('2026-01-01T00:00:00.000Z'),
        operationId: 'install-example',
      });
      const [entry] = created.value.entries;
      if (entry === undefined) throw new Error('Expected the journal fixture entry.');
      await updateOperationJournal(created.path, {
        entries: [{ ...entry, state: 'prepared' }],
        now: new Date('2026-01-01T00:00:01.000Z'),
        status: 'prepared',
      });
      expect((await readOperationJournal(created.path)).status).toBe('prepared');
      expect(await listOperationJournals(join(root, 'journals'))).toHaveLength(1);
      await expect(updateOperationJournal(created.path, { status: 'committed' })).rejects.toThrow(
        /Invalid journal transition/u,
      );
    });
  });

  it('defines deterministic, root-bound operation journal schema v2 evidence', () => {
    const destination = '.codex/skills/example';
    const paths = deterministicOperationPaths(destination, 'install-example', 0);
    const digest = 'a'.repeat(64);
    const journal = operationJournalV2Schema.parse({
      createdAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          action: 'replace',
          candidate: paths.candidate,
          destination,
          finalDigest: digest,
          originalDigest: null,
          rollback: paths.rollback,
          sourceDigest: digest,
          state: 'pending',
        },
      ],
      kind: 'install',
      operationId: 'install-example',
      rootFingerprint: transactionRootFingerprint('/workspace/project'),
      schemaVersion: 2,
      scope: { id: 'project-abc123', kind: 'project' },
      status: 'preparing',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(journal.entries[0]).toMatchObject({
      candidate: '.codex/skills/.skill-sync-install-example-0-candidate',
      rollback: '.codex/skills/.skill-sync-install-example-0-rollback',
    });
    expect(journal.rootFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(journal.rootFingerprint).not.toContain('/workspace/project');
    expect(deterministicOperationPaths(destination, 'install-example', 0)).toEqual(paths);
  });

  it('rejects incomplete or nondeterministic operation journal schema v2 evidence', () => {
    const destination = '.codex/skills/example';
    const paths = deterministicOperationPaths(destination, 'install-example', 0);
    const base = {
      createdAt: '2026-01-01T00:00:00.000Z',
      entries: [
        {
          action: 'replace',
          candidate: paths.candidate,
          destination,
          finalDigest: 'a'.repeat(64),
          originalDigest: null,
          rollback: paths.rollback,
          sourceDigest: 'a'.repeat(64),
          state: 'pending',
        },
      ],
      kind: 'install',
      operationId: 'install-example',
      rootFingerprint: transactionRootFingerprint('/workspace/project'),
      schemaVersion: 2,
      scope: { id: 'project-abc123', kind: 'project' },
      status: 'preparing',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as const;

    expect(() =>
      operationJournalV2Schema.parse({
        ...base,
        entries: [{ ...base.entries[0], rollback: '.codex/skills/unrelated' }],
      }),
    ).toThrow(/rollback path is not deterministic/u);
    expect(() =>
      operationJournalV2Schema.parse({
        ...base,
        status: 'committed',
      }),
    ).toThrow(/terminal metadata/u);
    expect(() =>
      operationJournalV2Schema.parse({
        ...base,
        entries: [{ ...base.entries[0], candidate: '../escape' }],
      }),
    ).toThrow();
  });

  it('stages only inert regular content and rejects symlinks', async () => {
    await withTempDirectory('skill-sync-stage-', async (root) => {
      const source = join(root, 'source');
      const staging = await createStagingDirectory(join(root, 'staging'), 'install');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), '# Example\n');
      const staged = await stageRegularPath(source, staging, 'frontend/example');
      expect(await readFile(join(staged, 'SKILL.md'), 'utf8')).toBe('# Example\n');

      const linkedSource = join(root, 'linked-source');
      await mkdir(linkedSource);
      await symlink(join(source, 'SKILL.md'), join(linkedSource, 'SKILL.md'));
      await expect(stageRegularPath(linkedSource, staging, 'linked/example')).rejects.toThrow(
        /symbolic link/u,
      );
    });
  });

  it('rolls every committed destination back when a later replacement fails', async () => {
    await withTempDirectory('skill-sync-replace-', async (root) => {
      const project = join(root, 'project');
      const staged = join(root, 'staged');
      const firstDestination = join(project, '.codex', 'skills', 'first');
      const secondDestination = join(project, '.claude', 'skills', 'first');
      await mkdir(firstDestination, { recursive: true });
      await mkdir(secondDestination, { recursive: true });
      await mkdir(join(staged, 'first'), { recursive: true });
      await mkdir(join(staged, 'second'), { recursive: true });
      await writeFile(join(firstDestination, 'SKILL.md'), 'old codex');
      await writeFile(join(secondDestination, 'SKILL.md'), 'old claude');
      await writeFile(join(staged, 'first', 'SKILL.md'), 'new codex');
      await writeFile(join(staged, 'second', 'SKILL.md'), 'new claude');

      await expect(
        replacePathsAtomically({
          hooks: {
            beforeCommit: (index) => {
              if (index === 1) throw new Error('injected second-target failure');
            },
          },
          journalDirectory: join(root, 'journals'),
          kind: 'update',
          operationId: 'update-first',
          replacements: [
            {
              action: 'replace',
              destinationPath: firstDestination,
              stagedPath: join(staged, 'first'),
            },
            {
              action: 'replace',
              destinationPath: secondDestination,
              stagedPath: join(staged, 'second'),
            },
          ],
          root: project,
        }),
      ).rejects.toThrow(/injected second-target failure/u);

      expect(await readFile(join(firstDestination, 'SKILL.md'), 'utf8')).toBe('old codex');
      expect(await readFile(join(secondDestination, 'SKILL.md'), 'utf8')).toBe('old claude');
      expect((await listOperationJournals(join(root, 'journals')))[0]?.value.status).toBe(
        'rolled-back',
      );
    });
  });

  it.each([
    'journal-created',
    'candidate-prepared',
    'journal-prepared',
    'journal-committing',
    'original-moved',
    'journal-original-moved',
    'candidate-committed',
    'journal-entry-committed',
    'journal-committed',
  ] satisfies readonly TransactionDurableStep[])(
    'keeps durable evidence consistent when failure is injected after %s',
    async (faultPoint) => {
      await withTempDirectory('skill-sync-journal-fault-', async (root) => {
        const project = join(root, 'project');
        const destination = join(project, '.codex', 'skills', 'example');
        const staged = join(root, 'staged');
        await mkdir(destination, { recursive: true });
        await mkdir(staged);
        await writeFile(join(destination, 'SKILL.md'), 'old');
        await writeFile(join(staged, 'SKILL.md'), 'new');
        let injected = false;

        const operation = replacePathsAtomically({
          hooks: {
            afterDurableStep: (step) => {
              if (!injected && step === faultPoint) {
                injected = true;
                throw new Error(`injected after ${step}`);
              }
            },
          },
          journalDirectory: join(root, 'journals'),
          kind: 'install',
          operationId: 'fault-example',
          replacements: [{ action: 'replace', destinationPath: destination, stagedPath: staged }],
          root: project,
          scope: { id: 'project-fault-example', kind: 'project' },
        });

        if (faultPoint === 'journal-committed') {
          await expect(operation).resolves.toBeDefined();
          expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');
        } else {
          await expect(operation).rejects.toThrow(`injected after ${faultPoint}`);
          expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old');
        }

        const [handle] = await listOperationJournals(join(root, 'journals'));
        expect(handle?.value.schemaVersion).toBe(2);
        const expectedStatus =
          faultPoint === 'journal-created'
            ? 'preparing'
            : faultPoint === 'journal-committed'
              ? 'committed'
              : 'rolled-back';
        expect(handle?.value.status).toBe(expectedStatus);
        if (handle?.value.schemaVersion === 2) {
          const expectedEntryState =
            faultPoint === 'journal-created'
              ? 'pending'
              : faultPoint === 'journal-committed'
                ? 'committed'
                : 'restored';
          expect(handle.value.entries[0]?.state).toBe(expectedEntryState);
          expect(handle.value.entries[0]).toMatchObject({
            candidate: '.codex/skills/.skill-sync-fault-example-0-candidate',
            rollback: '.codex/skills/.skill-sync-fault-example-0-rollback',
          });
          expect(handle.value.terminal?.outcome).toBe(
            faultPoint === 'journal-created'
              ? undefined
              : faultPoint === 'journal-committed'
                ? 'committed'
                : 'rolled-back',
          );
        }
      });
    },
  );

  it('durably records every rename boundary before reporting a committed v2 journal', async () => {
    await withTempDirectory('skill-sync-journal-steps-', async (root) => {
      const project = join(root, 'project');
      const destination = join(project, '.codex', 'skills', 'example');
      const staged = join(root, 'staged');
      await mkdir(destination, { recursive: true });
      await mkdir(staged);
      await writeFile(join(destination, 'SKILL.md'), 'old');
      await writeFile(join(staged, 'SKILL.md'), 'new');
      const steps: TransactionDurableStep[] = [];

      const result = await replacePathsAtomically({
        hooks: {
          afterDurableStep: (step) => {
            steps.push(step);
          },
        },
        journalDirectory: join(root, 'journals'),
        kind: 'install',
        operationId: 'step-example',
        replacements: [{ action: 'replace', destinationPath: destination, stagedPath: staged }],
        root: project,
        scope: { id: 'project-step-example', kind: 'project' },
      });

      expect(steps).toEqual([
        'journal-created',
        'candidate-prepared',
        'journal-prepared',
        'journal-committing',
        'original-moved',
        'journal-original-moved',
        'candidate-committed',
        'journal-entry-committed',
        'journal-committed',
      ]);
      expect(result.journal?.value).toMatchObject({
        schemaVersion: 2,
        status: 'committed',
        terminal: { outcome: 'committed' },
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');
    });
  });

  it('revalidates destination and candidate digests immediately before commit', async () => {
    await withTempDirectory('skill-sync-stale-plan-', async (root) => {
      const project = join(root, 'project');
      const destination = join(project, '.codex', 'skills', 'example');
      const staged = join(root, 'staged');
      await mkdir(destination, { recursive: true });
      await mkdir(staged);
      await writeFile(join(destination, 'SKILL.md'), 'old');
      await writeFile(join(staged, 'SKILL.md'), 'new');

      await expect(
        replacePathsAtomically({
          hooks: {
            afterDurableStep: async (step) => {
              if (step === 'journal-prepared') {
                await writeFile(join(destination, 'SKILL.md'), 'changed after planning');
              }
            },
          },
          journalDirectory: join(root, 'journals'),
          kind: 'install',
          operationId: 'stale-plan',
          replacements: [{ action: 'replace', destinationPath: destination, stagedPath: staged }],
          root: project,
        }),
      ).rejects.toMatchObject({
        code: 'STALE_MUTATION_PLAN',
        details: {
          destination: '.codex/skills/example',
          reason: 'destination-digest',
        },
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('changed after planning');
      expect((await listOperationJournals(join(root, 'journals')))[0]?.value.status).toBe(
        'rolled-back',
      );
    });
  });

  it('checks reviewed original digests before creating a journal', async () => {
    await withTempDirectory('skill-sync-reviewed-original-', async (root) => {
      const project = join(root, 'project');
      const destination = join(project, '.codex', 'skills', 'example');
      const staged = join(root, 'staged');
      const journals = join(root, 'journals');
      await mkdir(destination, { recursive: true });
      await mkdir(staged);
      await writeFile(join(destination, 'SKILL.md'), 'reviewed original');
      await writeFile(join(staged, 'SKILL.md'), 'new');
      const expectedOriginalDigest = await transactionContentDigest(destination);
      await writeFile(join(destination, 'SKILL.md'), 'changed outside the advisory lock');
      const reviewedPlanFingerprint = `install-v1-${'e'.repeat(64)}`;

      await expect(
        replacePathsAtomically({
          journalDirectory: journals,
          kind: 'install',
          operationId: 'reviewed-original',
          replacements: [
            {
              action: 'replace',
              destinationPath: destination,
              expectedOriginalDigest,
              stagedPath: staged,
            },
          ],
          reviewedPlanFingerprint,
          root: project,
        }),
      ).rejects.toMatchObject({
        code: 'STALE_MUTATION_PLAN',
        details: {
          destination: '.codex/skills/example',
          planFingerprint: reviewedPlanFingerprint,
          reason: 'destination-digest',
        },
      });

      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe(
        'changed outside the advisory lock',
      );
      expect(await readFile(join(staged, 'SKILL.md'), 'utf8')).toBe('new');
      expect(await listOperationJournals(journals)).toEqual([]);
    });
  });

  it('plans, resumes, and idempotently rechecks an interrupted v2 replacement', async () => {
    await withTempDirectory('skill-sync-resume-', async (root) => {
      const project = join(root, 'project');
      const destinationRelative = '.codex/skills/example';
      const destination = join(project, '.codex', 'skills', 'example');
      const artifactPaths = deterministicOperationPaths(destinationRelative, 'resume-example', 0);
      const candidate = join(project, ...artifactPaths.candidate.split('/'));
      await mkdir(destination, { recursive: true });
      await mkdir(candidate, { recursive: true });
      await writeFile(join(destination, 'SKILL.md'), 'old');
      await writeFile(join(candidate, 'SKILL.md'), 'new');
      const originalDigest = await transactionContentDigest(destination);
      const finalDigest = await transactionContentDigest(candidate);
      const journal = await createOperationJournalV2(join(root, 'journals'), {
        entries: [
          {
            action: 'replace',
            candidate: artifactPaths.candidate,
            destination: destinationRelative,
            finalDigest,
            originalDigest,
            rollback: artifactPaths.rollback,
            sourceDigest: finalDigest,
            state: 'pending',
          },
        ],
        kind: 'install',
        operationId: 'resume-example',
        rootFingerprint: transactionRootFingerprint(await realpath(project)),
        scope: { id: 'project-resume-example', kind: 'project' },
      });
      const journalEntry = journal.value.entries[0];
      if (journalEntry === undefined) throw new Error('Expected a journal entry.');
      await updateOperationJournalV2(journal.path, {
        entries: [{ ...journalEntry, state: 'prepared' }],
        status: 'prepared',
      });

      const plan = await planOperationJournalResume(journal.path, project);
      expect(plan.entries[0]?.actions).toEqual(['move-original', 'commit-candidate']);
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old');

      const interruptedResume = new AbortController();
      const interruptedResumeGuard = new OperationGuard(interruptedResume.signal);
      await expect(
        resumeOperationJournal({
          expectedFingerprint: plan.fingerprint,
          hooks: {
            afterDurableStep: (step) => {
              if (step === 'original-moved') {
                interruptedResume.abort();
                throw new Error('injected resume interruption');
              }
            },
          },
          journalPath: journal.path,
          operationGuard: interruptedResumeGuard,
          root: project,
        }),
      ).rejects.toThrow(/injected resume interruption/u);
      expect(interruptedResumeGuard.outcome()).toEqual({
        kind: 'recovery-required',
        state: 'committing',
      });
      await expect(readFile(join(destination, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const resumedPlan = await planOperationJournalResume(journal.path, project);
      expect(resumedPlan.entries[0]?.actions).toEqual(['commit-candidate']);
      const committedResume = new AbortController();
      const committedResumeGuard = new OperationGuard(committedResume.signal);
      const resumed = await resumeOperationJournal({
        expectedFingerprint: resumedPlan.fingerprint,
        hooks: {
          afterDurableStep: (step) => {
            if (step === 'journal-committed') committedResume.abort();
          },
        },
        journalPath: journal.path,
        operationGuard: committedResumeGuard,
        root: project,
      });
      expect(resumed.value.status).toBe('committed');
      expect(committedResumeGuard.outcome()).toEqual({
        interrupted: true,
        kind: 'committed',
        state: 'committed',
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');

      const repeatedPlan = await planOperationJournalResume(journal.path, project);
      const repeated = await resumeOperationJournal({
        expectedFingerprint: repeatedPlan.fingerprint,
        journalPath: journal.path,
        root: project,
      });
      expect(repeated.value.status).toBe('committed');
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');
    });
  });

  it('refuses resume when selected roots or candidate evidence differ', async () => {
    await withTempDirectory('skill-sync-resume-conflict-', async (root) => {
      const project = join(root, 'project');
      const destinationRelative = '.codex/skills/example';
      const destination = join(project, ...destinationRelative.split('/'));
      const artifactPaths = deterministicOperationPaths(destinationRelative, 'resume-conflict', 0);
      const candidate = join(project, ...artifactPaths.candidate.split('/'));
      await mkdir(destination, { recursive: true });
      await mkdir(candidate, { recursive: true });
      await writeFile(join(destination, 'SKILL.md'), 'old');
      await writeFile(join(candidate, 'SKILL.md'), 'expected');
      const originalDigest = await transactionContentDigest(destination);
      const finalDigest = await transactionContentDigest(candidate);
      const journal = await createOperationJournalV2(join(root, 'journals'), {
        entries: [
          {
            action: 'replace',
            candidate: artifactPaths.candidate,
            destination: destinationRelative,
            finalDigest,
            originalDigest,
            rollback: artifactPaths.rollback,
            sourceDigest: finalDigest,
            state: 'prepared',
          },
        ],
        kind: 'install',
        operationId: 'resume-conflict',
        rootFingerprint: transactionRootFingerprint(await realpath(project)),
        scope: { id: 'project-resume-conflict', kind: 'project' },
      });
      await updateOperationJournalV2(journal.path, {
        entries: journal.value.entries,
        status: 'prepared',
      });

      await writeFile(join(candidate, 'SKILL.md'), 'changed');
      await expect(planOperationJournalResume(journal.path, project)).rejects.toThrow(
        /Candidate evidence conflicts/u,
      );
      await expect(planOperationJournalResume(journal.path, root)).rejects.toThrow(
        /root fingerprint/u,
      );
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old');
    });
  });

  it('restores an interrupted committed entry and continues after a partial restore failure', async () => {
    await withTempDirectory('skill-sync-restore-', async (root) => {
      const project = join(root, 'project');
      const destinationRelative = '.codex/skills/example';
      const destination = join(project, ...destinationRelative.split('/'));
      const artifacts = deterministicOperationPaths(destinationRelative, 'restore-example', 0);
      const rollback = join(project, ...artifacts.rollback.split('/'));
      await mkdir(destination, { recursive: true });
      await mkdir(rollback, { recursive: true });
      await writeFile(join(destination, 'SKILL.md'), 'new');
      await writeFile(join(rollback, 'SKILL.md'), 'old');
      const finalDigest = await transactionContentDigest(destination);
      const originalDigest = await transactionContentDigest(rollback);
      const journal = await createOperationJournalV2(join(root, 'journals'), {
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
        operationId: 'restore-example',
        rootFingerprint: transactionRootFingerprint(await realpath(project)),
        scope: { id: 'project-restore-example', kind: 'project' },
      });
      const entry = journal.value.entries[0];
      if (entry === undefined) throw new Error('Expected journal entry.');
      const prepared = await updateOperationJournalV2(journal.path, {
        entries: [{ ...entry, state: 'prepared' }],
        status: 'prepared',
      });
      const preparedEntry = prepared.entries[0];
      if (preparedEntry === undefined) throw new Error('Expected prepared journal entry.');
      await updateOperationJournalV2(journal.path, {
        entries: [{ ...preparedEntry, state: 'committed' }],
        status: 'committing',
      });

      const plan = await planOperationJournalRestore(journal.path, project);
      expect(plan.entries[0]?.actions).toEqual([
        'remove-committed',
        'restore-original',
        'mark-restored',
      ]);
      const interruptedRestore = new AbortController();
      const interruptedRestoreGuard = new OperationGuard(interruptedRestore.signal);
      await expect(
        restoreOperationJournal({
          expectedFingerprint: plan.fingerprint,
          hooks: {
            afterDurableStep: (step) => {
              if (step === 'committed-destination-removed') {
                interruptedRestore.abort();
                throw new Error('injected partial restore failure');
              }
            },
          },
          journalPath: journal.path,
          operationGuard: interruptedRestoreGuard,
          root: project,
        }),
      ).rejects.toThrow(/partial restore failure/u);
      expect(interruptedRestoreGuard.outcome()).toEqual({
        kind: 'recovery-required',
        state: 'committing',
      });
      await expect(readFile(join(destination, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(rollback, 'SKILL.md'), 'utf8')).toBe('old');

      const continuedPlan = await planOperationJournalRestore(journal.path, project);
      expect(continuedPlan.entries[0]?.actions).toEqual(['restore-original', 'mark-restored']);
      const committedRestore = new AbortController();
      const committedRestoreGuard = new OperationGuard(committedRestore.signal);
      const restored = await restoreOperationJournal({
        expectedFingerprint: continuedPlan.fingerprint,
        hooks: {
          afterDurableStep: (step) => {
            if (step === 'journal-rolled-back') committedRestore.abort();
          },
        },
        journalPath: journal.path,
        operationGuard: committedRestoreGuard,
        root: project,
      });
      expect(restored.value.status).toBe('rolled-back');
      expect(committedRestoreGuard.outcome()).toEqual({
        interrupted: true,
        kind: 'committed',
        state: 'committed',
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old');

      const repeatedPlan = await planOperationJournalRestore(journal.path, project);
      const repeated = await restoreOperationJournal({
        expectedFingerprint: repeatedPlan.fingerprint,
        journalPath: journal.path,
        root: project,
      });
      expect(repeated.value.status).toBe('rolled-back');
    });
  });

  it('atomically replaces and removes paths on success', async () => {
    await withTempDirectory('skill-sync-commit-', async (root) => {
      const project = join(root, 'project');
      const destination = join(project, '.codex', 'skills', 'example');
      const removed = join(project, '.claude', 'skills', 'old');
      const staged = join(root, 'staged');
      await mkdir(destination, { recursive: true });
      await mkdir(removed, { recursive: true });
      await mkdir(staged);
      await writeFile(join(destination, 'SKILL.md'), 'old');
      await writeFile(join(removed, 'SKILL.md'), 'remove');
      await writeFile(join(staged, 'SKILL.md'), 'new');

      await replacePathsAtomically({
        kind: 'reconcile',
        operationId: 'replace-example',
        replacements: [
          { action: 'replace', destinationPath: destination, stagedPath: staged },
          { action: 'remove', destinationPath: removed },
        ],
        root: project,
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');
      await expect(readFile(join(removed, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('creates recoverable bounded backups with relative restore metadata', async () => {
    await withTempDirectory('skill-sync-backup-', async (root) => {
      const project = join(root, 'project');
      const skill = join(project, '.codex', 'skills', 'example');
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), 'local work');
      await writeFile(join(project, 'skill-sync.json'), '{"schemaVersion":1}\n');

      const backup = await createRecoverableBackup({
        backupRoot: join(root, 'backups'),
        entries: [
          { path: skill, relativePath: '.codex/skills/example' },
          { path: join(project, 'skill-sync.json'), relativePath: 'skill-sync.json' },
        ],
        now: new Date('2026-01-01T00:00:00.000Z'),
        operationId: 'discard-example',
        projectRoot: project,
      });

      expect(
        await readFile(
          join(backup.path, 'files', '.codex', 'skills', 'example', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('local work');
      expect(JSON.stringify(backup.manifest)).not.toContain(project);
      expect(backup.manifest.entries.map((entry) => entry.originalPath)).toEqual([
        '.codex/skills/example',
        'skill-sync.json',
      ]);
    });
  });
});
