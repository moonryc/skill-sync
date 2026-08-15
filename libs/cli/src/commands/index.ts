import { CommanderError } from 'commander';
import type { Command } from 'commander';

import { nodeRuntimeIo } from '../infrastructure/io.js';
import { resolveApplicationPaths } from '../infrastructure/config.js';
import { readCliPackageMetadata } from '../infrastructure/package-metadata.js';
import { inspectRecoveryState, recoveryWarningLines } from '../application/recovery.js';
import { EXIT_CODES, failure, redactSecrets, success } from '../domain/result.js';
import { renderResult } from '../ui/output.js';
import {
  commandDefinition,
  requestedCommandId,
  validateCommandInvocation,
} from './command-registry.js';
import { createDefaultCommandExecutor } from './default-executor.js';
import { createProgram, launchImplicitTui, type CommandExecutor } from './program.js';
import { createTuiLauncher } from '../ui/tui/runner.js';

function requestedCommand(argv: readonly string[]): string {
  return requestedCommandId(argv.slice(2));
}

function overrideProcessExits(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) overrideProcessExits(child);
}

function isVersionInvocation(argv: readonly string[]): boolean {
  return argv.includes('--version') || argv.includes('-V') || requestedCommand(argv) === 'version';
}

const versionOnlyExecutor: CommandExecutor = () =>
  Promise.reject(new Error('The version command does not execute application commands.'));

function withStartupRecoveryInspection(execute: CommandExecutor): CommandExecutor {
  let inspected = false;
  return async (invocation) => {
    if (!inspected) {
      inspected = true;
      try {
        const recovery = await inspectRecoveryState(resolveApplicationPaths());
        if (invocation.options.json !== true) {
          for (const warning of recoveryWarningLines(recovery)) {
            nodeRuntimeIo.writeStderr(`${warning}\n`);
          }
        }
      } catch (error) {
        if (invocation.options.json !== true) {
          const message = error instanceof Error ? error.message : String(error);
          nodeRuntimeIo.writeStderr(`RECOVERY_INSPECTION_FAILED: ${redactSecrets(message)}\n`);
        }
      }
    }
    return await execute(invocation);
  };
}

function hasProjectOption(argv: readonly string[]): boolean {
  return argv.includes('--project') || argv.some((value) => value.startsWith('--project='));
}

function hasConflictingScopeOptions(argv: readonly string[]): boolean {
  return argv.includes('--global') && hasProjectOption(argv);
}

const onboardingCommandGuidance: Readonly<Record<string, string>> = {
  setup:
    'Unknown command "setup". Preview an existing library with: skill-sync init <repository-url> --dry-run',
  create:
    'Unknown command "create". Preview GitHub library creation with: skill-sync init --create <owner/name> --dry-run',
};

function requestedOnboardingGuidance(argv: readonly string[]): string | undefined {
  if (isVersionInvocation(argv)) return undefined;
  return onboardingCommandGuidance[requestedCommand(argv)];
}

function bareQuickStartCommands(
  argv: readonly string[],
): readonly [string, string, string, string] {
  const global = argv.includes('--global');
  const scopePrefix = global
    ? 'skill-sync --global'
    : hasProjectOption(argv)
      ? 'skill-sync --project <path>'
      : 'skill-sync';
  return [
    'skill-sync init <repository-url> --dry-run',
    'skill-sync init --create <owner/name> --dry-run',
    `${scopePrefix} list`,
    `${scopePrefix} install <group/skill> --target codex${global ? '' : ' --gitignore'}`,
  ];
}

function bareQuickStart(argv: readonly string[]): string {
  const commands = bareQuickStartCommands(argv);
  return `skill-sync quick start

1. Preview a skill library setup:
   ${commands[0]}
   or: ${commands[1]}
2. Apply it:
   Run the exact --expect-plan command printed by the preview.
3. Browse available skills:
   ${commands[2]}
4. Install a skill:
   ${commands[3]}

Run skill-sync --help for every command.
`;
}

function isBareInvocation(argv: readonly string[]): boolean {
  const arguments_ = argv.slice(2);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      argument === '--global' ||
      argument === '--json' ||
      argument === '--no-color' ||
      argument === '--no-input' ||
      argument === '--yes'
    ) {
      continue;
    }
    if (argument === '--project') {
      const path = arguments_[index + 1];
      if (path === undefined || path.startsWith('-')) return false;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--project=') === true && argument.length > '--project='.length) {
      continue;
    }
    return false;
  }
  return true;
}

export async function runCli(argv: readonly string[], execute?: CommandExecutor): Promise<void> {
  if (hasConflictingScopeOptions(argv)) {
    renderResult(
      requestedCommand(argv),
      failure(
        {
          code: 'CONFLICTING_SCOPE_OPTIONS',
          message: 'Pass either --global or --project, not both.',
        },
        EXIT_CODES.usage,
      ),
      { json: argv.includes('--json'), color: false },
      nodeRuntimeIo,
    );
    return;
  }

  const onboardingGuidance = requestedOnboardingGuidance(argv);
  if (onboardingGuidance !== undefined) {
    renderResult(
      requestedCommand(argv),
      failure(
        {
          code: 'USAGE_ERROR',
          message: onboardingGuidance,
        },
        EXIT_CODES.usage,
      ),
      { json: argv.includes('--json'), color: false },
      nodeRuntimeIo,
    );
    return;
  }

  if (isBareInvocation(argv) && (!nodeRuntimeIo.stdinIsTty || !nodeRuntimeIo.stdoutIsTty)) {
    const commands = bareQuickStartCommands(argv);
    if (argv.includes('--json')) {
      renderResult(
        'skill-sync',
        success({
          commands,
          mode: 'quick-start',
          nextAction: 'skill-sync --help',
        }),
        { json: true, color: false },
        nodeRuntimeIo,
      );
    } else {
      nodeRuntimeIo.writeStdout(bareQuickStart(argv));
      nodeRuntimeIo.setExitCode(EXIT_CODES.success);
    }
    return;
  }

  const versionInvocation = isVersionInvocation(argv);
  if (versionInvocation) {
    const issue = validateCommandInvocation(
      commandDefinition('version'),
      [],
      {
        global: argv.includes('--global'),
        noInput: argv.includes('--no-input'),
        yes: argv.includes('--yes'),
        ...(hasProjectOption(argv) ? { project: '<path>' } : {}),
      },
      argv.slice(2),
    );
    if (issue !== undefined) {
      renderResult(
        'version',
        failure({ code: issue.code, message: issue.message }, EXIT_CODES.usage),
        { json: argv.includes('--json'), color: false },
        nodeRuntimeIo,
      );
      return;
    }
  }
  if (versionInvocation && argv.includes('--json')) {
    renderResult(
      'version',
      success({ version: readCliPackageMetadata().version }),
      { json: true, color: false },
      nodeRuntimeIo,
    );
    return;
  }
  let defaultExecutor: CommandExecutor | undefined;
  const baseExecutor: CommandExecutor =
    execute ??
    (versionInvocation
      ? versionOnlyExecutor
      : async (invocation) => {
          defaultExecutor ??= createDefaultCommandExecutor(nodeRuntimeIo);
          return await defaultExecutor(invocation);
        });
  const commandExecutor = versionInvocation
    ? baseExecutor
    : withStartupRecoveryInspection(baseExecutor);
  const programDependencies = {
    io: nodeRuntimeIo,
    execute: commandExecutor,
    tui: createTuiLauncher({ execute: commandExecutor, io: nodeRuntimeIo }),
  };
  const program = createProgram(programDependencies);
  overrideProcessExits(program);
  try {
    const hasBareInvocation =
      requestedCommand(argv) === 'skill-sync' &&
      !argv.includes('--help') &&
      !argv.includes('-h') &&
      !argv.includes('--version') &&
      !argv.includes('-V');
    if (hasBareInvocation) {
      const parsed = program.parseOptions([...argv.slice(2)]);
      if (parsed.unknown.length === 0) {
        await launchImplicitTui(programDependencies, program);
        return;
      }
    }
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
