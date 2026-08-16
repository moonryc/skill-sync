import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { success } from '../../src/domain/result.js';
import {
  replacePathsAtomically,
  type TransactionDurableStep,
} from '../../src/infrastructure/transactions.js';
import {
  runWithRuntimeBoundary,
  type RuntimeBoundaryDiagnostic,
  type RuntimeSignal,
  type RuntimeSignalSource,
} from '../../src/runtime/boundary.js';
import { withTempDirectory } from '../helpers/temp.js';

class TestSignalSource implements RuntimeSignalSource {
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
}

async function runInterruptedReplacement(
  root: string,
  signalAt: TransactionDurableStep,
): Promise<{
  readonly contents: string;
  readonly diagnostics: readonly RuntimeBoundaryDiagnostic[];
  readonly result: Awaited<ReturnType<typeof runWithRuntimeBoundary>>;
}> {
  const project = join(root, 'project');
  const destination = join(project, '.codex', 'skills', 'example');
  const staged = join(root, 'staged');
  await mkdir(destination, { recursive: true });
  await mkdir(staged);
  await writeFile(join(destination, 'SKILL.md'), 'old');
  await writeFile(join(staged, 'SKILL.md'), 'new');
  const signals = new TestSignalSource();
  const diagnostics: RuntimeBoundaryDiagnostic[] = [];
  let emitted = false;

  const result = await runWithRuntimeBoundary(
    async (context) => {
      await replacePathsAtomically({
        hooks: {
          afterDurableStep: (step) => {
            if (!emitted && step === signalAt) {
              emitted = true;
              signals.emit('SIGINT');
            }
          },
        },
        journalDirectory: join(root, 'journals'),
        kind: 'install',
        operationGuard: context.operationGuard,
        operationId: `interrupt-${signalAt}`,
        replacements: [{ action: 'replace', destinationPath: destination, stagedPath: staged }],
        root: project,
      });
      return success({ applied: true });
    },
    {
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
      signalSource: signals,
    },
  );

  return {
    contents: await readFile(join(destination, 'SKILL.md'), 'utf8'),
    diagnostics,
    result,
  };
}

describe('cancellation at durable commit boundaries', () => {
  it('cancels and preserves the old state before commit', async () =>
    withTempDirectory('skill-sync-cancel-before-', async (root) => {
      const outcome = await runInterruptedReplacement(root, 'candidate-prepared');
      expect(outcome.result).toMatchObject({
        errors: [{ code: 'CANCELLED' }],
        exitCode: 130,
        ok: false,
      });
      expect(outcome.contents).toBe('old');
    }));

  it.each(['original-moved', 'journal-committed'] satisfies readonly TransactionDurableStep[])(
    'defers interruption at %s and reports the committed state',
    async (signalAt) =>
      withTempDirectory('skill-sync-cancel-commit-', async (root) => {
        const outcome = await runInterruptedReplacement(root, signalAt);
        expect(outcome.result).toEqual(success({ applied: true }));
        expect(outcome.contents).toBe('new');
        expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
          'CANCELLED',
          'POST_COMMIT_INTERRUPTION',
        ]);
      }),
  );
});
