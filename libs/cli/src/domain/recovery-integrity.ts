export type RecoveryIntegrityFailureKind =
  'ambiguous-commit' | 'failed-rollback' | 'journal-transition' | 'lock-ownership';

/**
 * Marks failures after which later mutations in the same managed scope are unsafe.
 * Callers must preserve recovery evidence and stop the batch immediately.
 */
export class RecoveryIntegrityError extends SkillSyncError {
  public override readonly cause: unknown;
  public readonly recoveryRequired = true;

  public constructor(
    public readonly kind: RecoveryIntegrityFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super('RECOVERY_REQUIRED', message, EXIT_CODES.conflict, { recoveryKind: kind });
    this.cause = options?.cause;
    this.name = 'RecoveryIntegrityError';
  }
}

export class JournalTransitionError extends RecoveryIntegrityError {
  public constructor(path: string, options: { readonly cause: unknown }) {
    const causeMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(
      'journal-transition',
      `The recovery journal could not be durably transitioned: ${path}. ${causeMessage}`,
      options,
    );
    this.name = 'JournalTransitionError';
  }
}

export class TransactionRolledBackError extends Error {
  public readonly rollbackProven = true;

  public constructor(options: { readonly cause: unknown }) {
    const causeMessage =
      options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`The transaction failed and was durably rolled back: ${causeMessage}`, options);
    this.name = 'TransactionRolledBackError';
  }
}

export function isRecoveryIntegrityError(error: unknown): error is RecoveryIntegrityError {
  return error instanceof RecoveryIntegrityError;
}

export function isTransactionRolledBackError(error: unknown): error is TransactionRolledBackError {
  return error instanceof TransactionRolledBackError;
}
import { EXIT_CODES, SkillSyncError } from './result.js';
