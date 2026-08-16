import type { NpmPackageUpdater } from '../application/release-management.js';
import { EXIT_CODES, redactSecrets, SkillSyncError } from '../domain/result.js';
import { ProcessRunError, runProcess } from './process-runner.js';

export interface NpmProcessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly shell: false;
  readonly timeoutMs?: number;
}

export type NpmProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options: NpmProcessOptions,
) => Promise<void>;

function npmFailure(error: unknown, stderr: string): SkillSyncError {
  const diagnostic = stderr.trim() || (error instanceof Error ? error.message : String(error));
  return new SkillSyncError(
    'CLI_UPDATE_FAILED',
    `npm could not update the CLI: ${redactSecrets(diagnostic || 'The npm command failed.')}`,
    EXIT_CODES.internal,
  );
}

const NPM_UPDATE_TIMEOUT_MS = 120_000;
const PROCESS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

function processStderr(error: unknown): string {
  if (error instanceof ProcessRunError) return error.output.stderr;
  if (typeof error !== 'object' || error === null) return '';
  const stderr: unknown = Reflect.get(error, 'stderr');
  return typeof stderr === 'string' ? stderr : '';
}

export const nodeNpmProcessRunner: NpmProcessRunner = async (executable, arguments_, options) => {
  try {
    await runProcess({
      arguments: arguments_,
      ...(options.env === undefined ? {} : { env: options.env }),
      executable,
      maxOutputBytes: PROCESS_OUTPUT_LIMIT_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs ?? NPM_UPDATE_TIMEOUT_MS,
    });
  } catch (error) {
    throw npmFailure(error, processStderr(error));
  }
};

export class NpmGlobalPackageUpdater implements NpmPackageUpdater {
  public constructor(private readonly run: NpmProcessRunner = nodeNpmProcessRunner) {}

  public async installLatest(packageName: string): Promise<void> {
    await this.run('npm', ['install', '--global', `${packageName}@latest`], { shell: false });
  }
}
