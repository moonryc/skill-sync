import { describe, expect, it } from 'vitest';

import {
  nonInteractiveProcessEnvironment,
  runProcess,
} from '../../src/infrastructure/process-runner.js';

describe('typed child-process runner', () => {
  it('applies noninteractive defaults and removes hostile Git environment', async () => {
    const environment = nonInteractiveProcessEnvironment({
      GIT_DIR: '/hostile',
      PATH: process.env.PATH,
    });
    expect(environment).toMatchObject({
      GCM_INTERACTIVE: 'never',
      GH_PROMPT_DISABLED: '1',
      GIT_TERMINAL_PROMPT: '0',
      npm_config_yes: 'true',
    });
    expect(environment.GIT_DIR).toBeUndefined();

    const result = await runProcess({
      arguments: ['-e', 'process.stdout.write(process.env.GIT_TERMINAL_PROMPT ?? "missing")'],
      executable: process.execPath,
    });
    expect(result).toEqual({ exitCode: 0, stderr: '', stdout: '0' });
  });

  it('applies trusted overrides after removing hostile inherited Git environment', async () => {
    const result = await runProcess({
      arguments: [
        '-e',
        [
          'process.stdout.write(JSON.stringify({',
          '  global: process.env.GIT_CONFIG_GLOBAL,',
          '  directory: process.env.GIT_DIR ?? null,',
          '}));',
        ].join('\n'),
      ],
      env: {
        GIT_CONFIG_GLOBAL: '/hostile/inherited.gitconfig',
        GIT_DIR: '/hostile/repository',
      },
      envOverrides: {
        GIT_CONFIG_GLOBAL: '/trusted/empty.gitconfig',
      },
      executable: process.execPath,
    });

    expect(JSON.parse(result.stdout)).toEqual({
      global: '/trusted/empty.gitconfig',
      directory: null,
    });
  });

  it('closes stdin so an unexpected credential prompt cannot wait for input', async () => {
    const script = [
      "let input = '';",
      "process.stderr.write('Username: ');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  process.stdout.write([',
      '    input.length,',
      '    process.env.GIT_TERMINAL_PROMPT,',
      '    process.env.GCM_INTERACTIVE,',
      '    process.env.GH_PROMPT_DISABLED,',
      '    process.env.npm_config_yes,',
      "  ].join('|'));",
      '});',
      'process.stdin.resume();',
    ].join('\n');

    const result = await runProcess({
      arguments: ['-e', script],
      executable: process.execPath,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      exitCode: 0,
      stderr: 'Username: ',
      stdout: '0|0|never|1|true',
    });
  });

  it('bounds combined stream storage and terminates excessive output', async () => {
    await expect(
      runProcess({
        arguments: ['-e', 'process.stdout.write("x".repeat(10000))'],
        executable: process.execPath,
        maxOutputBytes: 128,
      }),
    ).rejects.toMatchObject({
      output: { stdout: 'x'.repeat(128) },
      reason: 'output-limit',
    });
  });

  it('enforces timeouts and cooperative cancellation', async () => {
    const hanging = ['-e', 'setInterval(() => {}, 1000)'];
    await expect(
      runProcess({ arguments: hanging, executable: process.execPath, timeoutMs: 25 }),
    ).rejects.toMatchObject({ reason: 'timeout' });

    const controller = new AbortController();
    const operation = runProcess({
      arguments: hanging,
      executable: process.execPath,
      signal: controller.signal,
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ reason: 'cancelled' });
  });
});
