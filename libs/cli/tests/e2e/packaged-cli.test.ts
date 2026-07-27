import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withTempDirectory } from '../helpers/temp.js';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workspaceRoot = join(projectRoot, '..', '..');
const cliPath = join(workspaceRoot, 'dist', 'libs', 'cli', 'dist', 'cli.js');

interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function execute(
  executable: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment = { ...process.env, ...options.env };
    Reflect.deleteProperty(environment, 'FORCE_COLOR');
    const child = spawn(executable, [...arguments_], {
      cwd: options.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

describe('built CLI from unrelated directories', () => {
  it('returns stable help/version and usage statuses', async () => {
    await withTempDirectory('skill-sync-e2e-shell-', async (unrelated) => {
      const version = await execute(process.execPath, [cliPath, '--version'], { cwd: unrelated });
      expect(version).toMatchObject({ status: 0, stderr: '' });
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);

      const help = await execute(process.execPath, [cliPath, '--help'], { cwd: unrelated });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain('Manage Git-backed AI skills');

      const invalid = await execute(process.execPath, [cliPath, 'not-a-command'], {
        cwd: unrelated,
      });
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain('unknown command');

      const invalidJson = await execute(process.execPath, [cliPath, '--json', 'info'], {
        cwd: unrelated,
      });
      expect(invalidJson.status).toBe(2);
      expect(invalidJson.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(invalidJson.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command: 'info',
        errors: [{ code: 'USAGE_ERROR' }],
      });
    });
  });

  it('runs fully specified no-input JSON config and local validation workflows', async () => {
    await withTempDirectory('skill-sync-e2e-json-', async (root) => {
      const unrelated = join(root, 'unrelated');
      const skill = join(root, 'source-skill');
      const configHome = join(root, 'isolated-state');
      await mkdir(unrelated);
      await mkdir(skill);
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: source-skill\ndescription: E2E fixture\n---\n\n# Fixture\n',
      );
      const environment = { SKILL_SYNC_CONFIG_HOME: configHome };

      const configured = await execute(
        process.execPath,
        [cliPath, '--no-input', '--json', 'config', 'set', 'defaults.targets', 'codex,claude'],
        { cwd: unrelated, env: environment },
      );
      expect(configured.status).toBe(0);
      expect(JSON.parse(configured.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: 'config:set',
        data: { key: 'defaults.targets', value: ['claude', 'codex'] },
      });

      const validated = await execute(
        process.execPath,
        [cliPath, '--no-input', '--json', 'validate', skill],
        { cwd: unrelated, env: environment },
      );
      expect(validated.status).toBe(0);
      const envelope = JSON.parse(validated.stdout) as {
        readonly ok: boolean;
        readonly command: string;
        readonly data: { readonly kind: string; readonly valid: boolean };
      };
      expect(envelope).toMatchObject({
        ok: true,
        command: 'validate',
        data: { kind: 'local-path', valid: true },
      });
      expect(validated.stdout.trim().split('\n')).toHaveLength(1);
      expect(validated.stderr).toBe('');
    });
  });
});
