import { spawn } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withTempDirectory } from '../helpers/temp.js';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const workspaceRoot = join(projectRoot, '..', '..');
const cliPath = join(workspaceRoot, 'dist', 'libs', 'cli', 'dist', 'cli.js');

interface ProcessResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function execute(
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const environment = { ...process.env, ...options.env };
    Reflect.deleteProperty(environment, 'FORCE_COLOR');
    const child = spawn(process.execPath, [cliPath, ...arguments_], {
      cwd: options.cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let stdout = '';
    child.stderr.setEncoding('utf8');
    child.stdout.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', (status) => resolvePromise({ status, stderr, stdout }));
  });
}

describe('empty project status', () => {
  it('uses the current project by default and honors an explicit --project path', async () => {
    await withTempDirectory('skill-sync-e2e-empty-status-', async (root) => {
      const currentProject = join(root, 'current-project');
      const explicitProject = join(root, 'explicit-project');
      const environment = { SKILL_SYNC_CONFIG_HOME: join(root, 'isolated-state') };
      await mkdir(currentProject);
      await mkdir(explicitProject);

      const human = await execute(['status'], { cwd: currentProject, env: environment });
      expect(human).toMatchObject({ status: 0, stderr: '' });
      expect(human.stdout).toContain('Scope: project');
      expect(human.stdout).toContain(`Project: ${await realpath(currentProject)}`);
      expect(human.stdout).toContain('No managed skills are tracked in this project.');
      expect(human.stdout).toContain('Next: Preview setup with skill-sync init');

      const explicitHuman = await execute(['--project', explicitProject, 'status'], {
        cwd: currentProject,
        env: environment,
      });
      expect(explicitHuman).toMatchObject({ status: 0, stderr: '' });
      expect(explicitHuman.stdout).toContain(`Project: ${await realpath(explicitProject)}`);
      expect(explicitHuman.stdout).toContain(
        'then run skill-sync --project <project-path> list, using the Project path shown above.',
      );
      expect(explicitHuman.stdout).not.toContain('skill-sync --project <project-path> init');

      const json = await execute(['--json', '--project', explicitProject, 'status'], {
        cwd: currentProject,
        env: environment,
      });
      expect(json).toMatchObject({ status: 0, stderr: '' });
      expect(json.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(json.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        command: 'status',
        data: {
          managed: false,
          nextAction: 'skill-sync init <repository-url> --dry-run',
          operation: 'status',
          projectRoot: await realpath(explicitProject),
          skills: [],
        },
      });
    });
  });

  it.each([
    ['online', []],
    ['offline', ['--offline']],
  ] as const)(
    'reports empty global status %s without creating application state',
    async (_, mode) => {
      await withTempDirectory('skill-sync-e2e-empty-global-status-', async (root) => {
        const cwd = join(root, 'work');
        const isolatedState = join(root, 'isolated-state');
        const globalState = join(isolatedState, 'state', 'global');
        const environment = { SKILL_SYNC_CONFIG_HOME: isolatedState };
        await mkdir(cwd);

        const human = await execute(['--global', 'status', ...mode], { cwd, env: environment });
        expect(human).toMatchObject({ status: 0, stderr: '' });
        expect(human.stdout).toBe(
          [
            'Scope: global',
            `State: no global manifest or lock in ${globalState}`,
            'No managed skills are tracked globally.',
            'Next: Preview setup with skill-sync init <repository-url> --dry-run (or skill-sync init --create <owner/name> --dry-run), run the exact --expect-plan command it prints, then run skill-sync list --global.',
            '',
          ].join('\n'),
        );

        const json = await execute(['--json', '--global', 'status', ...mode], {
          cwd,
          env: environment,
        });
        expect(json).toMatchObject({ status: 0, stderr: '' });
        expect(json.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(json.stdout)).toEqual({
          schemaVersion: 1,
          ok: true,
          command: 'status',
          data: {
            managed: false,
            nextAction: 'skill-sync init <repository-url> --dry-run',
            operation: 'status',
            scope: 'global',
            skills: [],
            stateDirectory: globalState,
          },
        });
        await expect(stat(isolatedState)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );
});
