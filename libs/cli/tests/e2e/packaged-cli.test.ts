import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
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

      const versionCommand = await execute(process.execPath, [cliPath, 'version'], {
        cwd: unrelated,
      });
      expect(versionCommand).toMatchObject({ status: 0, stderr: '' });
      expect(versionCommand.stdout.trim()).toBe(version.stdout.trim());

      const jsonVersion = await execute(process.execPath, [cliPath, '--json', 'version'], {
        cwd: unrelated,
      });
      expect(jsonVersion).toMatchObject({ status: 0, stderr: '' });
      expect(JSON.parse(jsonVersion.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        command: 'version',
        data: { version: version.stdout.trim() },
      });

      const help = await execute(process.execPath, [cliPath, '--help'], { cwd: unrelated });
      expect(help.status).toBe(0);
      expect(help.stderr).toBe('');
      expect(help.stdout.startsWith('Quick start (preview setup → apply → list → install):')).toBe(
        true,
      );
      expect(help.stdout).toContain('skill-sync init --create <owner/name> --dry-run');
      expect(help.stdout).toContain('Manage Git-backed AI skills');
      expect(help.stdout).toContain('Lifecycle:');
      expect(help.stdout).toContain('Setup:');
      expect(help.stdout).toContain('completion');
      expect(help.stdout).toContain('Discovery:');
      expect(help.stdout).toContain('Managed skills (project or global):');
      expect(help.stdout).toContain('Library management:');
      expect(help.stdout).toContain('Recovery:');
      expect(help.stdout).toContain('Diagnostics:');
      expect(help.stdout).toContain(
        'Wiki: https://github.com/moonryc/skill-sync/tree/main/apps/wiki/src/content/docs',
      );

      const initHelp = await execute(process.execPath, [cliPath, 'init', '--help'], {
        cwd: unrelated,
      });
      expect(initHelp).toMatchObject({ status: 0, stderr: '' });
      expect(initHelp.stdout).toContain('--create <owner/name>');
      expect(initHelp.stdout).toContain('private (default), public, or internal');
      expect(initHelp.stdout).toContain('https (default) or ssh');
      expect(initHelp.stdout).toContain('Common options:');
      expect(initHelp.stdout).toContain('--no-input');
      expect(initHelp.stdout).not.toContain('--project <path>');

      const installHelp = await execute(process.execPath, [cliPath, 'install', '--help'], {
        cwd: unrelated,
      });
      expect(installHelp).toMatchObject({ status: 0, stderr: '' });
      expect(installHelp.stdout).toContain('target agent: codex or claude (repeatable)');
      expect(installHelp.stdout).toContain('--expect-plan <fingerprint>');
      expect(installHelp.stdout).toContain('exact reviewed dry-run plan');
      expect(installHelp.stdout).toContain('skill-sync --global install');
      expect(installHelp.stdout).toContain('Common options:');
      expect(installHelp.stdout).toContain('--no-input');

      const configSetHelp = await execute(process.execPath, [cliPath, 'config', 'set', '--help'], {
        cwd: unrelated,
      });
      expect(configSetHelp).toMatchObject({ status: 0, stderr: '' });
      expect(configSetHelp.stdout).toContain('defaults.targets');
      expect(configSetHelp.stdout).toContain('defaults.gitignore');
      expect(configSetHelp.stdout).toContain('skill-sync config set defaults.targets codex,claude');
      expect(configSetHelp.stdout).toContain('/reference/configuration.md#config-set');
      expect(configSetHelp.stdout).not.toContain('--no-input:');
      expect(configSetHelp.stdout).not.toContain('--yes:');

      const listHelp = await execute(process.execPath, [cliPath, 'list', '--help'], {
        cwd: unrelated,
      });
      expect(listHelp).toMatchObject({ status: 0, stderr: '' });
      expect(listHelp.stdout).toContain('--agent: codex or claude');
      expect(listHelp.stdout).toContain('not-installed');
      expect(listHelp.stdout).toContain('skill-sync list --query review');
      expect(listHelp.stdout).not.toContain('--no-input:');
      expect(listHelp.stdout).not.toContain('--yes:');

      const tuiHelp = await execute(process.execPath, [cliPath, 'tui', '--help'], {
        cwd: unrelated,
      });
      expect(tuiHelp).toMatchObject({ status: 0, stderr: '' });
      expect(tuiHelp.stdout).not.toContain('--json:');
      expect(tuiHelp.stdout).not.toContain('--no-input:');
      expect(tuiHelp.stdout).not.toContain('--yes:');

      const adoptHelp = await execute(process.execPath, [cliPath, 'adopt', '--help'], {
        cwd: unrelated,
      });
      expect(adoptHelp).toMatchObject({ status: 0, stderr: '' });
      expect(adoptHelp.stdout).toContain('--project <path>');
      expect(adoptHelp.stdout).toContain('--global');
      expect(adoptHelp.stdout).toContain('Adopt verifies an exact digest match');

      const unusedState = join(unrelated, 'unused-state');

      for (const [arguments_, command] of [
        [['--json', 'list', '--offline'], 'list'],
        [['--json', 'info', 'frontend/review-ui', '--offline'], 'info'],
        [['--json', 'diff', 'frontend/review-ui', '--offline'], 'diff'],
      ] as const) {
        const unsupportedOffline = await execute(process.execPath, [cliPath, ...arguments_], {
          cwd: unrelated,
          env: { SKILL_SYNC_CONFIG_HOME: unusedState },
        });
        expect(unsupportedOffline).toMatchObject({ status: 2, stderr: '' });
        expect(JSON.parse(unsupportedOffline.stdout)).toMatchObject({
          ok: false,
          command,
          errors: [{ code: 'USAGE_ERROR' }],
        });
      }
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });

      const bare = await execute(process.execPath, [cliPath], {
        cwd: unrelated,
        env: { SKILL_SYNC_CONFIG_HOME: unusedState },
      });
      expect(bare).toMatchObject({ status: 0, stderr: '' });
      expect(bare.stdout).toContain('skill-sync quick start');
      expect(bare.stdout).toContain('skill-sync init <repository-url> --dry-run');
      expect(bare.stdout).toContain('Run the exact --expect-plan command printed by the preview.');
      expect(bare.stdout).toContain('skill-sync list');
      expect(bare.stdout).toContain('skill-sync install <group/skill>');
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });

      const bareNoColor = await execute(process.execPath, [cliPath, '--no-color'], {
        cwd: unrelated,
        env: { SKILL_SYNC_CONFIG_HOME: unusedState },
      });
      expect(bareNoColor).toMatchObject({ status: 0, stderr: '' });
      expect(bareNoColor.stdout).toContain('skill-sync quick start');

      const bareJson = await execute(process.execPath, [cliPath, '--json'], {
        cwd: unrelated,
        env: { SKILL_SYNC_CONFIG_HOME: unusedState },
      });
      expect(bareJson).toMatchObject({ status: 0, stderr: '' });
      expect(bareJson.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(bareJson.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: 'skill-sync',
        data: {
          mode: 'quick-start',
          commands: [
            'skill-sync init <repository-url> --dry-run',
            'skill-sync init --create <owner/name> --dry-run',
            'skill-sync list',
            'skill-sync install <group/skill> --target codex --gitignore',
          ],
        },
      });
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });

      const bareGlobal = await execute(process.execPath, [cliPath, '--global'], {
        cwd: unrelated,
        env: { SKILL_SYNC_CONFIG_HOME: unusedState },
      });
      expect(bareGlobal).toMatchObject({ status: 0, stderr: '' });
      expect(bareGlobal.stdout).toContain('skill-sync --global list');
      expect(bareGlobal.stdout).toContain(
        'skill-sync --global install <group/skill> --target codex',
      );
      expect(bareGlobal.stdout).not.toContain('--global init');

      const bareProject = await execute(
        process.execPath,
        [cliPath, '--project', unrelated, '--no-color'],
        { cwd: unrelated, env: { SKILL_SYNC_CONFIG_HOME: unusedState } },
      );
      expect(bareProject).toMatchObject({ status: 0, stderr: '' });
      expect(bareProject.stdout).toContain('skill-sync --project <path> list');
      expect(bareProject.stdout).toContain(
        'skill-sync --project <path> install <group/skill> --target codex --gitignore',
      );

      const conflictingScope = await execute(
        process.execPath,
        [cliPath, '--json', '--global', '--project', unrelated],
        { cwd: unrelated, env: { SKILL_SYNC_CONFIG_HOME: unusedState } },
      );
      expect(conflictingScope).toMatchObject({ status: 2, stderr: '' });
      expect(JSON.parse(conflictingScope.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command: 'skill-sync',
        errors: [{ code: 'CONFLICTING_SCOPE_OPTIONS' }],
      });
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });

      for (const [arguments_, command] of [
        [['--json', 'install', 'one/skill', '--target', 'cursor'], 'install'],
        [['--json', 'list', '--state', 'currnt'], 'list'],
        [['--json', 'config', 'get', 'unknown.key'], 'config:get'],
      ] as const) {
        const choiceFailure = await execute(process.execPath, [cliPath, ...arguments_], {
          cwd: unrelated,
          env: { SKILL_SYNC_CONFIG_HOME: unusedState },
        });
        expect(choiceFailure).toMatchObject({ status: 2, stderr: '' });
        expect(JSON.parse(choiceFailure.stdout)).toMatchObject({
          schemaVersion: 1,
          ok: false,
          command,
          errors: [{ code: 'USAGE_ERROR' }],
        });
      }

      const malformedPlan = await execute(
        process.execPath,
        [
          cliPath,
          '--json',
          'install',
          'one/skill',
          '--target',
          'codex',
          '--expect-plan',
          'not-a-plan',
        ],
        { cwd: unrelated, env: { SKILL_SYNC_CONFIG_HOME: unusedState } },
      );
      expect(malformedPlan).toMatchObject({ status: 2, stderr: '' });
      expect(JSON.parse(malformedPlan.stdout)).toMatchObject({
        ok: false,
        command: 'install',
        errors: [{ code: 'INVALID_INSTALL_PLAN_FINGERPRINT' }],
      });
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });

      const unsupportedScope = await execute(
        process.execPath,
        [cliPath, '--json', '--project', unrelated, 'config', 'set', 'defaults.targets', 'codex'],
        { cwd: unrelated, env: { SKILL_SYNC_CONFIG_HOME: unusedState } },
      );
      expect(unsupportedScope).toMatchObject({ status: 2, stderr: '' });
      expect(JSON.parse(unsupportedScope.stdout)).toMatchObject({
        ok: false,
        command: 'config:set',
        errors: [{ code: 'SCOPE_OPTION_UNSUPPORTED' }],
      });

      for (const [arguments_, command] of [
        [['--json', 'status', '--yes'], 'status'],
        [['--json', 'version', '--no-input'], 'version'],
      ] as const) {
        const unsupportedPromptOption = await execute(process.execPath, [cliPath, ...arguments_], {
          cwd: unrelated,
          env: { SKILL_SYNC_CONFIG_HOME: unusedState },
        });
        expect(unsupportedPromptOption).toMatchObject({ status: 2, stderr: '' });
        expect(JSON.parse(unsupportedPromptOption.stdout)).toMatchObject({
          ok: false,
          command,
          errors: [{ code: 'OPTION_UNSUPPORTED' }],
        });
      }
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });

      for (const arguments_ of [
        ['--json', 'install', 'one/skill', '--all'],
        ['--json', 'install', 'one/skill', '--gitignore', '--no-gitignore'],
        [
          '--json',
          'install',
          'one/skill',
          '--dry-run',
          '--expect-plan',
          `install-v1-${'a'.repeat(64)}`,
        ],
      ]) {
        const conflict = await execute(process.execPath, [cliPath, ...arguments_], {
          cwd: unrelated,
          env: { SKILL_SYNC_CONFIG_HOME: unusedState },
        });
        expect(conflict).toMatchObject({ status: 2, stderr: '' });
        expect(JSON.parse(conflict.stdout)).toMatchObject({
          ok: false,
          command: 'install',
        });
      }
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });

      const invalid = await execute(process.execPath, [cliPath, 'not-a-command'], {
        cwd: unrelated,
      });
      expect(invalid.status).toBe(2);
      expect(invalid.stderr).toContain('unknown command');

      const commandTypo = await execute(process.execPath, [cliPath, 'instal'], {
        cwd: unrelated,
      });
      expect(commandTypo.status).toBe(2);
      expect(commandTypo.stderr).toContain('Did you mean install?');

      const optionTypo = await execute(process.execPath, [cliPath, 'install', '--dryrun'], {
        cwd: unrelated,
      });
      expect(optionTypo.status).toBe(2);
      expect(optionTypo.stderr).toContain('Did you mean --dry-run?');

      const invalidJson = await execute(process.execPath, [cliPath, '--json', 'info'], {
        cwd: unrelated,
      });
      expect(invalidJson.status).toBe(2);
      expect(invalidJson.stderr).toBe('');
      expect(invalidJson.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(invalidJson.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: false,
        command: 'info',
        errors: [{ code: 'USAGE_ERROR' }],
      });
    });
  }, 15_000);

  it('recovers a crash-left local advisory lock through a preview-first packaged workflow', async () => {
    await withTempDirectory('skill-sync-e2e-recovery-unlock-', async (root) => {
      const configHome = join(root, 'config');
      const lockPath = join(configHome, 'state', 'locks', 'user-configuration.lock');
      const ownerToken = '00000000-0000-4000-8000-000000000000';
      const createLockScript = `
        import { mkdir, utimes, writeFile } from 'node:fs/promises';
        import { hostname } from 'node:os';
        import { dirname } from 'node:path';
        const [path, ownerToken] = process.argv.slice(1);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify({
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          hostname: hostname(),
          operationId: 'crashed-setup',
          ownerToken,
          pid: process.pid,
          schemaVersion: 1,
          scope: { id: 'user-configuration', kind: 'global' }
        }));
        const oldHeartbeat = new Date(Date.now() - 120_000);
        await utimes(path, oldHeartbeat, oldHeartbeat);
      `;
      const created = await execute(
        process.execPath,
        ['--input-type=module', '-e', createLockScript, lockPath, ownerToken],
        { cwd: root },
      );
      expect(created).toMatchObject({ status: 0, stderr: '' });
      const environment = { NO_COLOR: '1', SKILL_SYNC_CONFIG_HOME: configHome };

      const listed = await execute(process.execPath, [cliPath, '--json', 'recovery', 'list'], {
        cwd: root,
        env: environment,
      });
      expect(listed).toMatchObject({ status: 0, stderr: '' });
      const listEnvelope = JSON.parse(listed.stdout) as {
        readonly data: {
          readonly records: readonly { readonly id: string; readonly kind: string }[];
        };
      };
      const id = listEnvelope.data.records.find((record) => record.kind === 'lock')?.id;
      if (id === undefined) throw new Error('Expected packaged lock recovery record.');

      const inspected = await execute(process.execPath, [cliPath, 'recovery', 'inspect', id], {
        cwd: root,
        env: environment,
      });
      expect(inspected).toMatchObject({ status: 0 });
      expect(inspected.stdout).toContain(`skill-sync recovery unlock ${id} --dry-run`);
      expect(inspected.stdout).not.toContain(ownerToken);

      const inspectedJson = await execute(
        process.execPath,
        [cliPath, '--json', 'recovery', 'inspect', id],
        { cwd: root, env: environment },
      );
      expect(inspectedJson).toMatchObject({ status: 0 });
      expect(inspectedJson.stdout).not.toContain(ownerToken);
      expect(inspectedJson.stdout).not.toContain('ownerToken');

      const preview = await execute(
        process.execPath,
        [cliPath, '--json', 'recovery', 'unlock', id],
        { cwd: root, env: environment },
      );
      expect(preview).toMatchObject({ status: 0, stderr: '' });
      expect(JSON.parse(preview.stdout)).toMatchObject({
        ok: true,
        command: 'recovery:unlock',
        data: { applied: false, id, path: lockPath, status: 'abandoned' },
      });
      expect(preview.stdout).not.toContain(ownerToken);
      expect(await stat(lockPath)).toBeDefined();

      const applied = await execute(
        process.execPath,
        [cliPath, '--json', '--no-input', '--yes', 'recovery', 'unlock', id],
        { cwd: root, env: environment },
      );
      expect(applied).toMatchObject({ status: 0, stderr: '' });
      expect(JSON.parse(applied.stdout)).toMatchObject({
        ok: true,
        command: 'recovery:unlock',
        data: { applied: true, id, path: lockPath, status: 'abandoned' },
      });
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 15_000);

  it('preserves a replacement live lock when two packaged unlockers race', async () => {
    await withTempDirectory('skill-sync-e2e-recovery-unlock-race-', async (root) => {
      const configHome = join(root, 'config');
      const lockPath = join(configHome, 'state', 'locks', 'user-configuration.lock');
      await mkdir(dirname(lockPath), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          hostname: hostname(),
          operationId: 'crashed-setup',
          ownerToken: '00000000-0000-4000-8000-000000000001',
          pid: 2_147_483_647,
          schemaVersion: 1,
          scope: { id: 'user-configuration', kind: 'global' },
        }),
      );
      const oldHeartbeat = new Date(Date.now() - 120_000);
      await utimes(lockPath, oldHeartbeat, oldHeartbeat);
      const environment = { NO_COLOR: '1', SKILL_SYNC_CONFIG_HOME: configHome };
      const listed = await execute(process.execPath, [cliPath, '--json', 'recovery', 'list'], {
        cwd: root,
        env: environment,
      });
      const listEnvelope = JSON.parse(listed.stdout) as {
        readonly data: {
          readonly records: readonly { readonly id: string; readonly kind: string }[];
        };
      };
      const id = listEnvelope.data.records.find((record) => record.kind === 'lock')?.id;
      if (id === undefined) throw new Error('Expected packaged lock recovery record.');

      const replacementToken = '00000000-0000-4000-8000-000000000002';
      const acquireReplacementScript = `
        import { open } from 'node:fs/promises';
        import { hostname } from 'node:os';
        import { setTimeout as delay } from 'node:timers/promises';
        const [path, ownerToken] = process.argv.slice(1);
        for (;;) {
          try {
            const handle = await open(path, 'wx', 0o600);
            await handle.writeFile(JSON.stringify({
              createdAt: new Date().toISOString(),
              hostname: hostname(),
              operationId: 'replacement-live-setup',
              ownerToken,
              pid: process.pid,
              schemaVersion: 1,
              scope: { id: 'user-configuration', kind: 'global' }
            }));
            await handle.sync();
            await handle.close();
            process.stdout.write('replacement-ready\\n');
            setInterval(() => {}, 1_000);
            break;
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            await delay(5);
          }
        }
      `;
      const replacement = spawn(
        process.execPath,
        ['--input-type=module', '-e', acquireReplacementScript, lockPath, replacementToken],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );

      try {
        const unlockArguments = [
          cliPath,
          '--json',
          '--no-input',
          '--yes',
          'recovery',
          'unlock',
          id,
        ];
        const [first, second] = await Promise.all([
          execute(process.execPath, unlockArguments, { cwd: root, env: environment }),
          execute(process.execPath, unlockArguments, { cwd: root, env: environment }),
          once(replacement.stdout, 'data'),
        ]);
        expect([first.status, second.status].sort()).toEqual([0, 5]);
        expect(await readFile(lockPath, 'utf8')).toContain(replacementToken);
        expect(await readFile(lockPath, 'utf8')).toContain('replacement-live-setup');
      } finally {
        if (replacement.exitCode === null && replacement.signalCode === null) {
          replacement.kill('SIGTERM');
          await once(replacement, 'exit');
        }
      }
    });
  }, 15_000);

  it('turns common onboarding command guesses into exact init commands before state access', async () => {
    await withTempDirectory('skill-sync-e2e-onboarding-guidance-', async (unrelated) => {
      const unusedState = join(unrelated, 'unused-state');
      const cases = [
        {
          command: 'setup',
          message:
            'Unknown command "setup". Preview an existing library with: skill-sync init <repository-url> --dry-run',
        },
        {
          command: 'create',
          message:
            'Unknown command "create". Preview GitHub library creation with: skill-sync init --create <owner/name> --dry-run',
        },
      ] as const;

      for (const item of cases) {
        const human = await execute(process.execPath, [cliPath, item.command], {
          cwd: unrelated,
          env: { SKILL_SYNC_CONFIG_HOME: unusedState },
        });
        expect(human).toMatchObject({ status: 2, stdout: '' });
        expect(human.stderr).toContain(item.message);
        expect(human.stderr).not.toContain('Did you mean');

        const json = await execute(process.execPath, [cliPath, '--json', item.command], {
          cwd: unrelated,
          env: { SKILL_SYNC_CONFIG_HOME: unusedState },
        });
        expect(json).toMatchObject({ status: 2, stderr: '' });
        expect(json.stdout.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(json.stdout)).toMatchObject({
          schemaVersion: 1,
          ok: false,
          command: item.command,
          errors: [{ code: 'USAGE_ERROR', message: item.message }],
        });
      }

      const versionWins = await execute(process.execPath, [cliPath, 'setup', '--version'], {
        cwd: unrelated,
        env: { SKILL_SYNC_CONFIG_HOME: unusedState },
      });
      expect(versionWins).toMatchObject({ status: 0, stderr: '' });
      expect(versionWins.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);

      const jsonVersionWins = await execute(process.execPath, [cliPath, '--json', 'create', '-V'], {
        cwd: unrelated,
        env: { SKILL_SYNC_CONFIG_HOME: unusedState },
      });
      expect(jsonVersionWins).toMatchObject({ status: 0, stderr: '' });
      expect(JSON.parse(jsonVersionWins.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        command: 'version',
        data: { version: versionWins.stdout.trim() },
      });

      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 15_000);

  it('prints a preview-ready catalog next action that runs without another missing choice', async () => {
    await withTempDirectory('skill-sync-e2e-catalog-next-', async (root) => {
      const project = join(root, 'project');
      const configHome = join(root, 'config');
      const xdgHome = join(root, 'xdg');
      const gitConfigDirectory = join(xdgHome, 'git');
      const remote = join(root, 'remote.git');
      const skill = join(root, 'hello');
      const remoteUrl = 'https://example.invalid/acme/skills.git';
      await mkdir(project);
      await mkdir(gitConfigDirectory, { recursive: true });
      await mkdir(skill);
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: hello\ndescription: Offline packaged fixture\n---\n\n# Hello\n',
      );

      const initializedRemote = await execute(
        'git',
        ['init', '--bare', '--initial-branch=main', remote],
        { cwd: root },
      );
      expect(initializedRemote.status).toBe(0);
      const configuredRewrite = await execute(
        'git',
        [
          'config',
          '--file',
          join(gitConfigDirectory, 'config'),
          `url.file://${remote}.insteadOf`,
          remoteUrl,
        ],
        { cwd: root },
      );
      expect(configuredRewrite.status).toBe(0);

      const environment = {
        NO_COLOR: '1',
        SKILL_SYNC_CONFIG_HOME: configHome,
        XDG_CONFIG_HOME: xdgHome,
      };
      const initializationPreview = await execute(
        process.execPath,
        [cliPath, '--json', '--no-input', 'init', remoteUrl, '--dry-run'],
        { cwd: project, env: environment },
      );
      expect(initializationPreview).toMatchObject({ status: 0, stderr: '' });
      const initializationPlan = JSON.parse(initializationPreview.stdout) as {
        readonly data: { readonly fingerprint: string };
      };
      expect(initializationPlan.data.fingerprint).toMatch(/^init-v1-[a-f0-9]{64}$/u);
      await expect(stat(configHome)).rejects.toMatchObject({ code: 'ENOENT' });
      const initialized = await execute(
        process.execPath,
        [
          cliPath,
          '--no-input',
          'init',
          remoteUrl,
          '--expect-plan',
          initializationPlan.data.fingerprint,
        ],
        { cwd: project, env: environment },
      );
      expect(initialized).toMatchObject({ status: 0, stderr: '' });
      const added = await execute(
        process.execPath,
        [cliPath, 'add', skill, '--group', 'examples'],
        { cwd: project, env: environment },
      );
      expect(added).toMatchObject({ status: 0, stderr: '' });

      const shown = await execute(process.execPath, [cliPath, '--json', 'show', 'examples/hello'], {
        cwd: project,
        env: environment,
      });
      expect(shown).toMatchObject({ status: 0, stderr: '' });
      expect(JSON.parse(shown.stdout)).toMatchObject({
        command: 'info',
        data: { id: 'examples/hello' },
        ok: true,
        schemaVersion: 1,
      });

      const typoInfo = await execute(
        process.execPath,
        [cliPath, '--json', 'info', 'examples/hellp'],
        { cwd: project, env: environment },
      );
      expect(typoInfo).toMatchObject({ status: 3, stderr: '' });
      expect(JSON.parse(typoInfo.stdout)).toMatchObject({
        command: 'info',
        errors: [
          {
            code: 'SKILL_INFO_FAILED',
            details: {
              report: {
                errors: [
                  {
                    candidates: ['examples/hello'],
                    code: 'unknown-selector',
                    value: 'examples/hellp',
                  },
                ],
              },
            },
          },
        ],
        ok: false,
        schemaVersion: 1,
      });

      const humanTypoInfo = await execute(process.execPath, [cliPath, 'info', 'examples/hellp'], {
        cwd: project,
        env: environment,
      });
      expect(humanTypoInfo).toMatchObject({ status: 3, stdout: '' });
      expect(humanTypoInfo.stderr).toContain('Closest exact ID: examples/hello.');
      expect(humanTypoInfo.stderr).toContain('Next: Run skill-sync info examples/hello.');
      const recoveredInfo = await execute(process.execPath, [cliPath, 'info', 'examples/hello'], {
        cwd: project,
        env: environment,
      });
      expect(recoveredInfo).toMatchObject({ status: 0, stderr: '' });
      expect(recoveredInfo.stdout).toContain('ID: examples/hello');

      const typoInstall = await execute(
        process.execPath,
        [
          cliPath,
          '--json',
          '--no-input',
          '--yes',
          'install',
          'examples/hellp',
          '--target',
          'codex',
          '--gitignore',
        ],
        { cwd: project, env: environment },
      );
      expect(typoInstall).toMatchObject({ status: 3, stderr: '' });
      expect(JSON.parse(typoInstall.stdout)).toMatchObject({
        command: 'install',
        errors: [
          {
            code: 'INVALID_SKILL_SELECTION',
            details: {
              errors: [
                {
                  candidates: ['examples/hello'],
                  code: 'unknown-selector',
                  selector: 'examples/hellp',
                },
              ],
            },
          },
        ],
        ok: false,
        schemaVersion: 1,
      });
      await expect(stat(join(project, 'skill-sync.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(stat(join(project, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(project, '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' });

      const listed = await execute(process.execPath, [cliPath, 'list'], {
        cwd: project,
        env: environment,
      });
      const suggested = 'skill-sync install examples/hello --target codex --gitignore --dry-run';
      expect(listed).toMatchObject({ status: 0, stderr: '' });
      expect(listed.stdout).toContain(`then preview installation with ${suggested}.`);

      const preview = await execute(
        process.execPath,
        [cliPath, ...suggested.slice('skill-sync '.length).split(' ')],
        { cwd: project, env: environment },
      );
      expect(preview).toMatchObject({ status: 0, stderr: '' });
      expect(preview.stdout).toContain('Install preview (no changes made).');
      expect(preview.stdout).not.toContain('MISSING_TARGET_SELECTION');
      expect(preview.stdout).not.toContain('MISSING_GITIGNORE_POLICY');
      const next = preview.stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith('Next: skill-sync install '));
      if (next === undefined) throw new Error('Expected an exact packaged install apply command.');
      expect(next).toMatch(
        /^Next: skill-sync install examples\/hello --target codex --gitignore --expect-plan install-v1-[a-f0-9]{64}$/u,
      );
      const applied = await execute(
        process.execPath,
        [cliPath, ...next.slice('Next: skill-sync '.length).split(' ')],
        { cwd: project, env: environment },
      );
      expect(applied).toMatchObject({ status: 0, stderr: '' });
      expect(applied.stdout).toContain('Install complete.');
      expect(await stat(join(project, '.codex', 'skills', 'hello', 'SKILL.md'))).toBeDefined();
    });
  }, 30_000);

  it('generates deterministic completion safely for every supported shell', async () => {
    await withTempDirectory('skill-sync-e2e-completion-', async (unrelated) => {
      const unusedState = join(unrelated, 'unused-state');
      const environment = { SKILL_SYNC_CONFIG_HOME: unusedState };
      const completionHelp = await execute(process.execPath, [cliPath, 'completion', '--help'], {
        cwd: unrelated,
      });
      expect(completionHelp).toMatchObject({ status: 0, stderr: '' });
      expect(completionHelp.stdout).toContain('--shell <shell>');
      expect(completionHelp.stdout).toContain('--shell: bash, zsh, fish, powershell');
      expect(completionHelp.stdout).toContain(
        'source /dev/stdin <<< "$(skill-sync completion --shell bash)"',
      );
      expect(completionHelp.stdout).toContain('skill-sync completion --shell fish | source');
      expect(completionHelp.stdout).toContain('Invoke-Expression');
      expect(completionHelp.stdout).not.toContain('--project <path>');
      expect(completionHelp.stdout).not.toContain('--global');
      expect(completionHelp.stdout).not.toContain('--no-input:');
      expect(completionHelp.stdout).not.toContain('--yes:');

      const completionPrefixes = {
        bash: '# Bash completion for skill-sync.',
        fish: '# Fish completion for skill-sync.',
        powershell: '# PowerShell completion for skill-sync.',
        zsh: '#compdef skill-sync',
      } as const;
      for (const [shell, prefix] of Object.entries(completionPrefixes)) {
        const completion = await execute(
          process.execPath,
          [cliPath, 'completion', '--shell', shell],
          { cwd: unrelated, env: environment },
        );
        expect(completion).toMatchObject({ status: 0, stderr: '' });
        expect(completion.stdout.startsWith(prefix), shell).toBe(true);
        expect(completion.stdout.endsWith('\n'), shell).toBe(true);
        expect(completion.stdout).toContain('--target');
        expect(completion.stdout).toContain('not-installed');

        const jsonCompletion = await execute(
          process.execPath,
          [cliPath, '--json', 'completion', '--shell', shell],
          { cwd: unrelated, env: environment },
        );
        expect(jsonCompletion).toMatchObject({ status: 0, stderr: '' });
        expect(JSON.parse(jsonCompletion.stdout)).toMatchObject({
          ok: true,
          command: 'completion',
          data: { shell, script: completion.stdout.trimEnd() },
        });
      }
      const repeatedCompletion = await execute(
        process.execPath,
        [cliPath, 'completion', '--shell', 'zsh'],
        { cwd: unrelated, env: environment },
      );
      const firstCompletion = await execute(
        process.execPath,
        [cliPath, 'completion', '--shell', 'zsh'],
        { cwd: unrelated, env: environment },
      );
      expect(repeatedCompletion.stdout).toBe(firstCompletion.stdout);

      const invalidCompletionShell = await execute(
        process.execPath,
        [cliPath, '--json', 'completion', '--shell', 'tcsh'],
        { cwd: unrelated, env: environment },
      );
      expect(invalidCompletionShell).toMatchObject({ status: 2, stderr: '' });
      expect(JSON.parse(invalidCompletionShell.stdout)).toMatchObject({
        ok: false,
        command: 'completion',
        errors: [
          {
            code: 'USAGE_ERROR',
            message:
              "error: option '--shell <shell>' argument 'tcsh' is invalid. Allowed choices are bash, zsh, fish, powershell.",
          },
        ],
      });

      const missingCompletionShell = await execute(
        process.execPath,
        [cliPath, '--json', 'completion'],
        { cwd: unrelated, env: environment },
      );
      expect(missingCompletionShell).toMatchObject({ status: 2, stderr: '' });
      expect(JSON.parse(missingCompletionShell.stdout)).toMatchObject({
        ok: false,
        command: 'completion',
        errors: [
          {
            code: 'USAGE_ERROR',
            message:
              'Pass --shell bash, zsh, fish, or powershell. Example: skill-sync completion --shell zsh.',
          },
        ],
      });

      for (const [arguments_, code] of [
        [['--json', '--global', 'completion', '--shell', 'bash'], 'SCOPE_OPTION_UNSUPPORTED'],
        [
          ['--json', '--project', unrelated, 'completion', '--shell', 'bash'],
          'SCOPE_OPTION_UNSUPPORTED',
        ],
        [['--json', 'completion', '--shell', 'bash', '--yes'], 'OPTION_UNSUPPORTED'],
        [['--json', 'completion', '--shell', 'bash', '--no-input'], 'OPTION_UNSUPPORTED'],
      ] as const) {
        const unsupportedCompletionOption = await execute(
          process.execPath,
          [cliPath, ...arguments_],
          { cwd: unrelated, env: environment },
        );
        expect(unsupportedCompletionOption).toMatchObject({ status: 2, stderr: '' });
        expect(JSON.parse(unsupportedCompletionOption.stdout)).toMatchObject({
          ok: false,
          command: 'completion',
          errors: [{ code }],
        });
      }
      await expect(stat(unusedState)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 15_000);

  it('runs fully specified JSON config and local validation workflows', async () => {
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
        [cliPath, '--json', 'config', 'set', 'defaults.targets', 'codex,claude'],
        { cwd: unrelated, env: environment },
      );
      expect(configured.status).toBe(0);
      expect(JSON.parse(configured.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        command: 'config:set',
        data: { key: 'defaults.targets', value: ['claude', 'codex'] },
      });

      const validated = await execute(process.execPath, [cliPath, '--json', 'validate', skill], {
        cwd: unrelated,
        env: environment,
      });
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
