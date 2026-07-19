import { describe, expect, it } from 'vitest';

import { EXIT_CODES, failure, SkillSyncError, success } from '../../src/domain/result.js';
import {
  runWithRuntimeBoundary,
  type RuntimeBoundaryDiagnostic,
  type RuntimeSignal,
  type RuntimeSignalSource,
} from '../../src/runtime/boundary.js';

class FakeSignalSource implements RuntimeSignalSource {
  private readonly listeners = new Map<RuntimeSignal, Set<() => void>>();

  addListener(signal: RuntimeSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  removeListener(signal: RuntimeSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  emit(signal: RuntimeSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolvePromise?.();
    },
  };
}

describe('runtime command boundary', () => {
  it('preserves successful results and removes scoped signal listeners', async () => {
    const signals = new FakeSignalSource();
    await expect(
      runWithRuntimeBoundary(
        async ({ signal }) => {
          expect(signal.aborted).toBe(false);
          return Promise.resolve(success({ value: 1 }));
        },
        { signalSource: signals },
      ),
    ).resolves.toEqual(success({ value: 1 }));
    expect(signals.listenerCount()).toBe(0);
  });

  it('suppresses stacks and redacts expected operational failures', async () => {
    const diagnostics: RuntimeBoundaryDiagnostic[] = [];
    const error = new SkillSyncError(
      'REPOSITORY_DENIED',
      'denied https://moon:secret@github.com/example/skills.git?token=top-secret',
      EXIT_CODES.repository,
    );
    error.stack = 'STACK MUST NOT APPEAR token=stack-secret';

    const result = await runWithRuntimeBoundary(() => Promise.reject(error), {
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      signalSource: new FakeSignalSource(),
    });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 4,
      errors: [{ code: 'REPOSITORY_DENIED' }],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('STACK MUST NOT APPEAR');
    expect(diagnostics).toEqual([]);
  });

  it('maps unexpected exceptions to one stable redacted internal diagnostic', async () => {
    const diagnostics: RuntimeBoundaryDiagnostic[] = [];
    const result = await runWithRuntimeBoundary(
      () => Promise.reject(new Error('token=github_pat_abcdefghijklmnopqrstuvwxyz')),
      {
        diagnostics: (diagnostic) => diagnostics.push(diagnostic),
        signalSource: new FakeSignalSource(),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      errors: [{ code: 'INTERNAL_ERROR' }],
    });
    expect(JSON.stringify(result)).not.toContain('github_pat_');
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'INTERNAL_ERROR', level: 'error' }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('github_pat_');
  });

  it('turns cooperative SIGINT interruption into cancellation status 130', async () => {
    const signals = new FakeSignalSource();
    const started = deferred();
    const events: string[] = [];
    const contexts: string[] = [];

    const running = runWithRuntimeBoundary(
      async (context) => {
        context.registerRecovery({
          id: 'first',
          journal: (recovery) => {
            events.push('journal:first');
            contexts.push(JSON.stringify(recovery));
          },
          rollback: () => {
            events.push('rollback:first');
          },
        });
        context.registerRecovery({
          id: 'second',
          journal: () => {
            events.push('journal:second');
          },
          rollback: () => {
            events.push('rollback:second');
          },
        });
        started.resolve();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              try {
                context.throwIfCancelled();
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            },
            { once: true },
          );
        });
        return success({ unreachable: true });
      },
      { signalSource: signals },
    );

    await started.promise;
    signals.emit('SIGINT');
    const result = await running;
    expect(result).toMatchObject({ ok: false, exitCode: 130, errors: [{ code: 'CANCELLED' }] });
    expect(events).toEqual([
      'journal:first',
      'journal:second',
      'rollback:second',
      'rollback:first',
    ]);
    expect(contexts).toEqual([expect.stringContaining('"reason":"cancelled"')]);
    expect(signals.listenerCount()).toBe(0);
  });

  it('cooperates with recovery for returned failures and skips completed participants', async () => {
    const events: string[] = [];
    const result = await runWithRuntimeBoundary(
      ({ registerRecovery }) => {
        registerRecovery({
          id: 'active',
          journal: () => {
            events.push('journal:active');
          },
          rollback: () => {
            events.push('rollback:active');
          },
        });
        const committed = registerRecovery({
          id: 'committed',
          rollback: () => {
            events.push('rollback:committed');
          },
        });
        committed.complete();
        return Promise.resolve(
          failure({ code: 'VALIDATION_FAILED', message: 'invalid content' }, EXIT_CODES.validation),
        );
      },
      { signalSource: new FakeSignalSource() },
    );
    expect(result).toMatchObject({ ok: false, exitCode: 3 });
    expect(events).toEqual(['journal:active', 'rollback:active']);
  });

  it('continues rollback after a recovery hook fails and redacts its diagnostic', async () => {
    const events: string[] = [];
    const diagnostics: RuntimeBoundaryDiagnostic[] = [];
    const result = await runWithRuntimeBoundary(
      ({ registerRecovery }) => {
        registerRecovery({
          id: 'later',
          rollback: () => {
            events.push('rollback:later');
          },
        });
        registerRecovery({
          id: 'failing token=participant-secret',
          journal: () => {
            throw new Error('token=journal-secret');
          },
          rollback: () => {
            throw new Error('password=rollback-secret');
          },
        });
        throw new Error('token=operation-secret');
      },
      {
        diagnostics: (diagnostic) => diagnostics.push(diagnostic),
        signalSource: new FakeSignalSource(),
      },
    );

    expect(result).toMatchObject({ ok: false, exitCode: 1 });
    expect(events).toEqual(['rollback:later']);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'RECOVERY_JOURNAL_FAILED',
      'RECOVERY_ROLLBACK_FAILED',
      'INTERNAL_ERROR',
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('participant-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('journal-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('rollback-secret');
    expect(JSON.stringify(diagnostics)).not.toContain('operation-secret');
  });

  it('maps AbortError-style prompt cancellation to status 130 without a stack', async () => {
    const abort = new Error('prompt aborted');
    abort.name = 'AbortError';
    abort.stack = 'PROMPT STACK';
    const result = await runWithRuntimeBoundary(() => Promise.reject(abort), {
      signalSource: new FakeSignalSource(),
    });
    expect(result).toMatchObject({ ok: false, exitCode: 130, errors: [{ code: 'CANCELLED' }] });
    expect(JSON.stringify(result)).not.toContain('PROMPT STACK');
  });
});
