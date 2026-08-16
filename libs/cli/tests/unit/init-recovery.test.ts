import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InitializationRecoverySession,
  type InitializationRecoveryEvidence,
} from '../../src/application/init-recovery.js';
import type { LibraryInitPlan } from '../../src/application/library-lifecycle.js';
import { listRecoveryRecords } from '../../src/application/recovery.js';
import type { ApplicationPaths } from '../../src/infrastructure/config.js';
import { normalizeGitRemote } from '../../src/infrastructure/git.js';
import { readOperationJournal } from '../../src/infrastructure/transactions.js';
import type {
  RuntimeRecoveryParticipant,
  RuntimeRecoveryRegistration,
} from '../../src/runtime/boundary.js';
import { OperationGuard } from '../../src/runtime/operation-guard.js';
import { withTempDirectory } from '../helpers/temp.js';

function initPlan(): LibraryInitPlan {
  const remote = normalizeGitRemote('https://github.com/acme/skills.git');
  return {
    action: 'create',
    applied: false,
    branch: 'main',
    configuration: {
      beforeFingerprint: `config-v1-${'a'.repeat(64)}`,
      changed: true,
      nextIdentity: remote.identity,
      previousIdentity: null,
    },
    dryRun: true,
    effects: {
      cache: 'refresh',
      configuration: 'write',
      githubRepository: 'create',
      remoteLibrary: 'initialize',
    },
    fingerprint: `init-v1-${'b'.repeat(64)}`,
    operation: 'init',
    remote,
    remoteState: 'available',
    repository: 'acme/skills',
    revision: null,
    validation: null,
    visibility: 'private',
  };
}

function parseEvidence(note: string | undefined): InitializationRecoveryEvidence {
  if (note === undefined) throw new Error('Expected initialization recovery evidence.');
  return JSON.parse(note) as InitializationRecoveryEvidence;
}

describe('initialization recovery evidence', () => {
  it('completes and removes evidence when no effect needed to begin', async () => {
    await withTempDirectory('skill-sync-init-recovery-noop-', async (root) => {
      let participant: RuntimeRecoveryParticipant | undefined;
      const session = await InitializationRecoverySession.create(initPlan(), {
        journalDirectory: join(root, 'journals'),
        operationGuard: new OperationGuard(new AbortController().signal),
        registerRecovery: (value) => {
          participant = value;
          return { complete: () => undefined };
        },
        rootFingerprint: 'f'.repeat(64),
      });

      await session.complete();

      await expect(
        stat(join(root, 'journals', `${participant?.id ?? ''}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('writes each external commit phase before removing successful evidence', async () => {
    await withTempDirectory('skill-sync-init-recovery-', async (root) => {
      const controller = new AbortController();
      const guard = new OperationGuard(controller.signal);
      let participant: RuntimeRecoveryParticipant | undefined;
      let registrationCompleted = false;
      const registration: RuntimeRecoveryRegistration = {
        complete: () => {
          registrationCompleted = true;
        },
      };
      const session = await InitializationRecoverySession.create(initPlan(), {
        journalDirectory: join(root, 'journals'),
        operationGuard: guard,
        registerRecovery: (value) => {
          participant = value;
          return registration;
        },
        rootFingerprint: 'c'.repeat(64),
      });
      expect(participant?.id).toMatch(/^init-/u);

      await session.begin('provider');
      expect(guard.state).toBe('committing');
      await session.confirm('provider');
      expect(guard.state).toBe('committed');
      await session.begin('push');
      await session.confirm('push', { expectedRevision: 'd'.repeat(40) });
      await session.begin('configuration');
      await session.confirm('configuration');

      const journalPath = join(root, 'journals', `${participant?.id ?? ''}.json`);
      const journal = await readOperationJournal(journalPath);
      expect(journal).toMatchObject({ kind: 'library-initialization', status: 'committing' });
      expect(parseEvidence(journal.note)).toMatchObject({
        configuration: 'confirmed',
        expectedRevision: 'd'.repeat(40),
        provider: 'confirmed',
        push: 'confirmed',
      });

      await session.complete();

      expect(registrationCompleted).toBe(true);
      await expect(stat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(guard.outcome()).toMatchObject({ kind: 'committed' });
    });
  });

  it('retains inspect-only attempted evidence when a commit boundary fails', async () => {
    await withTempDirectory('skill-sync-init-recovery-failed-', async (root) => {
      const guard = new OperationGuard(new AbortController().signal);
      let participant: RuntimeRecoveryParticipant | undefined;
      const session = await InitializationRecoverySession.create(initPlan(), {
        journalDirectory: join(root, 'journals'),
        operationGuard: guard,
        registerRecovery: (value) => {
          participant = value;
          return { complete: () => undefined };
        },
        rootFingerprint: 'e'.repeat(64),
      });
      await session.begin('provider');
      await participant?.journal?.({
        code: 'RECOVERY_REQUIRED',
        message: 'Provider result is unknown.',
        reason: 'failure',
        signal: null,
      });

      const journalPath = join(root, 'journals', `${participant?.id ?? ''}.json`);
      const journal = await readOperationJournal(journalPath);
      expect(journal.status).toBe('failed');
      expect(parseEvidence(journal.note)).toMatchObject({
        failure: { code: 'RECOVERY_REQUIRED', reason: 'failure' },
        provider: 'attempted',
        push: 'prepared',
      });
      expect(guard.outcome()).toMatchObject({ kind: 'recovery-required' });
      const paths: ApplicationPaths = {
        backupsDirectory: join(root, 'backups'),
        cacheDirectory: join(root, 'cache'),
        configDirectory: join(root, 'config'),
        configFile: join(root, 'config', 'config.json'),
        journalsDirectory: join(root, 'journals'),
        locksDirectory: join(root, 'locks'),
        stateDirectory: root,
      };
      expect(await listRecoveryRecords(paths)).toEqual([
        expect.objectContaining({
          inspectOnly: true,
          kind: 'journal',
          operationKind: 'library-initialization',
          scopeKind: 'library',
          status: 'failed',
        }),
      ]);
    });
  });

  it('removes write-ahead evidence when failure happens before any effect attempt', async () => {
    await withTempDirectory('skill-sync-init-recovery-preparation-', async (root) => {
      let participant: RuntimeRecoveryParticipant | undefined;
      await InitializationRecoverySession.create(initPlan(), {
        journalDirectory: join(root, 'journals'),
        operationGuard: new OperationGuard(new AbortController().signal),
        registerRecovery: (value) => {
          participant = value;
          return { complete: () => undefined };
        },
        rootFingerprint: '0'.repeat(64),
      });

      await participant?.journal?.({
        code: 'CANCELLED',
        message: 'Cancelled before provider creation.',
        reason: 'cancelled',
        signal: 'SIGINT',
      });

      await expect(
        stat(join(root, 'journals', `${participant?.id ?? ''}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('clears older evidence for the same remote after a successful reconciliation', async () => {
    await withTempDirectory('skill-sync-init-recovery-reconciled-', async (root) => {
      const journalDirectory = join(root, 'journals');
      let failedParticipant: RuntimeRecoveryParticipant | undefined;
      const failed = await InitializationRecoverySession.create(initPlan(), {
        journalDirectory,
        operationGuard: new OperationGuard(new AbortController().signal),
        registerRecovery: (value) => {
          failedParticipant = value;
          return { complete: () => undefined };
        },
        rootFingerprint: '1'.repeat(64),
      });
      await failed.begin('provider');
      await failedParticipant?.journal?.({
        code: 'RECOVERY_REQUIRED',
        message: 'Provider result is unknown.',
        reason: 'failure',
        signal: null,
      });

      const successful = await InitializationRecoverySession.create(initPlan(), {
        journalDirectory,
        operationGuard: new OperationGuard(new AbortController().signal),
        registerRecovery: () => ({ complete: () => undefined }),
        rootFingerprint: '1'.repeat(64),
      });
      await successful.complete();

      expect(
        await listRecoveryRecords({
          backupsDirectory: join(root, 'backups'),
          cacheDirectory: join(root, 'cache'),
          configDirectory: join(root, 'config'),
          configFile: join(root, 'config', 'config.json'),
          journalsDirectory: journalDirectory,
          locksDirectory: join(root, 'locks'),
          stateDirectory: root,
        }),
      ).toEqual([]);
    });
  });
});
