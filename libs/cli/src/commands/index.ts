import { CommanderError } from 'commander';
import type { Command } from 'commander';

import { nodeRuntimeIo } from '../infrastructure/io.js';
import { resolveApplicationPaths } from '../infrastructure/config.js';
import { inspectRecoveryState, recoveryWarningLines } from '../application/recovery.js';
import { EXIT_CODES, failure, redactSecrets } from '../domain/result.js';
import { renderResult } from '../ui/output.js';
import { createDefaultCommandExecutor } from './default-executor.js';
import { createProgram, type CommandExecutor } from './program.js';

function requestedCommand(argv: readonly string[]): string {
  const arguments_ = argv.slice(2);
  let offset = 0;
  while (offset < arguments_.length) {
    const argument = arguments_[offset];
    if (argument === '--project') {
      offset += 2;
      continue;
    }
    if (argument === '--global') {
      offset += 1;
      continue;
    }
    if (argument?.startsWith('-') === true) {
      offset += 1;
      continue;
    }
    if (argument === undefined) break;
    if (['config', 'group', 'library'].includes(argument)) {
      const child = arguments_.slice(offset + 1).find((value) => !value.startsWith('-'));
      return child === undefined ? argument : `${argument}:${child}`;
    }
    return argument;
  }
  return 'skill-sync';
}

function overrideProcessExits(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) overrideProcessExits(child);
}

export async function runCli(argv: readonly string[], execute?: CommandExecutor): Promise<void> {
  try {
    const recovery = await inspectRecoveryState(resolveApplicationPaths());
    for (const warning of recoveryWarningLines(recovery)) nodeRuntimeIo.writeStderr(`${warning}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nodeRuntimeIo.writeStderr(`RECOVERY_INSPECTION_FAILED: ${redactSecrets(message)}\n`);
  }
  const program = createProgram({
    io: nodeRuntimeIo,
    execute: execute ?? createDefaultCommandExecutor(nodeRuntimeIo),
  });
  overrideProcessExits(program);
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) {
        nodeRuntimeIo.setExitCode(0);
        return;
      }
      if (argv.includes('--json')) {
        renderResult(
          requestedCommand(argv),
          failure(
            {
              code: 'USAGE_ERROR',
              message: error.message,
            },
            EXIT_CODES.usage,
          ),
          { json: true, color: false },
          nodeRuntimeIo,
        );
        return;
      }
      nodeRuntimeIo.setExitCode(EXIT_CODES.usage);
      return;
    }
    throw error;
  }
}

export { createProgram, type CommandExecutor, type CommandInvocation } from './program.js';
export { createDefaultCommandExecutor } from './default-executor.js';
