import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { LibraryInitPlan } from './library-lifecycle.js';

import { redactCredentials } from '../infrastructure/config.js';
import { stableJsonStringify } from '../infrastructure/stable-json.js';
import {
  createOperationJournalV2,
  readOperationJournal,
  updateOperationJournalV2,
  type OperationJournalStatus,
} from '../infrastructure/transactions.js';
import type {
  RuntimeBoundaryContext,
  RuntimeRecoveryContext,
  RuntimeRecoveryRegistration,
} from '../runtime/boundary.js';
import type { OperationGuard } from '../runtime/operation-guard.js';

export type InitializationRecoveryEffect = 'configuration' | 'provider' | 'push';
type InitializationRecoveryEffectState =
  'not-planned' | 'prepared' | 'attempted' | 'confirmed' | 'rolled-back';

export interface InitializationRecoveryEvidence {
  readonly branch: string;
  readonly configuration: InitializationRecoveryEffectState;
  readonly expectedRevision: string | null;
  readonly failure?: {
    readonly code: string;
    readonly message: string;
    readonly reason: RuntimeRecoveryContext['reason'];
    readonly signal: RuntimeRecoveryContext['signal'];
  };
  readonly planFingerprint: string;
  readonly provider: InitializationRecoveryEffectState;
  readonly push: InitializationRecoveryEffectState;
  readonly remote: {
    readonly cloneUrl: string;
    readonly identity: string;
  };
  readonly schemaVersion: 1;
}

export interface InitializationRecoveryRuntime {
  readonly journalDirectory: string;
  readonly operationGuard: OperationGuard;
  readonly registerRecovery: RuntimeBoundaryContext['registerRecovery'];
  readonly rootFingerprint: string;
}

function initialEvidence(plan: LibraryInitPlan): InitializationRecoveryEvidence {
  return {
    branch: plan.branch,
    configuration: plan.effects.configuration === 'write' ? 'prepared' : 'not-planned',
    expectedRevision: plan.revision,
    planFingerprint: plan.fingerprint,
    provider: plan.effects.githubRepository === 'create' ? 'prepared' : 'not-planned',
    push: plan.effects.remoteLibrary === 'initialize' ? 'prepared' : 'not-planned',
    remote: {
      cloneUrl: plan.remote.cloneUrl,
      identity: plan.remote.identity,
    },
    schemaVersion: 1,
  };
}

function evidenceNote(evidence: InitializationRecoveryEvidence): string {
  return stableJsonStringify(evidence).trim();
}

function initializationScopeId(remoteIdentity: string): string {
  return createHash('sha256').update(remoteIdentity).digest('hex');
}

/**
 * Write-ahead evidence for initialization effects that cannot be safely
 * replayed or rolled back automatically. The recovery UI treats these journals
 * as inspect-only and directs the user back through a fresh setup preview.
 */
export class InitializationRecoverySession {
  private evidence: InitializationRecoveryEvidence;
  private finished = false;
  private registration: RuntimeRecoveryRegistration | undefined;

  private constructor(
    private readonly path: string,
    private readonly operationId: string,
    private readonly runtime: InitializationRecoveryRuntime,
    evidence: InitializationRecoveryEvidence,
  ) {
    this.evidence = evidence;
  }

  static async create(
    plan: LibraryInitPlan,
    runtime: InitializationRecoveryRuntime,
  ): Promise<InitializationRecoverySession> {
    const operationId = `init-${randomUUID()}`;
    const evidence = initialEvidence(plan);
    const journal = await createOperationJournalV2(runtime.journalDirectory, {
      entries: [],
      kind: 'library-initialization',
      note: evidenceNote(evidence),
      operationId,
      rootFingerprint: runtime.rootFingerprint,
      scope: {
        id: initializationScopeId(plan.remote.identity),
        kind: 'library',
      },
    });
    const session = new InitializationRecoverySession(journal.path, operationId, runtime, evidence);
    session.registration = runtime.registerRecovery({
      id: operationId,
      journal: async (context) => await session.recordFailure(context),
    });
    return session;
  }

  async begin(effect: InitializationRecoveryEffect): Promise<void> {
    this.runtime.operationGuard.throwIfCancelled();
    this.evidence = { ...this.evidence, [effect]: 'attempted' };
    await this.update('committing');
    this.runtime.operationGuard.beginCommit();
  }

  async confirm(
    effect: InitializationRecoveryEffect,
    options: { readonly expectedRevision?: string } = {},
  ): Promise<void> {
    this.evidence = {
      ...this.evidence,
      [effect]: 'confirmed',
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
    };
    await this.update('committing');
    this.runtime.operationGuard.markCommitted();
  }

  async markRolledBack(effect: InitializationRecoveryEffect): Promise<void> {
    this.evidence = { ...this.evidence, [effect]: 'rolled-back' };
    await this.update('committing');
    this.runtime.operationGuard.markRolledBack();
  }

  markRecoveryRequired(): void {
    this.runtime.operationGuard.markRecoveryRequired();
  }

  async complete(): Promise<void> {
    // A connect plan can discover that the reviewed configuration is already
    // current, so no effect ever calls begin(). Move through the normal
    // transition explicitly before recording the terminal success.
    await this.update('committing');
    await this.update('committed');
    this.finished = true;
    this.registration?.complete();
    await this.removeResolvedEvidence();
  }

  private async recordFailure(context: RuntimeRecoveryContext): Promise<void> {
    if (this.finished) return;
    if (!this.hasAttemptedEffect()) {
      this.finished = true;
      await rm(this.path, { force: true });
      return;
    }
    this.evidence = {
      ...this.evidence,
      failure: {
        code: context.code,
        message: redactCredentials(context.message),
        reason: context.reason,
        signal: context.signal,
      },
    };
    await this.update('failed');
  }

  private hasAttemptedEffect(): boolean {
    return (['configuration', 'provider', 'push'] as const).some((effect) =>
      ['attempted', 'confirmed', 'rolled-back'].includes(this.evidence[effect]),
    );
  }

  private async update(status: OperationJournalStatus): Promise<void> {
    await updateOperationJournalV2(this.path, {
      note: evidenceNote(this.evidence),
      status,
    });
  }

  private async removeResolvedEvidence(): Promise<void> {
    const expectedScope = initializationScopeId(this.evidence.remote.identity);
    let names: string[];
    try {
      names = await readdir(this.runtime.journalDirectory);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const path = join(this.runtime.journalDirectory, name);
          try {
            const journal = await readOperationJournal(path);
            if (
              journal.schemaVersion === 2 &&
              journal.kind === 'library-initialization' &&
              journal.scope.kind === 'library' &&
              journal.scope.id === expectedScope
            ) {
              await rm(path, { force: true });
            }
          } catch {
            // Successful initialization only clears verified matching evidence.
          }
        }),
    );
  }
}
