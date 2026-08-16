import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  applicableCommonOptionDefinitions,
  commandDefinitions,
  commandHelpDefinition,
  commanderProvidedOptionDefinitions,
  COMPLETION_SHELLS,
} from '../../src/commands/command-registry.js';
import { buildCompletionModel, generateCompletionScript } from '../../src/commands/completion.js';

function flags(flagsDefinition: string): readonly string[] {
  return flagsDefinition.match(/-{1,2}[a-zA-Z][\w-]*/gu) ?? [];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function syntaxCheck(executable: string, arguments_: readonly string[], script: string): boolean {
  const result = spawnSync(executable, [...arguments_], {
    encoding: 'utf8',
    input: script,
  });
  if (result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT') {
    return false;
  }
  expect(result.status, `${executable}: ${result.stderr}`).toBe(0);
  return true;
}

describe('static shell completion', () => {
  it('builds every command, applicable option, and declared static choice from the registry', () => {
    const model = buildCompletionModel();
    expect(model.rootCandidates.map((candidate) => candidate.value)).toContain('completion');
    expect(model.rootCandidates.map((candidate) => candidate.value)).toContain('show');
    expect(model.rootCandidates.map((candidate) => candidate.value)).toContain(
      commandHelpDefinition.name,
    );

    for (const definition of commandDefinitions) {
      const context = model.contexts.find(
        (candidate) => candidate.path === definition.path.join(' '),
      );
      expect(context, definition.id).toBeDefined();
      const actualFlags = context?.options.flatMap((option) => option.flags) ?? [];
      const expectedFlags = [
        ...definition.options.flatMap((option) => flags(option.flags)),
        ...applicableCommonOptionDefinitions(definition).flatMap((option) => flags(option.flags)),
        ...flags(commanderProvidedOptionDefinitions.help.flags),
      ];
      expect(new Set(actualFlags), definition.id).toEqual(new Set(expectedFlags));

      for (const [index, argument] of definition.arguments.entries()) {
        if (argument.choices !== undefined) {
          expect(context?.positionalChoices[index], definition.id).toEqual(argument.choices);
        }
      }
      for (const option of definition.options) {
        if (option.choices === undefined) continue;
        const normalized = context?.options.find((candidate) =>
          flags(option.flags).every((flag) => candidate.flags.includes(flag)),
        );
        expect(normalized?.choices, `${definition.id} ${option.flags}`).toEqual(option.choices);
      }
    }

    const status = model.contexts.find((context) => context.path === 'status');
    const install = model.contexts.find((context) => context.path === 'install');
    const completion = model.contexts.find((context) => context.path === 'completion');
    const add = model.contexts.find((context) => context.path === 'add');
    const validate = model.contexts.find((context) => context.path === 'validate');
    expect(status?.options.flatMap((option) => option.flags)).not.toContain('--yes');
    expect(status?.options.flatMap((option) => option.flags)).not.toContain('--no-input');
    expect(install?.options.flatMap((option) => option.flags)).toEqual(
      expect.arrayContaining(['--target', '--no-input', '--yes', '--project', '--global']),
    );
    expect(completion?.options.flatMap((option) => option.flags)).not.toEqual(
      expect.arrayContaining(['--project', '--global']),
    );
    expect(add?.positionalValueKinds[0]).toBe('path');
    expect(validate?.positionalValueKinds[0]).toBe('path');
    expect(install?.options.find((option) => option.flags.includes('--project'))?.valueKind).toBe(
      'path',
    );
  });

  it('renders deterministic complete scripts for every supported shell', () => {
    const scripts = Object.fromEntries(
      COMPLETION_SHELLS.map((shell) => [shell, generateCompletionScript(shell)]),
    );
    expect(
      Object.fromEntries(
        Object.entries(scripts).map(([shell, script]) => [
          shell,
          { bytes: Buffer.byteLength(script), sha256: sha256(script) },
        ]),
      ),
    ).toEqual({
      bash: {
        bytes: 18_946,
        sha256: '6df84cd2355c92ce0b04b48fc4d6ac57c0731f8aa03d15243a68a69275e7ac3a',
      },
      fish: {
        bytes: 48_129,
        sha256: 'c863adafe6a2fb1102e7d9260c5354f68875c818b2a4e8f985e4096ddfb43da2',
      },
      powershell: {
        bytes: 14_197,
        sha256: '4d2d0daef2d5abd5c669b4e766ec89c3b70166206387d233fd18497155d51279',
      },
      zsh: {
        bytes: 16_726,
        sha256: '497cbfa358cdbcc5c3a211a2b7db21fec90ebc702b7b4dc8bad12fa502e727a5',
      },
    });

    for (const [shell, script] of Object.entries(scripts)) {
      expect(generateCompletionScript(shell as (typeof COMPLETION_SHELLS)[number])).toBe(script);
      expect(script, shell).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
      expect(script, shell).not.toContain(process.cwd());
      for (const value of ['completion', 'config', 'recovery', '--shell', 'powershell']) {
        expect(script, `${shell}: ${value}`).toContain(value);
      }
    }
  });

  it('passes installed shell syntax checks and can require the complete shell matrix', () => {
    const checked = {
      bash: syntaxCheck('bash', ['-n'], generateCompletionScript('bash')),
      fish: syntaxCheck('fish', ['--no-config', '--no-execute'], generateCompletionScript('fish')),
      zsh: syntaxCheck('zsh', ['-n'], generateCompletionScript('zsh')),
    };

    const parser = [
      '$errors = $null',
      '$tokens = $null',
      '[System.Management.Automation.Language.Parser]::ParseInput(',
      '  [Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null',
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }',
    ].join('\n');
    const powershell = ['pwsh', 'powershell'].some((executable) =>
      syntaxCheck(
        executable,
        ['-NoProfile', '-NonInteractive', '-Command', parser],
        generateCompletionScript('powershell'),
      ),
    );
    if (process.env.SKILL_SYNC_REQUIRE_COMPLETION_SHELLS === '1') {
      expect(checked).toEqual({ bash: true, fish: true, zsh: true });
      expect(powershell).toBe(true);
      return;
    }

    expect(Object.values(checked).some(Boolean) || powershell).toBe(true);
  });

  it('loads Bash completion with the documented macOS-compatible current-session command', () => {
    const result = spawnSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        'source /dev/stdin <<< "$SKILL_SYNC_COMPLETION"; declare -F _skill_sync >/dev/null',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, SKILL_SYNC_COMPLETION: generateCompletionScript('bash') },
      },
    );
    if (result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT') {
      return;
    }
    expect(result.status, result.stderr).toBe(0);
  });

  it('completes representative Bash commands, nested arguments, and option choices', () => {
    expect(generateCompletionScript('bash')).toContain(
      'complete -o filenames -F _skill_sync skill-sync',
    );
    const exercise = [
      generateCompletionScript('bash'),
      'COMP_WORDS=(skill-sync "")',
      'COMP_CWORD=1',
      '_skill_sync',
      'printf "ROOT:%s\\n" "${COMPREPLY[*]}"',
      'COMP_WORDS=(skill-sync config set "")',
      'COMP_CWORD=3',
      '_skill_sync',
      'printf "CONFIG:%s\\n" "${COMPREPLY[*]}"',
      'COMP_WORDS=(skill-sync install --target "")',
      'COMP_CWORD=3',
      '_skill_sync',
      'printf "TARGET:%s\\n" "${COMPREPLY[*]}"',
      'COMP_WORDS=(skill-sync list --state "")',
      'COMP_CWORD=3',
      '_skill_sync',
      'printf "STATE:%s\\n" "${COMPREPLY[*]}"',
      'COMP_WORDS=(skill-sync install --target=c)',
      'COMP_CWORD=2',
      '_skill_sync',
      'printf "EQUALS:%s\\n" "${COMPREPLY[*]}"',
      'compgen() { if [[ "$1" == -d ]]; then printf "__DIRECTORY__\\n__WITH SPACE__\\n"; else builtin compgen "$@"; fi; }',
      'COMP_WORDS=(skill-sync --project "libs/")',
      'COMP_CWORD=2',
      '_skill_sync',
      'printf "PROJECT:%s:%s:%s\\n" "${#COMPREPLY[@]}" "${COMPREPLY[0]}" "${COMPREPLY[1]}"',
      'COMP_WORDS=(skill-sync install "--project=libs/")',
      'COMP_CWORD=2',
      '_skill_sync',
      'printf "EQUALS-PATH:%s:%s:%s\\n" "${#COMPREPLY[@]}" "${COMPREPLY[0]}" "${COMPREPLY[1]}"',
      'COMP_WORDS=(skill-sync add "libs/")',
      'COMP_CWORD=2',
      '_skill_sync',
      'printf "ADD:%s:%s:%s\\n" "${#COMPREPLY[@]}" "${COMPREPLY[0]}" "${COMPREPLY[1]}"',
      'COMP_WORDS=(skill-sync init --branch "")',
      'COMP_CWORD=3',
      '_skill_sync',
      'printf "BRANCH:%s\\n" "${COMPREPLY[*]}"',
      'COMP_WORDS=(skill-sync install -- "")',
      'COMP_CWORD=3',
      '_skill_sync',
      'printf "SEPARATOR:%s\\n" "${COMPREPLY[*]}"',
    ].join('\n');
    const result = spawnSync('bash', ['--noprofile', '--norc'], {
      encoding: 'utf8',
      input: exercise,
    });
    if (result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT') {
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ROOT:');
    expect(result.stdout).toContain('completion');
    expect(result.stdout).toContain('CONFIG:library.remote');
    expect(result.stdout).toContain('defaults.gitignore');
    expect(result.stdout).toContain('TARGET:codex claude');
    expect(result.stdout).toContain('STATE:not-installed current outdated');
    expect(result.stdout).toContain('EQUALS:--target=codex');
    expect(result.stdout).toContain('PROJECT:2:__DIRECTORY__:__WITH SPACE__');
    expect(result.stdout).toContain(
      'EQUALS-PATH:2:--project=__DIRECTORY__:--project=__WITH SPACE__',
    );
    expect(result.stdout).toContain('ADD:2:__DIRECTORY__:__WITH SPACE__');
    expect(result.stdout).toContain('BRANCH:\n');
    expect(result.stdout).toContain('SEPARATOR:\n');
  });

  it('handles Zsh equals choices, value slots, paths, and separators', () => {
    const exercise = [
      generateCompletionScript('zsh'),
      'compadd() {',
      '  while (( $# > 0 )); do',
      '    case "$1" in -Q|--) shift ;; *) break ;; esac',
      '  done',
      '  print -rl -- "$@"',
      '}',
      '_directories() { print -r -- __DIRECTORIES__; }',
      'typeset -a words',
      'words=(skill-sync install "--target=c")',
      'CURRENT=3',
      'print -r -- EQUALS-BEGIN',
      '_skill_sync',
      'print -r -- EQUALS-END',
      'words=(skill-sync init --branch "")',
      'CURRENT=4',
      'print -r -- VALUE-BEGIN',
      '_skill_sync',
      'print -r -- VALUE-END',
      'words=(skill-sync add "libs/")',
      'CURRENT=3',
      'print -r -- PATH-BEGIN',
      '_skill_sync',
      'print -r -- PATH-END',
      'words=(skill-sync install "--project=libs/")',
      'CURRENT=3',
      'print -r -- EQUALS-PATH-BEGIN',
      '_skill_sync',
      'print -r -- EQUALS-PATH-END',
      'words=(skill-sync install -- "")',
      'CURRENT=4',
      'print -r -- SEPARATOR-BEGIN',
      '_skill_sync',
      'print -r -- SEPARATOR-END',
    ].join('\n');
    const result = spawnSync('zsh', ['-f'], { encoding: 'utf8', input: exercise });
    if (result.error !== undefined && 'code' in result.error && result.error.code === 'ENOENT') {
      return;
    }
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('EQUALS-BEGIN\n--target=codex\n--target=claude\nEQUALS-END');
    expect(result.stdout).toContain('VALUE-BEGIN\nVALUE-END');
    expect(result.stdout).toContain('PATH-BEGIN\n__DIRECTORIES__\nPATH-END');
    expect(result.stdout).toContain('EQUALS-PATH-BEGIN\n__DIRECTORIES__\nEQUALS-PATH-END');
    expect(result.stdout).toContain('SEPARATOR-BEGIN\nSEPARATOR-END');
  });

  it('generates cursor-aware PowerShell completion with equals and path handling', () => {
    const script = generateCompletionScript('powershell');
    expect(script).toContain('Extent.StartOffset -lt $cursorPosition');
    expect(script).toContain('Extent.EndOffset -ge $cursorPosition');
    expect(script).toContain('$wordToComplete -match "^(--[^=]+)=(.*)$"');
    expect(script).toContain('CompletionCompleters]::CompleteFilename');
    expect(script).toContain('$afterSeparator');
  });
});
