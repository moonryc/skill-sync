import { SCHEMA_VERSION } from '../domain/index.js';
import { sanitizeError, type CommandResult } from '../domain/result.js';
import type { RuntimeIo } from '../ports/index.js';

export interface OutputOptions {
  readonly json: boolean;
  readonly color: boolean;
}

function humanValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.join('\n');
  }
  return JSON.stringify(value, null, 2);
}

export function renderResult(
  command: string,
  result: CommandResult<unknown>,
  options: OutputOptions,
  io: RuntimeIo,
): void {
  if (options.json) {
    const envelope = result.ok
      ? { schemaVersion: SCHEMA_VERSION, ok: true, command, data: result.data }
      : {
          schemaVersion: SCHEMA_VERSION,
          ok: false,
          command,
          errors: result.errors.map((error) => sanitizeError(error)),
        };
    io.writeStdout(`${JSON.stringify(envelope)}\n`);
    io.setExitCode(result.exitCode);
    return;
  }

  if (result.ok) {
    const rendered = humanValue(result.data);
    if (rendered.length > 0) io.writeStdout(`${rendered}\n`);
  } else {
    for (const error of result.errors) {
      const safe = sanitizeError(error);
      io.writeStderr(`${safe.code}: ${safe.message}\n`);
    }
  }
  io.setExitCode(result.exitCode);
}

export function colorIsEnabled(
  requested: boolean,
  io: Pick<RuntimeIo, 'stdoutIsTty'>,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return requested && io.stdoutIsTty && environment.NO_COLOR === undefined;
}
