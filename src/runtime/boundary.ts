import process from 'node:process';

import {
  EXIT_CODES,
  type CommandResult,
  type ExitCode,
  redactSecrets,
  resultFromUnknown,
  sanitizeError,
  SkillSyncError,
  type StructuredError,
} from '../domain/result.js';

type FailedCommandResult = Extract<CommandResult<unknown>, { readonly ok: false }>;

export type RuntimeSignal = 'SIGINT' | 'SIGTERM';
export type RuntimeFailureReason = 'cancelled' | 'failure';

export interface RuntimeSignalSource {
  addListener(signal: RuntimeSignal, listener: () => void): void;
  removeListener(signal: RuntimeSignal, listener: () => void): void;
}

export const nodeRuntimeSignalSource: RuntimeSignalSource = {
  addListener: (signal, listener) => {
    process.on(signal, listener);
  },
  removeListener: (signal, listener) => {
    process.off(signal, listener);
  },
};

export interface RuntimeBoundaryDiagnostic {
  readonly level: 'warning' | 'error';
  readonly code:
    'CANCELLED' | 'INTERNAL_ERROR' | 'RECOVERY_JOURNAL_FAILED' | 'RECOVERY_ROLLBACK_FAILED';
  readonly message: string;
}

export interface RuntimeRecoveryContext {
  readonly reason: RuntimeFailureReason;
  readonly code: string;
  readonly message: string;
  readonly signal: RuntimeSignal | null;
}

/**
 * An in-flight mutation can cooperate with the boundary by durably noting the
 * interruption and/or rolling back staged state. Neither callback receives the
 * raw thrown error, so credentials cannot leak into journals by accident.
 */
export interface RuntimeRecoveryParticipant {
  readonly id: string;
  readonly journal?: (context: RuntimeRecoveryContext) => Promise<void> | void;
  readonly rollback?: (context: RuntimeRecoveryContext) => Promise<void> | void;
}

export interface RuntimeRecoveryRegistration {
  /** Mark the participant committed or otherwise no longer in flight. */
  complete(): void;
}

export interface RuntimeBoundaryContext {
  readonly signal: AbortSignal;
  readonly registerRecovery: (
    participant: RuntimeRecoveryParticipant,
  ) => RuntimeRecoveryRegistration;
  readonly throwIfCancelled: () => void;
}

export interface RuntimeBoundaryOptions {
  readonly diagnostics?: (diagnostic: RuntimeBoundaryDiagnostic) => void;
  readonly signalSource?: RuntimeSignalSource;
  readonly signals?: readonly RuntimeSignal[];
}

export class RuntimeCancellationError extends SkillSyncError {
  public readonly signal: RuntimeSignal | null;

  public constructor(signal: RuntimeSignal | null = null) {
    super(
      'CANCELLED',
      signal === null ? 'Operation cancelled.' : `Operation interrupted by ${signal}.`,
      EXIT_CODES.cancelled,
    );
    this.name = 'RuntimeCancellationError';
    this.signal = signal;
  }
}

function safeDiagnostic(
  sink: RuntimeBoundaryOptions['diagnostics'],
  diagnostic: RuntimeBoundaryDiagnostic,
): void {
  if (sink === undefined) return;
  try {
    sink({ ...diagnostic, message: redactSecrets(diagnostic.message) });
  } catch {
    // Diagnostics must never replace the command's stable result or interrupt recovery.
  }
}

function sanitizeResult<T>(result: CommandResult<T>): CommandResult<T> {
  if (result.ok) return result;
  return {
    ok: false,
    errors: result.errors.map(sanitizeError),
    exitCode: result.exitCode,
  };
}

function sanitizeFailure(result: FailedCommandResult): FailedCommandResult {
  return {
    ok: false,
    errors: result.errors.map(sanitizeError),
    exitCode: result.exitCode,
  };
}

function firstError(result: FailedCommandResult): StructuredError {
  return (
    result.errors[0] ?? {
      code: 'INTERNAL_ERROR',
      message: 'The operation failed without an error diagnostic.',
    }
  );
}

function errorIsCancellation(error: unknown): boolean {
  if (error instanceof SkillSyncError && error.exitCode === EXIT_CODES.cancelled) return true;
  return (
    error instanceof Error &&
    ['AbortError', 'AbortPromptError', 'ExitPromptError'].includes(error.name)
  );
}

function cancellationResult(signal: RuntimeSignal | null): FailedCommandResult {
  return {
    ok: false,
    errors: [
      {
        code: 'CANCELLED',
        message: signal === null ? 'Operation cancelled.' : `Operation interrupted by ${signal}.`,
      },
    ],
    exitCode: EXIT_CODES.cancelled,
  };
}

function failedResultFromUnknown(error: unknown): FailedCommandResult {
  const result = resultFromUnknown(error);
  if (!result.ok) return result;
  return {
    ok: false,
    errors: [{ code: 'INTERNAL_ERROR', message: 'Unexpected internal failure.' }],
    exitCode: EXIT_CODES.internal,
  };
}

function failureReason(exitCode: ExitCode): RuntimeFailureReason {
  return exitCode === EXIT_CODES.cancelled ? 'cancelled' : 'failure';
}

/**
 * Execute one command operation behind cooperative signal/error handling.
 * Signal listeners are scoped to this call and are always removed. Operations
 * must observe `context.signal` or call `throwIfCancelled` at safe mutation
 * checkpoints; the boundary waits for that cooperation instead of returning
 * while an unobserved mutation continues in the background.
 */
export async function runWithRuntimeBoundary<T>(
  operation: (context: RuntimeBoundaryContext) => Promise<CommandResult<T>>,
  options: RuntimeBoundaryOptions = {},
): Promise<CommandResult<T>> {
  const signalSource = options.signalSource ?? nodeRuntimeSignalSource;
  const configuredSignals = [...new Set<RuntimeSignal>(options.signals ?? ['SIGINT', 'SIGTERM'])];
  const abortController = new AbortController();
  const participants = new Map<symbol, RuntimeRecoveryParticipant>();
  const runtimeState: { receivedSignal: RuntimeSignal | null } = { receivedSignal: null };

  const listeners = new Map<RuntimeSignal, () => void>();
  for (const runtimeSignal of configuredSignals) {
    const listener = () => {
      if (runtimeState.receivedSignal !== null) return;
      runtimeState.receivedSignal = runtimeSignal;
      abortController.abort(new RuntimeCancellationError(runtimeSignal));
      safeDiagnostic(options.diagnostics, {
        level: 'warning',
        code: 'CANCELLED',
        message: `Operation interrupted by ${runtimeSignal}.`,
      });
    };
    listeners.set(runtimeSignal, listener);
    signalSource.addListener(runtimeSignal, listener);
  }

  const context: RuntimeBoundaryContext = {
    signal: abortController.signal,
    registerRecovery: (participant) => {
      if (participant.journal === undefined && participant.rollback === undefined) {
        throw new Error(`Recovery participant "${participant.id}" has no recovery callback.`);
      }
      const key = Symbol(participant.id);
      participants.set(key, participant);
      let completed = false;
      return {
        complete: () => {
          if (completed) return;
          completed = true;
          participants.delete(key);
        },
      };
    },
    throwIfCancelled: () => {
      if (abortController.signal.aborted) {
        throw new RuntimeCancellationError(runtimeState.receivedSignal);
      }
    },
  };

  let recoveryPromise: Promise<void> | undefined;
  const recover = (result: FailedCommandResult): Promise<void> => {
    if (recoveryPromise !== undefined) return recoveryPromise;
    recoveryPromise = (async () => {
      const diagnostic = firstError(result);
      const recoveryContext: RuntimeRecoveryContext = {
        reason: failureReason(result.exitCode),
        code: diagnostic.code,
        message: redactSecrets(diagnostic.message),
        signal: runtimeState.receivedSignal,
      };
      const active = [...participants.values()];

      for (const participant of active) {
        if (participant.journal === undefined) continue;
        try {
          await participant.journal(recoveryContext);
        } catch (error) {
          safeDiagnostic(options.diagnostics, {
            level: 'error',
            code: 'RECOVERY_JOURNAL_FAILED',
            message: `Could not journal recovery for "${participant.id}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }

      for (const participant of active.reverse()) {
        if (participant.rollback === undefined) continue;
        try {
          await participant.rollback(recoveryContext);
        } catch (error) {
          safeDiagnostic(options.diagnostics, {
            level: 'error',
            code: 'RECOVERY_ROLLBACK_FAILED',
            message: `Could not roll back "${participant.id}": ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
      }
    })();
    return recoveryPromise;
  };

  try {
    context.throwIfCancelled();
    const rawResult = await operation(context);
    if (runtimeState.receivedSignal !== null || abortController.signal.aborted) {
      const cancelled = sanitizeFailure(cancellationResult(runtimeState.receivedSignal));
      await recover(cancelled);
      return cancelled;
    }

    const result = sanitizeResult(rawResult);
    if (!result.ok) await recover(result);
    return result;
  } catch (error) {
    const cancelled =
      runtimeState.receivedSignal !== null ||
      abortController.signal.aborted ||
      errorIsCancellation(error);
    const expected = error instanceof SkillSyncError;
    const result = sanitizeFailure(
      cancelled ? cancellationResult(runtimeState.receivedSignal) : failedResultFromUnknown(error),
    );
    await recover(result);

    if (!cancelled && !expected) {
      const diagnostic = firstError(result);
      safeDiagnostic(options.diagnostics, {
        level: 'error',
        code: 'INTERNAL_ERROR',
        message: diagnostic.message,
      });
    }
    return result;
  } finally {
    for (const [runtimeSignal, listener] of listeners) {
      signalSource.removeListener(runtimeSignal, listener);
    }
    participants.clear();
  }
}
