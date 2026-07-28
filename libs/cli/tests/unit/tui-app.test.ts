import { createElement } from 'react';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { DefaultTuiActionPort } from '../../src/ui/tui/runner.js';
import { TuiApp } from '../../src/ui/tui/app.js';
import { success } from '../../src/domain/result.js';
import type { CommandInvocation } from '../../src/commands/program.js';
import type { TuiDashboard } from '../../src/ui/tui/types.js';

describe('TUI renderer and action port', () => {
  it('renders a compact no-color loading screen without opening a terminal session', () => {
    const output = renderToString(
      createElement(TuiApp, {
        actions: {
          adopt: () => Promise.resolve(success({})),
          install: () => Promise.resolve(success({})),
          load: () => new Promise<TuiDashboard>(() => undefined),
          sync: () => Promise.resolve(success({})),
        },
        color: false,
        implicit: false,
      }),
      { columns: 40 },
    );

    expect(output).toContain('skill-sync command center');
    expect(output).toContain('Loading your skill library');
    expect(output).not.toContain('\u001b[');
  });

  it('routes confirmed UI operations through the existing command executor contract', async () => {
    const calls: CommandInvocation[] = [];
    const port = new DefaultTuiActionPort(
      (input) => {
        calls.push(input);
        return Promise.resolve(success({}));
      },
      { project: '/workspace' },
    );

    await port.adopt('frontend/review-ui', 'codex');
    await port.install(['frontend/review-ui'], ['codex', 'claude']);
    await port.sync(true);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.command).toBe('adopt');
    expect(calls[0]?.arguments).toEqual(['frontend/review-ui']);
    expect(calls[0]?.options).toMatchObject({
      json: true,
      noInput: true,
      target: 'codex',
      yes: true,
    });
    expect(calls[1]?.command).toBe('install');
    expect(calls[1]?.arguments).toEqual([['frontend/review-ui']]);
    expect(calls[1]?.options).toMatchObject({
      gitignore: false,
      json: true,
      noInput: true,
      target: ['codex', 'claude'],
      yes: true,
    });
    expect(calls[2]?.command).toBe('sync');
    expect(calls[2]?.arguments).toEqual([]);
    expect(calls[2]?.options).toMatchObject({
      discardLocal: true,
      json: true,
      noInput: true,
      yes: true,
    });
  });
});
