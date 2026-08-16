import { describe, expect, it } from 'vitest';

import { success } from '../../src/domain/result.js';
import type { RuntimeIo } from '../../src/ports/index.js';
import { commandDefinitions } from '../../src/commands/command-registry.js';
import { createProgram, launchImplicitTui } from '../../src/commands/program.js';
import type { TuiLaunchRequest } from '../../src/ui/tui/types.js';

function ioFixture() {
  const state = { stdout: '', stderr: '', exitCode: -1 };
  const io: RuntimeIo = {
    stdinIsTty: false,
    stdoutIsTty: false,
    writeStdout: (value) => {
      state.stdout += value;
    },
    writeStderr: (value) => {
      state.stderr += value;
    },
    setExitCode: (value) => {
      state.exitCode = value;
    },
  };
  return { io, state };
}

function renderHelp(command: ReturnType<typeof createProgram>): string {
  let output = '';
  command.configureOutput({
    writeOut: (value) => {
      output += value;
    },
  });
  command.outputHelp();
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function findCommand(program: ReturnType<typeof createProgram>, name: string) {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (command === undefined) {
    throw new Error(`Expected ${name} to be registered.`);
  }
  return command;
}

function findCommandPath(program: ReturnType<typeof createProgram>, path: readonly string[]) {
  let current = program;
  for (const name of path) current = findCommand(current, name);
  return current;
}

describe('CLI program', () => {
  it('registers the complete top-level command surface', () => {
    const { io } = ioFixture();
    const program = createProgram({ io, execute: () => Promise.resolve(success({})) });
    expect(program.commands.map((command) => command.name())).toEqual([
      'version',
      'self-update',
      'init',
      'completion',
      'tui',
      'install',
      'adopt',
      'sync',
      'update',
      'add',
      'publish',
      'list',
      'info',
      'diff',
      'status',
      'uninstall',
      'validate',
      'config',
      'doctor',
      'recovery',
      'library',
      'group',
    ]);
  });

  it('leads root help with a runnable quick start and groups the complete command surface', () => {
    const { io } = ioFixture();
    const program = createProgram({ io, execute: () => Promise.resolve(success({})) });

    const help = renderHelp(program);
    expect(help.startsWith('Quick start (preview setup → apply → list → install):')).toBe(true);
    expect(help).toContain('skill-sync init <repository-url> --dry-run');
    expect(help).toContain('skill-sync init --create <owner/name> --dry-run');
    expect(help).toContain('then run the exact --expect-plan command printed by the preview');
    expect(help).toContain('skill-sync list');
    expect(help).toContain('skill-sync install <group/skill> --target codex --gitignore');
    expect(help.indexOf('Quick start')).toBeLessThan(help.indexOf('Usage:'));

    let priorHeading = -1;
    for (const heading of [
      'Lifecycle:',
      'Setup:',
      'Discovery:',
      'Managed skills (project or global):',
      'Library management:',
      'Recovery:',
      'Diagnostics:',
    ]) {
      const index = help.indexOf(heading);
      expect(index).toBeGreaterThan(priorHeading);
      priorHeading = index;
    }
    expect(help).not.toMatch(/^Commands:/mu);
    expect(help).toContain(
      'Wiki: https://github.com/moonryc/skill-sync/tree/main/apps/wiki/src/content/docs',
    );
  });

  it('shows novice choices, examples, safety notes, and only supported inherited options for init', () => {
    const { io } = ioFixture();
    const program = createProgram({ io, execute: () => Promise.resolve(success({})) });

    const help = renderHelp(findCommand(program, 'init'));
    expect(help).toContain('--create <owner/name>');
    expect(help).toContain('private (default), public, or internal');
    expect(help).toContain('https (default) or ssh');
    expect(help).toContain('skill-sync init git@github.com:you/ai-skills.git --dry-run');
    expect(help).toContain(
      'skill-sync init --create you/ai-skills --visibility private --transport ssh --dry-run',
    );
    expect(help).toContain('Safety:');
    expect(help).toContain('never put credentials in a remote URL');
    expect(help).toContain('Common options:');
    expect(help).toContain('--json');
    expect(help).toContain('--no-input');
    expect(help).not.toContain('--project <path>');
    expect(help).not.toMatch(/^\s+--global\s/mu);
  });

  it('shows install targets, realistic examples, safety, and inherited options', () => {
    const { io } = ioFixture();
    const program = createProgram({ io, execute: () => Promise.resolve(success({})) });

    const help = renderHelp(findCommand(program, 'install'));
    expect(help).toContain('target agent: codex or claude (repeatable)');
    expect(help).toContain('--target: codex or claude; repeat --target to install for both agents');
    expect(help).toContain('skill-sync install frontend/review-ui --target codex --gitignore');
    expect(help).toContain('skill-sync --global install frontend/review-ui --target codex');
    expect(help).toContain('skill-sync install --all --target codex --target claude --dry-run');
    expect(help).toContain('--expect-plan <fingerprint>');
    expect(help).toContain('exact reviewed dry-run plan');
    expect(help).toContain('Install creates new managed copies; it does not update existing ones.');
    expect(help).toContain('Common options:');
    expect(help).toContain('--no-input');
    expect(help).toContain('--project <path>');
    expect(help).toContain('--global');
  });

  it('teaches examples, safety, and a direct wiki route for every public leaf command', () => {
    const { io } = ioFixture();
    const program = createProgram({ io, execute: () => Promise.resolve(success({})) });

    for (const definition of commandDefinitions) {
      const help = renderHelp(findCommandPath(program, definition.path));
      expect(help, definition.id).toContain('Examples:');
      expect(help, definition.id).toContain(definition.examples[0]);
      expect(help, definition.id).toContain('Safety:');
      expect(help, definition.id).toContain(`Wiki: ${definition.documentation}`);
      if (definition.scope === 'none') {
        expect(help, definition.id).not.toContain('--project <path>:');
        expect(help, definition.id).not.toContain('--global:');
      }
    }
  });

  it('rejects irrelevant scope selectors before an executor can run', async () => {
    const { io, state } = ioFixture();
    let executions = 0;
    const program = createProgram({
      io,
      execute: () => {
        executions += 1;
        return Promise.resolve(success({}));
      },
    });

    await program.parseAsync(['node', 'skill-sync', '--project', '/tmp', 'self-update']);

    expect(executions).toBe(0);
    expect(state.exitCode).toBe(2);
    expect(state.stderr).toContain('SCOPE_OPTION_UNSUPPORTED');
  });

  it('rejects prompt flags on commands that cannot consume them before execution', async () => {
    const { io, state } = ioFixture();
    let executions = 0;
    const program = createProgram({
      io,
      execute: () => {
        executions += 1;
        return Promise.resolve(success({}));
      },
    });

    await program.parseAsync(['node', 'skill-sync', 'config', 'list', '--yes']);

    expect(executions).toBe(0);
    expect(state.exitCode).toBe(2);
    expect(state.stderr).toContain('OPTION_UNSUPPORTED');
    expect(state.stderr).toContain('does not use confirmation prompts');
  });

  it('rejects prompt flags on the built-in version handler', async () => {
    const { io, state } = ioFixture();
    const program = createProgram({ io, execute: () => Promise.resolve(success({})) });

    await program.parseAsync(['node', 'skill-sync', 'version', '--no-input']);

    expect(state.exitCode).toBe(2);
    expect(state.stderr).toContain('OPTION_UNSUPPORTED');
    expect(state.stdout).toBe('');
  });

  it('rejects malformed reviewed install fingerprints before an executor can run', async () => {
    const { io, state } = ioFixture();
    let executions = 0;
    const program = createProgram({
      io,
      execute: () => {
        executions += 1;
        return Promise.resolve(success({}));
      },
    });

    await program.parseAsync([
      'node',
      'skill-sync',
      'install',
      'frontend/review-ui',
      '--expect-plan',
      'not-a-plan',
    ]);

    expect(executions).toBe(0);
    expect(state.exitCode).toBe(2);
    expect(state.stderr).toContain('INVALID_INSTALL_PLAN_FINGERPRINT');
  });

  it('prints the installed version without dispatching an application command', async () => {
    const { io, state } = ioFixture();
    let executions = 0;
    const program = createProgram({
      io,
      execute: () => {
        executions += 1;
        return Promise.resolve(success({}));
      },
    });

    await program.parseAsync(['node', 'skill-sync', 'version']);

    expect(state.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
    expect(state.stderr).toBe('');
    expect(state.exitCode).toBe(0);
    expect(executions).toBe(0);
  });

  it('generates raw and JSON completion without dispatching application work', async () => {
    const raw = ioFixture();
    let executions = 0;
    const rawProgram = createProgram({
      io: raw.io,
      execute: () => {
        executions += 1;
        return Promise.resolve(success({}));
      },
    });

    await rawProgram.parseAsync(['node', 'skill-sync', 'completion', '--shell', 'zsh']);

    expect(executions).toBe(0);
    expect(raw.state.exitCode).toBe(0);
    expect(raw.state.stderr).toBe('');
    expect(raw.state.stdout).toMatch(/^#compdef skill-sync\n/u);
    expect(raw.state.stdout).toContain('compdef _skill_sync skill-sync');

    const json = ioFixture();
    const jsonProgram = createProgram({
      io: json.io,
      execute: () => Promise.resolve(success({})),
    });
    await jsonProgram.parseAsync(['node', 'skill-sync', '--json', 'completion', '--shell', 'fish']);
    expect(json.state.stderr).toBe('');
    const result: unknown = JSON.parse(json.state.stdout);
    expect(result).toMatchObject({
      ok: true,
      command: 'completion',
      data: { shell: 'fish' },
    });
    if (!isRecord(result) || !isRecord(result.data) || typeof result.data.script !== 'string') {
      throw new Error('Expected completion JSON to contain a script.');
    }
    expect(result.data.script).toContain('complete -c skill-sync');
  });

  it('launches the injected TUI for bare and explicit interactive entry points', async () => {
    const { io } = ioFixture();
    const launches: TuiLaunchRequest[] = [];
    const program = createProgram({
      io,
      execute: () => Promise.resolve(success({})),
      tui: {
        launch: (request) => {
          launches.push(request);
          return Promise.resolve();
        },
      },
    });

    await launchImplicitTui(
      {
        io,
        execute: () => Promise.resolve(success({})),
        tui: {
          launch: (request) => {
            launches.push(request);
            return Promise.resolve();
          },
        },
      },
      program,
    );
    await program.parseAsync(['node', 'skill-sync', '--project', '/workspace', 'tui']);

    expect(launches).toHaveLength(2);
    expect(launches[0]?.implicit).toBe(true);
    expect(launches[1]?.implicit).toBe(false);
    expect(launches[1]?.options.project).toBe('/workspace');
  });

  it('renders one JSON result for a fully specified command', async () => {
    const { io, state } = ioFixture();
    const program = createProgram({
      io,
      execute: (invocation) => Promise.resolve(success({ selected: invocation.arguments[0] })),
    });
    await program.parseAsync(['node', 'skill-sync', '--json', 'info', 'frontend/review-ui']);
    expect(state.stderr).toBe('');
    expect(JSON.parse(state.stdout)).toMatchObject({
      ok: true,
      command: 'info',
      data: { selected: 'frontend/review-ui' },
    });
  });
});
