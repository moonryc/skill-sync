import { Command, Help, type Option } from 'commander';

import {
  EXIT_CODES,
  resultFromUnknown,
  SkillSyncError,
  success,
  type CommandResult,
} from '../domain/result.js';
import { readCliPackageMetadata } from '../infrastructure/package-metadata.js';
import type { RuntimeIo } from '../ports/index.js';
import { colorIsEnabled, renderResult } from '../ui/output.js';
import type { TuiLauncher } from '../ui/tui/types.js';
import {
  commandCommonOptionDefinitions,
  commandDefinition,
  commandDefinitions,
  commandHelpDefinition,
  commandParents,
  createCommandFromDefinition,
  createOptionFromDefinition,
  supportedCommonOptions,
  topLevelCommandOrder,
  validateCommandInvocation,
  type CommandDefinition,
  type CommandHelpGroup,
  type CompletionShell,
} from './command-registry.js';
import { generateCompletionScript } from './completion.js';

export interface CommandInvocation {
  readonly command: string;
  readonly arguments: readonly unknown[];
  readonly options: Readonly<Record<string, unknown>>;
}

export type CommandExecutor = (invocation: CommandInvocation) => Promise<CommandResult<unknown>>;

export interface ProgramDependencies {
  readonly io: RuntimeIo;
  readonly execute: CommandExecutor;
  readonly tui?: TuiLauncher;
}

const WIKI_URL = 'https://github.com/moonryc/skill-sync/tree/main/apps/wiki/src/content/docs';

const COMMAND_HELP_GROUPS = {
  lifecycle: 'Lifecycle:',
  setup: 'Setup:',
  discovery: 'Discovery:',
  project: 'Managed skills (project or global):',
  library: 'Library management:',
  recovery: 'Recovery:',
  diagnostics: 'Diagnostics:',
} as const;

const COMMAND_HELP_GROUP_ORDER: readonly string[] = Object.values(COMMAND_HELP_GROUPS);
const commanderHelp = new Help();

const ROOT_QUICK_START = [
  'Quick start (preview setup → apply → list → install):',
  '  skill-sync init <repository-url> --dry-run',
  '  or: skill-sync init --create <owner/name> --dry-run',
  '  then run the exact --expect-plan command printed by the preview',
  '  skill-sync list',
  '  skill-sync install <group/skill> --target codex --gitignore',
].join('\n');

function addNoviceHelp(command: Command, definition: CommandDefinition): Command {
  const inheritedOptions = supportedCommonOptions(definition);
  command.configureHelp({ showGlobalOptions: false });
  return command.addHelpText(
    'after',
    [
      ...(inheritedOptions.length === 0
        ? []
        : ['', 'Common options:', ...inheritedOptions.map((option) => `  ${option}`)]),
      ...(definition.choices.length === 0
        ? []
        : ['', 'Choices:', ...definition.choices.map((choice) => `  ${choice}`)]),
      '',
      'Examples:',
      ...definition.examples.map((example) => `  ${example}`),
      '',
      'Safety:',
      `  ${definition.safety}`,
      '',
      `Wiki: ${definition.documentation}`,
    ].join('\n'),
  );
}

function helpGroupOrder(heading: string): number {
  const index = COMMAND_HELP_GROUP_ORDER.indexOf(heading);
  return index === -1 ? COMMAND_HELP_GROUP_ORDER.length : index;
}

function orderHelpGroups<T extends Command | Option>(
  unsortedItems: T[],
  visibleItems: T[],
  getGroup: (item: T) => string,
): Map<string, T[]> {
  const groups = commanderHelp.groupItems(unsortedItems, visibleItems, getGroup);
  return new Map(
    [...groups.entries()].sort(
      ([leftHeading], [rightHeading]) => helpGroupOrder(leftHeading) - helpGroupOrder(rightHeading),
    ),
  );
}

function registerAction(
  command: Command,
  definition: CommandDefinition,
  dependencies: ProgramDependencies,
  program: Command,
): void {
  command.action(async (...raw: unknown[]) => {
    const actionCommand = raw.at(-1);
    const args = raw.slice(0, -1);
    const localOptions = actionCommand instanceof Command ? actionCommand.opts() : {};
    const globalOptions = program.opts();
    const options = { ...globalOptions, ...localOptions } as Record<string, unknown>;
    options.noInput = options.input === false;
    options.color = colorIsEnabled(options.color !== false, dependencies.io);

    let result: CommandResult<unknown>;
    try {
      const issue = validateCommandInvocation(
        definition,
        args,
        options,
        rawProgramArguments(program),
      );
      if (issue !== undefined) {
        throw new SkillSyncError(issue.code, issue.message, EXIT_CODES.usage);
      }
      result = await dependencies.execute({
        command: definition.id,
        arguments: args,
        options,
      });
    } catch (error) {
      result = resultFromUnknown(error);
    }
    renderResult(
      definition.id,
      result,
      { json: options.json === true, color: options.color === true },
      dependencies.io,
    );
  });
}

async function launchTui(
  dependencies: ProgramDependencies,
  program: Command,
  options: Readonly<Record<string, unknown>>,
  implicit: boolean,
): Promise<void> {
  const invocationOptions = { ...options } as Record<string, unknown>;
  invocationOptions.noInput = invocationOptions.input === false;
  invocationOptions.color = colorIsEnabled(invocationOptions.color !== false, dependencies.io);
  try {
    const issue = validateCommandInvocation(
      commandDefinition('tui'),
      [],
      invocationOptions,
      rawProgramArguments(program),
    );
    if (issue !== undefined) {
      throw new SkillSyncError(issue.code, issue.message, EXIT_CODES.usage);
    }
    if (dependencies.tui === undefined) {
      throw new Error('The interactive terminal UI is unavailable in this runtime.');
    }
    await dependencies.tui.launch({ implicit, options: invocationOptions });
  } catch (error) {
    renderResult(
      'tui',
      resultFromUnknown(error),
      { json: invocationOptions.json === true, color: invocationOptions.color === true },
      dependencies.io,
    );
  }
}

export async function launchImplicitTui(
  dependencies: ProgramDependencies,
  program: Command,
): Promise<void> {
  await launchTui(dependencies, program, program.opts(), true);
}

function helpGroup(name: CommandHelpGroup): string {
  return COMMAND_HELP_GROUPS[name];
}

function rawProgramArguments(program: Command): readonly string[] {
  const value: unknown = Reflect.get(program, 'rawArgs');
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function configureOutputTree(
  command: Command,
  root: Command,
  dependencies: ProgramDependencies,
): void {
  command.configureOutput({
    writeOut: (value) => dependencies.io.writeStdout(value),
    writeErr: (value) => {
      if (root.opts().json !== true && !rawProgramArguments(root).includes('--json')) {
        dependencies.io.writeStderr(value);
      }
    },
  });
  for (const child of command.commands) configureOutputTree(child, root, dependencies);
}

export function createProgram(dependencies: ProgramDependencies): Command {
  const program = new Command()
    .name('skill-sync')
    .description('Manage Git-backed AI skills across projects.')
    .version(readCliPackageMetadata().version)
    .showHelpAfterError('(run skill-sync --help for usage)');

  for (const option of commandCommonOptionDefinitions) {
    program.addOption(createOptionFromDefinition(option));
  }

  program
    .configureHelp({ groupItems: orderHelpGroups })
    .addHelpText('before', ROOT_QUICK_START)
    .addHelpText('after', `\nWiki: ${WIKI_URL}`);

  program.addHelpCommand(
    new Command(commandHelpDefinition.name)
      .description(commandHelpDefinition.description)
      .argument(commandHelpDefinition.argument.syntax, commandHelpDefinition.argument.description)
      .helpOption(false)
      .helpGroup(COMMAND_HELP_GROUPS.diagnostics),
  );

  const parents = new Map<string, Command>(
    commandParents.map((definition) => {
      const parent = new Command(definition.name)
        .description(definition.description)
        .helpGroup(helpGroup(definition.helpGroup))
        .configureHelp({ showGlobalOptions: false })
        .addHelpText(
          'after',
          `\nRun skill-sync ${definition.name} <command> --help for examples and safety details.\n\nWiki: ${WIKI_URL}`,
        );
      return [definition.name, parent] as const;
    }),
  );
  const leaves = new Map<string, Command>();

  for (const definition of commandDefinitions) {
    const command = addNoviceHelp(createCommandFromDefinition(definition), definition).helpGroup(
      helpGroup(definition.helpGroup),
    );
    if (definition.handler === 'executor') {
      registerAction(command, definition, dependencies, program);
    } else if (definition.handler === 'terminal-ui') {
      command.action(async () => {
        await launchTui(dependencies, program, program.opts(), false);
      });
    } else if (definition.handler === 'completion') {
      command.action(() => {
        const options = { ...program.opts(), ...command.opts() } as Record<string, unknown>;
        options.color = colorIsEnabled(options.color !== false, dependencies.io);
        let result: CommandResult<unknown>;
        const issue = validateCommandInvocation(
          definition,
          [],
          options,
          rawProgramArguments(program),
        );
        if (issue === undefined && typeof options.shell === 'string') {
          const script = generateCompletionScript(options.shell as CompletionShell);
          result = success(options.json === true ? { shell: options.shell, script } : script);
        } else if (issue !== undefined) {
          result = resultFromUnknown(
            new SkillSyncError(issue.code, issue.message, EXIT_CODES.usage),
          );
        } else {
          result = resultFromUnknown(
            new SkillSyncError(
              'USAGE_ERROR',
              'Pass --shell bash, zsh, fish, or powershell. Example: skill-sync completion --shell zsh.',
              EXIT_CODES.usage,
            ),
          );
        }
        renderResult(
          definition.id,
          result,
          { json: options.json === true, color: options.color === true },
          dependencies.io,
        );
      });
    } else {
      command.action(() => {
        const options = program.opts();
        options.color = colorIsEnabled(options.color !== false, dependencies.io);
        let result: CommandResult<unknown>;
        const issue = validateCommandInvocation(
          definition,
          [],
          options,
          rawProgramArguments(program),
        );
        if (issue === undefined) {
          const installedVersion = readCliPackageMetadata().version;
          result = success(
            options.json === true ? { version: installedVersion } : installedVersion,
          );
        } else {
          result = resultFromUnknown(
            new SkillSyncError(issue.code, issue.message, EXIT_CODES.usage),
          );
        }
        renderResult(
          definition.id,
          result,
          { json: options.json === true, color: options.color === true },
          dependencies.io,
        );
      });
    }
    leaves.set(definition.id, command);
    if (definition.path.length > 1) {
      const parentName = definition.path[0];
      const parent = parentName === undefined ? undefined : parents.get(parentName);
      if (parent === undefined) {
        throw new Error(`Missing parent command for ${definition.id}.`);
      }
      parent.addCommand(command);
    }
  }

  for (const entry of topLevelCommandOrder) {
    const command = leaves.get(entry) ?? parents.get(entry);
    if (command === undefined) throw new Error(`Missing top-level command ${entry}.`);
    program.addCommand(command);
  }

  configureOutputTree(program, program, dependencies);

  return program;
}
