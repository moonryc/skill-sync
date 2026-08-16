import { describe, expect, it } from 'vitest';

import {
  OperationGuard,
  OperationGuardCancellationError,
} from '../../src/runtime/operation-guard.js';

describe('commit-aware operation guard', () => {
  it('reports pre-commit cancellation without entering commit', () => {
    const controller = new AbortController();
    const guard = new OperationGuard(controller.signal);
    controller.abort();

    expect(() => guard.throwIfCancelled()).toThrow(OperationGuardCancellationError);
    expect(() => guard.beginCommit()).toThrow(OperationGuardCancellationError);
    expect(guard.outcome()).toEqual({ kind: 'cancelled', state: 'preparing' });
  });

  it('defers cancellation during commit and preserves committed success', () => {
    const controller = new AbortController();
    const guard = new OperationGuard(controller.signal);
    guard.beginCommit();
    controller.abort();

    expect(() => guard.throwIfCancelled()).not.toThrow();
    expect(guard.outcome()).toEqual({ kind: 'recovery-required', state: 'committing' });
    guard.markCommitted();
    expect(guard.outcome()).toEqual({
      interrupted: true,
      kind: 'committed',
      state: 'committed',
    });
  });

  it('distinguishes proven rollback from ambiguous recovery-required state', () => {
    const controller = new AbortController();
    const rolledBack = new OperationGuard(controller.signal);
    rolledBack.beginCommit();
    controller.abort();
    rolledBack.markRolledBack();
    expect(rolledBack.outcome()).toEqual({ kind: 'cancelled', state: 'rolled-back' });

    const ambiguous = new OperationGuard(new AbortController().signal);
    ambiguous.beginCommit();
    ambiguous.markRecoveryRequired();
    expect(ambiguous.outcome()).toEqual({
      kind: 'recovery-required',
      state: 'recovery-required',
    });
  });

  it('preserves an earlier committed outcome across later transaction cycles', () => {
    const controller = new AbortController();
    const guard = new OperationGuard(controller.signal);

    guard.beginCommit();
    guard.markCommitted();
    guard.beginCommit();
    guard.markRolledBack();
    controller.abort();

    expect(() => guard.throwIfCancelled()).not.toThrow();
    expect(guard.outcome()).toEqual({
      interrupted: true,
      kind: 'committed',
      state: 'committed',
    });
  });

  it('rejects impossible state transitions', () => {
    const guard = new OperationGuard(new AbortController().signal);
    expect(() => guard.markCommitted()).toThrow(/Cannot mark operation committed/u);
    guard.beginCommit();
    guard.markCommitted();
    expect(() => guard.markRolledBack()).toThrow(/Cannot mark operation rolled back/u);
    expect(() => guard.markRecoveryRequired()).toThrow(/Cannot require recovery/u);
  });
});
