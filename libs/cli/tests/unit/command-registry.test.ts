import { describe, expect, it } from 'vitest';

import {
  commandDefinitions,
  commandParents,
  createCommandFromDefinition,
  requestedCommandId,
  supportedCommonOptions,
  validateCommandInvocation,
} from '../../src/commands/command-registry.js';
import { createProgram } from '../../src/commands/program.js';
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

function registeredLeafIds(): readonly string[] {
  const program = createProgram({
    io: memoryIo(),
    execute: () => Promise.resolve(success({})),
  });
  const parents = new Set<string>(commandParents.map((parent) => parent.name));
  return program.commands.flatMap((command) => {
    if (!parents.has(command.name())) return [command.name()];
    return command.commands.map((child) => `${command.name()}:${child.name()}`);
  });
}

describe('typed command registry', () => {
  it('defines every public leaf exactly once with complete help and result metadata', () => {
    const ids = commandDefinitions.map((definition) => definition.id);
    const paths = commandDefinitions.map((definition) => definition.path.join(' '));
    const aliases = commandDefinitions.flatMap((definition) =>
      definition.aliases.map((alias) => [...definition.path.slice(0, -1), alias].join(' ')),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set([...paths, ...aliases]).size).toBe(paths.length + aliases.length);
    expect([...registeredLeafIds()].sort()).toEqual([...ids].sort());

    for (const definition of commandDefinitions) {
      expect(definition.examples.length, definition.id).toBeGreaterThan(0);
      expect(definition.safety.length, definition.id).toBeGreaterThan(10);
      expect(definition.documentation, definition.id).toMatch(/^https:\/\/.+#.+/u);
      expect(definition.resultSchema, definition.id).toMatch(/-v\d+$/u);
      expect(definition.aliases, definition.id).toBeDefined();
    }
  });

  it('configures parser choices and repeatable defaults from definitions', () => {
    const installDefinition = commandDefinitions.find((definition) => definition.id === 'install');
    if (installDefinition === undefined) throw new Error('Missing install definition.');
    const command = createCommandFromDefinition(installDefinition);
    const target = command.options.find((candidate) => candidate.attributeName() === 'target');
    expect(target?.argChoices).toEqual(['codex', 'claude']);
    expect(target?.defaultValue).toEqual([]);
    expect(
      command.options.find((candidate) => candidate.attributeName() === 'expectPlan'),
    ).toBeDefined();

    const initDefinition = commandDefinitions.find((definition) => definition.id === 'init');
    if (initDefinition === undefined) throw new Error('Missing init definition.');
    const init = createCommandFromDefinition(initDefinition);
    expect(init.options.find((candidate) => candidate.attributeName() === 'dryRun')).toBeDefined();
    expect(
      init.options.find((candidate) => candidate.attributeName() === 'expectPlan'),
    ).toBeDefined();

    const configSet = commandDefinitions.find((definition) => definition.id === 'config:set');
    expect(configSet?.arguments[0]?.choices).toContain('defaults.targets');

    const completion = commandDefinitions.find((definition) => definition.id === 'completion');
    const shell =
      completion === undefined
        ? undefined
        : createCommandFromDefinition(completion).options.find(
            (candidate) => candidate.attributeName() === 'shell',
          );
    expect(shell?.argChoices).toEqual(['bash', 'zsh', 'fish', 'powershell']);
    expect(shell?.mandatory).toBe(false);
  });

  it('attributes nested commands even when root scope options appear between path segments', () => {
    expect(
      requestedCommandId(['recovery', '--project', '/workspace', 'restore', 'journal-id']),
    ).toBe('recovery:restore');
    expect(requestedCommandId(['--json', 'config', 'set'])).toBe('config:set');
    expect(requestedCommandId(['--project=/workspace', 'status'])).toBe('status');
    expect(requestedCommandId(['--json', 'show', 'group/one'])).toBe('info');
  });

  it('declares show as the read-only info alias', () => {
    const info = commandDefinitions.find((definition) => definition.id === 'info');
    expect(info).toMatchObject({ aliases: ['show'], mutation: 'read-only' });
  });

  it('rejects unsupported scopes and common conflicting choices before execution', () => {
    const selfUpdate = commandDefinitions.find((definition) => definition.id === 'self-update');
    const publish = commandDefinitions.find((definition) => definition.id === 'publish');
    const install = commandDefinitions.find((definition) => definition.id === 'install');
    if (selfUpdate === undefined || publish === undefined || install === undefined) {
      throw new Error('Missing registry fixture definition.');
    }

    expect(validateCommandInvocation(selfUpdate, [], { project: '/tmp' })).toMatchObject({
      code: 'SCOPE_OPTION_UNSUPPORTED',
    });
    expect(validateCommandInvocation(publish, [[]], { global: true })).toMatchObject({
      code: 'SCOPE_OPTION_UNSUPPORTED',
    });
    expect(validateCommandInvocation(install, [['one/skill']], { all: true })).toMatchObject({
      code: 'CONFLICTING_SELECTION',
    });
    expect(
      validateCommandInvocation(install, [['one/skill']], {}, [
        'install',
        '--gitignore',
        '--no-gitignore',
      ]),
    ).toMatchObject({ code: 'CONFLICTING_OPTIONS' });
  });

  it('advertises and accepts prompt flags only for commands that can actually prompt', () => {
    const install = commandDefinitions.find((definition) => definition.id === 'install');
    const list = commandDefinitions.find((definition) => definition.id === 'list');
    const selfUpdate = commandDefinitions.find((definition) => definition.id === 'self-update');
    const unlock = commandDefinitions.find((definition) => definition.id === 'recovery:unlock');
    const tui = commandDefinitions.find((definition) => definition.id === 'tui');
    if (
      install === undefined ||
      list === undefined ||
      selfUpdate === undefined ||
      unlock === undefined ||
      tui === undefined
    ) {
      throw new Error('Missing registry fixture definition.');
    }

    expect(supportedCommonOptions(install).join('\n')).toContain('--no-input');
    expect(supportedCommonOptions(install).join('\n')).toContain('--yes');
    expect(supportedCommonOptions(list).join('\n')).not.toContain('--no-input');
    expect(supportedCommonOptions(selfUpdate).join('\n')).not.toContain('--yes');
    expect(supportedCommonOptions(unlock).join('\n')).toContain('--yes');
    expect(supportedCommonOptions(unlock).join('\n')).not.toContain('--project');
    expect(supportedCommonOptions(tui).join('\n')).not.toContain('--json');

    expect(validateCommandInvocation(list, [], { yes: true }, ['list', '--yes'])).toMatchObject({
      code: 'OPTION_UNSUPPORTED',
    });
    expect(
      validateCommandInvocation(selfUpdate, [], { noInput: true }, ['self-update', '--no-input']),
    ).toMatchObject({ code: 'OPTION_UNSUPPORTED' });
    expect(
      validateCommandInvocation(install, [['frontend/review-ui']], { noInput: true, yes: true }, [
        'install',
        '--no-input',
        '--yes',
      ]),
    ).toBeUndefined();
  });

  it('validates reviewed install fingerprints before execution', () => {
    const install = commandDefinitions.find((definition) => definition.id === 'install');
    if (install === undefined) throw new Error('Missing install definition.');

    expect(
      validateCommandInvocation(install, [['frontend/review-ui']], {
        expectPlan: 'not-a-plan',
      }),
    ).toMatchObject({ code: 'INVALID_INSTALL_PLAN_FINGERPRINT' });
    expect(
      validateCommandInvocation(install, [['frontend/review-ui']], {
        dryRun: true,
        expectPlan: `install-v1-${'a'.repeat(64)}`,
      }),
    ).toMatchObject({ code: 'CONFLICTING_OPTIONS' });
  });

  it('validates reviewed initialization fingerprints before remote inspection', () => {
    const init = commandDefinitions.find((definition) => definition.id === 'init');
    if (init === undefined) throw new Error('Missing init definition.');

    expect(
      validateCommandInvocation(init, ['https://github.com/acme/skills.git'], {
        expectPlan: 'not-a-plan',
      }),
    ).toMatchObject({ code: 'INVALID_INIT_PLAN_FINGERPRINT' });
    expect(
      validateCommandInvocation(init, ['https://github.com/acme/skills.git'], {
        dryRun: true,
        expectPlan: `init-v1-${'a'.repeat(64)}`,
      }),
    ).toMatchObject({ code: 'CONFLICTING_OPTIONS' });
  });

  it('declares the capability-scoped offline contract without misleading read-only flags', () => {
    const optionFor = (id: string) =>
      commandDefinitions
        .find((definition) => definition.id === id)
        ?.options.find((option) => option.flags.startsWith('--offline'))?.flags;

    expect(optionFor('status')).toBe('--offline');
    expect(optionFor('doctor')).toBe('--offline');
    expect(optionFor('sync')).toBe('--offline <revision>');
    expect(optionFor('update')).toBe('--offline <revision>');
    for (const id of ['list', 'info', 'diff']) expect(optionFor(id)).toBeUndefined();
  });
});
