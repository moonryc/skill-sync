import { EXIT_CODES, SkillSyncError } from '../domain/result.js';

export type OperationGuardState =
  'preparing' | 'committing' | 'committed' | 'rolled-back' | 'recovery-required';

export type OperationGuardOutcome =
  | { readonly kind: 'pending'; readonly state: 'preparing' }
  | { readonly kind: 'cancelled'; readonly state: 'preparing' | 'rolled-back' }
  | { readonly interrupted: boolean; readonly kind: 'committed'; readonly state: 'committed' }
  | {
      readonly kind: 'recovery-required';
      readonly state: 'committing' | 'recovery-required';
    }
  | { readonly kind: 'rolled-back'; readonly state: 'rolled-back' };

export class OperationGuardCancellationError extends SkillSyncError {
  public constructor() {
    super('CANCELLED', 'Operation cancelled before commit.', EXIT_CODES.cancelled);
    this.name = 'OperationGuardCancellationError';
  }
}

export class OperationGuardStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OperationGuardStateError';
  }
}

/**
 * Tracks the durable mutation boundary independently from command presentation.
 * Cancellation is actionable during preparation, deferred during commit, and
 * cannot replace a proven committed result.
 */
export class OperationGuard {
  private currentState: OperationGuardState = 'preparing';
  private committedAtLeastOnce = false;

  public constructor(private readonly signal: AbortSignal) {}

  public get state(): OperationGuardState {
    return this.currentState;
  }

  public throwIfCancelled(): void {
    if (
      this.signal.aborted &&
      !this.committedAtLeastOnce &&
      (this.currentState === 'preparing' || this.currentState === 'rolled-back')
    ) {
      throw new OperationGuardCancellationError();
    }
  }

  public beginCommit(): void {
    if (!['preparing', 'committed', 'rolled-back'].includes(this.currentState)) {
      throw new OperationGuardStateError(
        `Cannot begin commit while operation is ${this.currentState}.`,
      );
    }
    this.throwIfCancelled();
    this.currentState = 'committing';
  }

  public markCommitted(): void {
    if (this.currentState !== 'committing') {
      throw new OperationGuardStateError(
        `Cannot mark operation committed while it is ${this.currentState}.`,
      );
    }
    this.committedAtLeastOnce = true;
    this.currentState = 'committed';
  }

  public markRolledBack(): void {
    if (!['preparing', 'committing', 'recovery-required'].includes(this.currentState)) {
      throw new OperationGuardStateError(
        `Cannot mark operation rolled back while it is ${this.currentState}.`,
      );
    }
    this.currentState = 'rolled-back';
  }

  public markRecoveryRequired(): void {
    if (this.currentState === 'committed' || this.currentState === 'rolled-back') {
      throw new OperationGuardStateError(
        `Cannot require recovery after operation is ${this.currentState}.`,
      );
    }
    this.currentState = 'recovery-required';
  }

  public outcome(): OperationGuardOutcome {
    if (
      this.committedAtLeastOnce &&
      this.currentState !== 'committing' &&
      this.currentState !== 'recovery-required'
    ) {
      return { interrupted: this.signal.aborted, kind: 'committed', state: 'committed' };
    }
    if (this.currentState === 'committing' || this.currentState === 'recovery-required') {
      return { kind: 'recovery-required', state: this.currentState };
    }
    if (this.currentState === 'rolled-back') {
      return this.signal.aborted
        ? { kind: 'cancelled', state: 'rolled-back' }
        : { kind: 'rolled-back', state: 'rolled-back' };
    }
    return this.signal.aborted
      ? { kind: 'cancelled', state: 'preparing' }
      : { kind: 'pending', state: 'preparing' };
  }
}
