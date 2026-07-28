import { describe, expect, it } from 'vitest';

import { success } from '../../src/domain/result.js';
import type { RuntimeIo } from '../../src/ports/index.js';
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

describe('CLI program', () => {
  it('registers the complete top-level command surface', () => {
    const { io } = ioFixture();
    const program = createProgram({ io, execute: () => Promise.resolve(success({})) });
    expect(program.commands.map((command) => command.name())).toEqual([
      'init',
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
      'library',
      'group',
    ]);
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
