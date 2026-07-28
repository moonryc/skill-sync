import { createElement } from 'react';
import { render } from 'ink';

import {
  inspectGlobalUnmanagedSkills,
  inspectProjectUnmanagedSkills,
} from '../../application/unmanaged-skill-inventory.js';
import { resolveApplicationPaths } from '../../infrastructure/config.js';
import { EXIT_CODES, SkillSyncError, type CommandResult } from '../../domain/result.js';
import type { RuntimeIo } from '../../ports/index.js';
import type { CommandExecutor, CommandInvocation } from '../../commands/program.js';
import { TuiApp } from './app.js';
import { terminalSafe } from './sanitize.js';
import type {
  TuiActionPort,
  TuiDashboard,
  TuiInventorySkill,
  TuiLauncher,
  TuiLaunchRequest,
  TuiManagedSkill,
  TuiSkill,
} from './types.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback = ''): string {
  return terminalSafe(typeof value === 'string' ? value : fallback);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function errorMessages(result: CommandResult<unknown>): readonly string[] {
  return result.ok
    ? []
    : result.errors.map((error) => terminalSafe(`${error.code}: ${error.message}`));
}

function asSkills(result: CommandResult<unknown>): readonly TuiSkill[] {
  if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.skills)) return [];
  return result.data.skills.flatMap((entry): readonly TuiSkill[] => {
    if (!isRecord(entry)) return [];
    const id = asString(entry.id);
    if (id === '') return [];
    return [
      {
        compatibleAgents: strings(entry.compatibleAgents),
        description: asString(entry.description, 'No description provided.'),
        group: typeof entry.group === 'string' ? entry.group : null,
        id,
        installationState: asString(entry.installationState, 'not-installed'),
        name: asString(entry.name, id.split('/').at(-1) ?? id),
      },
    ];
  });
}

function asManaged(result: CommandResult<unknown>): readonly TuiManagedSkill[] {
  if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.skills)) return [];
  return result.data.skills.flatMap((entry): readonly TuiManagedSkill[] => {
    if (!isRecord(entry)) return [];
    const id = asString(entry.id);
    if (id === '') return [];
    return [{ id, state: asString(entry.state, 'unknown') }];
  });
}

function asProjectRoot(result: CommandResult<unknown>): string | undefined {
  if (!result.ok || !isRecord(result.data)) return undefined;
  const root = result.data.projectRoot;
  return typeof root === 'string' && root.length > 0 ? root : undefined;
}

function invocation(
  command: string,
  arguments_: readonly unknown[],
  options: Readonly<Record<string, unknown>>,
): CommandInvocation {
  return { command, arguments: arguments_, options };
}

export class DefaultTuiActionPort implements TuiActionPort {
  public constructor(
    private readonly execute: CommandExecutor,
    private readonly options: Readonly<Record<string, unknown>>,
  ) {}

  private optionsFor(
    extra: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> {
    return {
      ...this.options,
      ...extra,
      color: this.options.color !== false,
      json: true,
      noInput: true,
      yes: true,
    };
  }

  public async load(): Promise<TuiDashboard> {
    const [catalog, status] = await Promise.all([
      this.execute(invocation('list', [], this.optionsFor())),
      this.execute(invocation('status', [], this.optionsFor())),
    ]);
    const errors = [...errorMessages(catalog), ...errorMessages(status)];
    const root = asProjectRoot(status);
    let inventory: readonly TuiInventorySkill[] = [];
    let inventoryIssues: readonly string[];
    if (this.options.global === true) {
      const report = await inspectGlobalUnmanagedSkills({ paths: resolveApplicationPaths() });
      inventory = report.entries.map((entry) => ({
        adoptable: entry.adoptable,
        issues: entry.issues.map(terminalSafe),
        name: terminalSafe(entry.name),
        path: terminalSafe(entry.path),
        status: terminalSafe(entry.status),
        target: terminalSafe(entry.target),
      }));
      inventoryIssues = report.issues.map((issue) =>
        terminalSafe(`${issue.code}: ${issue.message}`),
      );
    } else if (root !== undefined) {
      const report = await inspectProjectUnmanagedSkills({ projectRoot: root });
      inventory = report.entries.map((entry) => ({
        adoptable: entry.adoptable,
        issues: entry.issues.map(terminalSafe),
        name: terminalSafe(entry.name),
        path: terminalSafe(entry.path),
        status: terminalSafe(entry.status),
        target: terminalSafe(entry.target),
      }));
      inventoryIssues = report.issues.map((issue) =>
        terminalSafe(`${issue.code}: ${issue.message}`),
      );
    } else {
      inventoryIssues = ['Project inventory is unavailable until project status can be inspected.'];
    }
    return {
      errors,
      inventory,
      inventoryIssues,
      managed: asManaged(status),
      scope: this.options.global === true ? 'global' : 'project',
      skills: asSkills(catalog),
    };
  }

  public async install(
    ids: readonly string[],
    targets: readonly string[],
  ): Promise<CommandResult<unknown>> {
    return await this.execute(
      invocation('install', [ids], this.optionsFor({ gitignore: false, target: [...targets] })),
    );
  }

  public async adopt(id: string, target: string): Promise<CommandResult<unknown>> {
    return await this.execute(invocation('adopt', [id], this.optionsFor({ target })));
  }

  public async sync(discardLocal: boolean): Promise<CommandResult<unknown>> {
    return await this.execute(invocation('sync', [], this.optionsFor({ discardLocal })));
  }
}

export function createTuiLauncher(options: {
  readonly execute: CommandExecutor;
  readonly io: RuntimeIo;
}): TuiLauncher {
  return {
    launch: async (request: TuiLaunchRequest): Promise<void> => {
      if (request.options.global === true && typeof request.options.project === 'string') {
        throw new SkillSyncError(
          'CONFLICTING_SCOPE_OPTIONS',
          'Pass either --global or --project, not both.',
          EXIT_CODES.usage,
        );
      }
      if (request.options.json === true || request.options.noInput === true) {
        throw new SkillSyncError(
          'INTERACTIVE_TERMINAL_REQUIRED',
          'The terminal UI cannot be used with --json or --no-input. Run an argument-driven command instead.',
          EXIT_CODES.usage,
        );
      }
      if (!options.io.stdinIsTty || !options.io.stdoutIsTty) {
        throw new SkillSyncError(
          'INTERACTIVE_TERMINAL_REQUIRED',
          'The terminal UI requires interactive standard input and output. Run a command such as skill-sync list instead.',
          EXIT_CODES.usage,
        );
      }
      const app = render(
        createElement(TuiApp, {
          actions: new DefaultTuiActionPort(options.execute, request.options),
          color: request.options.color !== false,
          implicit: request.implicit,
        }),
        { alternateScreen: true, exitOnCtrlC: true, interactive: true },
      );
      await app.waitUntilExit();
    },
  };
}
