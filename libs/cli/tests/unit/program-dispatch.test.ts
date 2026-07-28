import { describe, expect, it } from 'vitest';

import { createProgram, type CommandInvocation } from '../../src/commands/program.js';
import { success } from '../../src/domain/result.js';
import type { RuntimeIo } from '../../src/ports/index.js';

function memoryIo(): RuntimeIo {
  return {
    stdinIsTty: false,
    stdoutIsTty: false,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    setExitCode: () => undefined,
  };
}

interface DispatchCase {
  readonly argv: readonly string[];
  readonly command: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

const dispatchCases: readonly DispatchCase[] = [
  {
    argv: [
      '--json',
      '--no-input',
      '--yes',
      '--project',
      '/project',
      'init',
      '--create',
      'acme/skills',
    ],
    command: 'init',
    options: { json: true, noInput: true, project: '/project', yes: true },
  },
  {
    argv: ['install', 'group/one', 'group/two', '--target', 'codex', '--no-gitignore', '--dry-run'],
    command: 'install',
    options: { dryRun: true, gitignore: false, target: ['codex'] },
  },
  {
    argv: ['adopt', 'group/one', '--target', 'codex', '--dry-run'],
    command: 'adopt',
    options: { dryRun: true, target: 'codex' },
  },
  {
    argv: ['sync', '--check', '--offline', '1'.repeat(40)],
    command: 'sync',
    options: { check: true, offline: '1'.repeat(40) },
  },
  {
    argv: ['update', '--all', '--discard-local'],
    command: 'update',
    options: { all: true, discardLocal: true },
  },
  { argv: ['add', './skill', '--group', 'engineering', '--dry-run'], command: 'add' },
  { argv: ['publish', 'group/one', '--from', 'codex'], command: 'publish' },
  {
    argv: ['list', '--group', 'frontend', '--group', 'backend', '--agent', 'claude'],
    command: 'list',
    options: { agent: ['claude'], group: ['frontend', 'backend'] },
  },
  { argv: ['info', 'group/one'], command: 'info' },
  { argv: ['diff', 'group/one'], command: 'diff' },
  { argv: ['status', '--offline'], command: 'status', options: { offline: true } },
  { argv: ['uninstall', '--all', '--dry-run'], command: 'uninstall' },
  { argv: ['validate', './skill'], command: 'validate' },
  { argv: ['config', 'path'], command: 'config:path' },
  { argv: ['config', 'list'], command: 'config:list' },
  { argv: ['config', 'get', 'library.remote'], command: 'config:get' },
  { argv: ['config', 'set', 'library.branch', 'main'], command: 'config:set' },
  { argv: ['config', 'unset', 'library.branch'], command: 'config:unset' },
  { argv: ['doctor', '--offline'], command: 'doctor', options: { offline: true } },
  { argv: ['library', 'remove', 'group/one', '--dry-run'], command: 'library:remove' },
  { argv: ['group', 'list'], command: 'group:list' },
  { argv: ['group', 'create', 'engineering'], command: 'group:create' },
  { argv: ['group', 'rename', 'old', 'new'], command: 'group:rename' },
  {
    argv: ['group', 'remove', 'engineering', '--recursive', '--dry-run'],
    command: 'group:remove',
    options: { dryRun: true, recursive: true },
  },
];

describe('program command dispatch', () => {
  it('dispatches every registered leaf command with normalized global and local flags', async () => {
    const seen: CommandInvocation[] = [];
    for (const entry of dispatchCases) {
      const program = createProgram({
        io: memoryIo(),
        execute: (invocation) => {
          seen.push(invocation);
          return Promise.resolve(success({}));
        },
      });
      await program.parseAsync(['node', 'skill-sync', ...entry.argv]);
      const actual = seen.at(-1);
      expect(actual?.command).toBe(entry.command);
      if (entry.options !== undefined) expect(actual?.options).toMatchObject(entry.options);
    }

    expect(seen.map((invocation) => invocation.command)).toEqual(
      dispatchCases.map((entry) => entry.command),
    );
    expect(new Set(seen.map((invocation) => invocation.command)).size).toBe(dispatchCases.length);
  });

  it('passes the explicit global scope selector to supported commands', async () => {
    const seen: CommandInvocation[] = [];
    const program = createProgram({
      io: memoryIo(),
      execute: (invocation) => {
        seen.push(invocation);
        return Promise.resolve(success({}));
      },
    });
    await program.parseAsync([
      'node',
      'skill-sync',
      '--global',
      'install',
      'group/one',
      '--target',
      'codex',
      '--dry-run',
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe('install');
    expect(seen[0]?.options).toMatchObject({ dryRun: true, global: true, target: ['codex'] });
  });
});
