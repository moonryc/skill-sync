import { spawn } from 'node:child_process';

export type ProcessFailureReason =
  'cancelled' | 'output-limit' | 'spawn-failed' | 'timeout' | 'unsuccessful';

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export class ProcessRunError extends Error {
  public constructor(
    public readonly reason: ProcessFailureReason,
    message: string,
    public readonly output: {
      readonly exitCode: number | null;
      readonly stderr: string;
      readonly stdout: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProcessRunError';
  }
}

const HOSTILE_GIT_ENVIRONMENT = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_EXEC_PATH',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
] as const;

export function nonInteractiveProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  trustedOverrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  for (const name of HOSTILE_GIT_ENVIRONMENT) Reflect.deleteProperty(sanitized, name);
  return {
    ...sanitized,
    ...trustedOverrides,
    CI: trustedOverrides.CI ?? sanitized.CI ?? '1',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_yes: 'true',
  };
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): { readonly bytes: number; readonly exceeded: boolean } {
  const available = Math.max(0, maxBytes - currentBytes);
  if (available > 0) chunks.push(chunk.subarray(0, available));
  return { bytes: currentBytes + chunk.byteLength, exceeded: chunk.byteLength > available };
}

export async function runProcess(options: {
  readonly arguments?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit trusted values applied after hostile inherited Git variables are removed. */
  readonly envOverrides?: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<ProcessRunResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('maxOutputBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive safe integer.');
  }
  if (options.signal?.aborted === true) {
    throw new ProcessRunError('cancelled', 'The child process was cancelled before it started.', {
      exitCode: null,
      stderr: '',
      stdout: '',
    });
  }

  return await new Promise<ProcessRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(options.executable, [...(options.arguments ?? [])], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: nonInteractiveProcessEnvironment(options.env, options.envOverrides),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ProcessFailureReason | undefined;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;

    const terminate = (reason: ProcessFailureReason): void => {
      failure ??= reason;
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => child.kill('SIGKILL'), 250);
      escalation.unref();
    };
    const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
    timeout.unref();
    const abort = (): void => terminate('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const appended = appendBounded(stdout, chunk, stdoutBytes, maxOutputBytes);
      stdoutBytes = appended.bytes;
      if (appended.exceeded) terminate('output-limit');
    });
    child.stderr.on('data', (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const appended = appendBounded(stderr, chunk, stderrBytes, maxOutputBytes);
      stderrBytes = appended.bytes;
      if (appended.exceeded) terminate('output-limit');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      rejectPromise(
        new ProcessRunError(
          'spawn-failed',
          `Could not start ${options.executable}.`,
          { exitCode: null, stderr: '', stdout: '' },
          { cause: error },
        ),
      );
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      const output = {
        exitCode,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      };
      if (failure !== undefined) {
        rejectPromise(
          new ProcessRunError(
            failure,
            `Child process ${options.executable} stopped: ${failure}.`,
            output,
          ),
        );
        return;
      }
      if (exitCode !== 0) {
        rejectPromise(
          new ProcessRunError(
            'unsuccessful',
            `Child process ${options.executable} exited with code ${String(exitCode)}.`,
            output,
          ),
        );
        return;
      }
      resolvePromise({ ...output, exitCode: 0 });
    });
  });
}
