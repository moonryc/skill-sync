import { readFileSync } from 'node:fs';

import { Command, Option } from 'commander';

import { resultFromUnknown, type CommandResult } from '../domain/result.js';
import type { RuntimeIo } from '../ports/index.js';
import { colorIsEnabled, renderResult } from '../ui/output.js';

export interface CommandInvocation {
  readonly command: string;
  readonly arguments: readonly unknown[];
  readonly options: Readonly<Record<string, unknown>>;
}

export type CommandExecutor = (invocation: CommandInvocation) => Promise<CommandResult<unknown>>;

export interface ProgramDependencies {
  readonly io: RuntimeIo;
  readonly execute: CommandExecutor;
}

function packageVersion(): string {
  const value = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  return typeof value.version === 'string' ? value.version : '0.0.0';
}

function repeat(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function registerAction(
  command: Command,
  name: string,
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
      result = await dependencies.execute({ command: name, arguments: args, options });
    } catch (error) {
      result = resultFromUnknown(error);
    }
    renderResult(
      name,
      result,
      { json: options.json === true, color: options.color === true },
      dependencies.io,
    );
  });
}

function idsCommand(name: string, description: string): Command {
  return new Command(name).description(description).argument('[ids...]', 'qualified skill IDs');
}

export function createProgram(dependencies: ProgramDependencies): Command {
  const program = new Command()
    .name('skill-sync')
    .description('Manage Git-backed AI skills across projects.')
    .version(packageVersion())
    .option('--json', 'emit one machine-readable JSON object')
    .option('--no-color', 'disable ANSI styling')
    .option('--no-input', 'disable interactive prompts')
    .option('--yes', 'confirm ordinary prompts when destructive options are explicit')
    .option('--project <path>', 'override the project root')
    .showHelpAfterError('(run skill-sync --help for usage)');

  program.configureOutput({
    writeOut: (value) => dependencies.io.writeStdout(value),
    writeErr: (value) => dependencies.io.writeStderr(value),
  });

  const init = new Command('init')
    .description('Connect or create the default skill library')
    .argument('[url]', 'HTTP(S) or SSH Git repository URL')
    .option('--create <owner/name>', 'create a GitHub repository')
    .addOption(new Option('--visibility <visibility>').choices(['private', 'public', 'internal']))
    .addOption(new Option('--transport <transport>').choices(['https', 'ssh']))
    .option('--branch <branch>', 'library branch');
  registerAction(init, 'init', dependencies, program);
  program.addCommand(init);

  const install = idsCommand('install', 'Install skills into this project')
    .option('--target <target>', 'target agent (repeatable)', repeat, [])
    .option('--all', 'select every eligible skill')
    .option('--gitignore', 'add exact managed paths to .gitignore')
    .option('--no-gitignore', 'do not manage .gitignore')
    .option('--dry-run', 'preview without writes');
  registerAction(install, 'install', dependencies, program);
  program.addCommand(install);

  const sync = new Command('sync')
    .description('Refresh every tracked skill from the library')
    .option('--check', 'report drift without writes')
    .option('--dry-run', 'preview without writes')
    .option('--discard-local', 'allow replacement of local edits')
    .option('--offline <revision>', 'use an explicit cached revision');
  registerAction(sync, 'sync', dependencies, program);
  program.addCommand(sync);

  const update = idsCommand('update', 'Refresh selected tracked skills')
    .option('--all', 'refresh every tracked skill')
    .option('--dry-run', 'preview without writes')
    .option('--discard-local', 'allow replacement of local edits')
    .option('--offline <revision>', 'use an explicit cached revision');
  registerAction(update, 'update', dependencies, program);
  program.addCommand(update);

  const add = new Command('add')
    .description('Add a new local skill to the library')
    .argument('<path>', 'local skill directory')
    .option('--group <group>', 'destination group')
    .option('--dry-run', 'preview without writes');
  registerAction(add, 'add', dependencies, program);
  program.addCommand(add);

  const publish = idsCommand('publish', 'Publish edits to existing library skills')
    .option('--all', 'publish every eligible modified skill')
    .option('--from <target>', 'explicit source target')
    .option('--dry-run', 'preview without writes');
  registerAction(publish, 'publish', dependencies, program);
  program.addCommand(publish);

  const list = new Command('list')
    .description('List the grouped skill catalog')
    .option('--group <group>', 'group subtree (repeatable)', repeat, [])
    .option('--query <text>', 'identifier or description query (repeatable)', repeat, [])
    .option('--agent <agent>', 'compatible agent (repeatable)', repeat, [])
    .option('--state <state>', 'project state (repeatable)', repeat, []);
  registerAction(list, 'list', dependencies, program);
  program.addCommand(list);

  for (const [name, description] of [
    ['info', 'Inspect one skill without changing it'],
    ['diff', 'Compare a project skill with the library'],
  ] as const) {
    const command = new Command(name)
      .description(description)
      .argument('<id>', 'qualified skill ID');
    registerAction(command, name, dependencies, program);
    program.addCommand(command);
  }

  const status = new Command('status')
    .description('Show reconciliation state for managed skills')
    .option('--offline', 'inspect cached state without remote access');
  registerAction(status, 'status', dependencies, program);
  program.addCommand(status);

  const uninstall = idsCommand('uninstall', 'Remove managed project copies')
    .option('--all', 'select every managed skill')
    .option('--discard-local', 'allow removal of local edits')
    .option('--dry-run', 'preview without writes');
  registerAction(uninstall, 'uninstall', dependencies, program);
  program.addCommand(uninstall);

  const validate = new Command('validate')
    .description('Validate a library, skill ID, installed skill, or local path')
    .argument('[id-or-path]', 'qualified ID or filesystem path');
  registerAction(validate, 'validate', dependencies, program);
  program.addCommand(validate);

  const config = new Command('config').description('Inspect or change non-secret defaults');
  for (const name of ['path', 'list'] as const) {
    const child = new Command(name).description(`${name} configuration`);
    registerAction(child, `config:${name}`, dependencies, program);
    config.addCommand(child);
  }
  for (const name of ['get', 'unset'] as const) {
    const child = new Command(name).description(`${name} a configuration value`).argument('<key>');
    registerAction(child, `config:${name}`, dependencies, program);
    config.addCommand(child);
  }
  const configSet = new Command('set')
    .description('Set a configuration value')
    .argument('<key>')
    .argument('<value>');
  registerAction(configSet, 'config:set', dependencies, program);
  config.addCommand(configSet);
  program.addCommand(config);

  const doctor = new Command('doctor')
    .description('Diagnose configuration and environment health without mutation')
    .option('--offline', 'skip remote checks');
  registerAction(doctor, 'doctor', dependencies, program);
  program.addCommand(doctor);

  const library = new Command('library').description('Manage canonical library content');
  const libraryRemove = new Command('remove')
    .description('Delete one canonical library skill')
    .argument('<id>')
    .option('--dry-run', 'preview without writes');
  registerAction(libraryRemove, 'library:remove', dependencies, program);
  library.addCommand(libraryRemove);
  program.addCommand(library);

  const group = new Command('group').description('Manage library groups');
  const groupList = new Command('list').description('List library groups');
  registerAction(groupList, 'group:list', dependencies, program);
  group.addCommand(groupList);
  const groupCreate = new Command('create').description('Create a group').argument('<group>');
  registerAction(groupCreate, 'group:create', dependencies, program);
  group.addCommand(groupCreate);
  const groupRename = new Command('rename')
    .description('Rename a group')
    .argument('<from>')
    .argument('<to>');
  registerAction(groupRename, 'group:rename', dependencies, program);
  group.addCommand(groupRename);
  const groupRemove = new Command('remove')
    .description('Remove a group')
    .argument('<group>')
    .option('--recursive', 'allow removal of a nonempty group')
    .option('--dry-run', 'preview without writes');
  registerAction(groupRemove, 'group:remove', dependencies, program);
  group.addCommand(groupRemove);
  program.addCommand(group);

  return program;
}
