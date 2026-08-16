import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { globalMutationStorage } from '../../src/application/managed-scope.js';
import { projectMutationStorage } from '../../src/application/project-storage.js';
import { createDefaultCommandExecutor } from '../../src/commands/default-executor.js';
import { EXIT_CODES } from '../../src/domain/result.js';
import { resolveApplicationPaths } from '../../src/infrastructure/config.js';
import {
  acquireAdvisoryLock,
  createOperationJournal,
  createOperationJournalV2,
  deterministicOperationPaths,
  transactionContentDigest,
  transactionRootFingerprint,
  updateOperationJournalV2,
} from '../../src/infrastructure/transactions.js';
import type { RuntimeIo } from '../../src/ports/index.js';
import { withTempDirectory } from '../helpers/temp.js';

function memoryIo(): RuntimeIo {
  return {
    stdinIsTty: false,
    stdoutIsTty: false,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    setExitCode: () => undefined,
  };
}

describe('default command executor dispatch', () => {
  it('previews abandoned-lock recovery by default and removes one proven lock with --yes', async () => {
    await withTempDirectory('skill-sync-recovery-unlock-dispatch-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const lockPath = join(paths.locksDirectory, 'user-configuration.lock');
      await acquireAdvisoryLock(lockPath, {
        hostname: 'local-test-host',
        operationId: 'abandoned-setup',
        pid: 424_242,
        scope: { id: 'user-configuration', kind: 'global' },
      });
      const activeExecutor = createDefaultCommandExecutor(memoryIo(), {
        environment,
        paths,
        recoveryUnlock: {
          currentHostname: 'local-test-host',
          processState: () => 'active',
        },
      });
      const listed = await activeExecutor({
        command: 'recovery:list',
        arguments: [],
        options: { json: true },
      });
      if (!listed.ok) throw new Error('Expected recovery list success.');
      const listedData = listed.data as {
        readonly records: readonly { readonly id: string; readonly kind: string }[];
      };
      const id = listedData.records.find((record) => record.kind === 'lock')?.id;
      if (id === undefined) throw new Error('Expected lock recovery record.');
      const inspected = await activeExecutor({
        command: 'recovery:inspect',
        arguments: [id],
        options: { json: true },
      });
      expect(JSON.stringify(inspected)).not.toContain('ownerToken');
      await expect(
        activeExecutor({
          command: 'recovery:unlock',
          arguments: [id],
          options: { dryRun: true, json: true },
        }),
      ).resolves.toMatchObject({
        errors: [{ code: 'RECOVERY_UNLOCK_REFUSED' }],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });
      expect(await readFile(lockPath, 'utf8')).toContain('abandoned-setup');

      const execute = createDefaultCommandExecutor(memoryIo(), {
        environment,
        paths,
        recoveryUnlock: {
          currentHostname: 'local-test-host',
          minimumAgeMs: 0,
          processState: () => 'absent',
        },
      });
      const preview = await execute({
        command: 'recovery:unlock',
        arguments: [id],
        options: { json: true },
      });
      expect(preview).toMatchObject({
        data: {
          applied: false,
          id,
          path: lockPath,
          status: 'abandoned',
        },
        exitCode: EXIT_CODES.success,
        ok: true,
      });
      expect(JSON.stringify(preview)).not.toContain('ownerToken');
      expect(await readFile(lockPath, 'utf8')).toContain('abandoned-setup');

      await expect(
        execute({
          command: 'recovery:unlock',
          arguments: [id],
          options: { json: true, noInput: true, yes: true },
        }),
      ).resolves.toMatchObject({
        data: { applied: true, id, path: lockPath, status: 'abandoned' },
        exitCode: EXIT_CODES.success,
        ok: true,
      });
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        execute({ command: 'recovery:list', arguments: [], options: { json: true } }),
      ).resolves.toMatchObject({ data: { records: [] }, ok: true });
    });
  });

  it('coordinates setup and config mutations with one crash-visible user lock', async () => {
    await withTempDirectory('skill-sync-user-config-lock-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const execute = createDefaultCommandExecutor(memoryIo(), { environment, paths });
      const lockPath = join(paths.locksDirectory, 'user-configuration.lock');
      const competing = await acquireAdvisoryLock(lockPath, {
        operationId: 'other-setup-command',
        scope: { id: 'user-configuration', kind: 'global' },
      });
      try {
        const blocked = await execute({
          command: 'config:set',
          arguments: ['defaults.gitignore', 'leave'],
          options: { json: true },
        });
        expect(blocked).toMatchObject({
          errors: [
            {
              code: 'ADVISORY_LOCK_UNAVAILABLE',
              details: { lockPath },
            },
          ],
          exitCode: EXIT_CODES.conflict,
          ok: false,
        });
        expect(blocked.ok ? '' : blocked.errors[0]?.message).toContain(
          'active setup or config command',
        );

        const previewWithoutInput = await execute({
          command: 'init',
          arguments: [],
          options: { dryRun: true, noInput: true },
        });
        expect(previewWithoutInput).toMatchObject({
          errors: [{ code: 'MISSING_INPUT' }],
          exitCode: EXIT_CODES.usage,
          ok: false,
        });
        const implicitPreviewWithoutInput = await execute({
          command: 'init',
          arguments: [],
          options: { noInput: true },
        });
        expect(implicitPreviewWithoutInput).toMatchObject({
          errors: [{ code: 'MISSING_INPUT' }],
          exitCode: EXIT_CODES.usage,
          ok: false,
        });
      } finally {
        await competing.release();
      }

      await expect(
        execute({
          command: 'config:set',
          arguments: ['defaults.gitignore', 'leave'],
          options: { json: true },
        }),
      ).resolves.toMatchObject({ data: { key: 'defaults.gitignore', value: 'leave' }, ok: true });
      await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('constructs persistent cache refreshes with an identity-scoped filesystem lock', async () => {
    await withTempDirectory('skill-sync-cache-lock-dispatch-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const identity = 'github.com/acme/skills';
      const remote = 'https://github.com/acme/skills.git';
      const key = createHash('sha256').update(identity).digest('hex');
      const lockPath = join(paths.locksDirectory, `cache-${key}.lock`);
      await mkdir(paths.configDirectory, { recursive: true });
      await writeFile(
        paths.configFile,
        `${JSON.stringify({
          library: { branch: 'main', identity, remote, transport: 'https' },
          schemaVersion: 1,
        })}\n`,
      );
      const competing = await acquireAdvisoryLock(lockPath, {
        operationId: 'other-cache-refresh',
        scope: { id: key, kind: 'library' },
      });
      const execute = createDefaultCommandExecutor(memoryIo(), { environment, paths });

      try {
        await expect(
          execute({ command: 'list', arguments: [], options: { json: true } }),
        ).resolves.toMatchObject({
          errors: [
            {
              code: 'ADVISORY_LOCK_UNAVAILABLE',
              details: { lockPath },
            },
          ],
          exitCode: EXIT_CODES.conflict,
          ok: false,
        });
        await expect(stat(paths.cacheDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await competing.release();
      }
    });
  });

  it('routes system and workflow commands and preserves expected unknown-command status', async () => {
    await withTempDirectory('skill-sync-default-executor-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const execute = createDefaultCommandExecutor(memoryIo(), {
        environment,
        paths,
        releaseManagement: {
          availableUpdate: () =>
            Promise.resolve({ availableVersion: '0.2.0', installedVersion: '0.1.0' }),
          selfUpdate: () =>
            Promise.resolve({ packageName: '@moonryc/skill-sync', requestedVersion: 'latest' }),
        },
      });

      await expect(
        execute({ command: 'config:path', arguments: [], options: { json: true } }),
      ).resolves.toEqual({ ok: true, data: { path: paths.configFile }, exitCode: 0 });

      const skill = join(root, 'hello');
      await mkdir(skill);
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: hello\ndescription: Local fixture\n---\n\n# Hello\n',
      );
      await expect(
        execute({ command: 'validate', arguments: [skill], options: { json: true } }),
      ).resolves.toMatchObject({
        data: { kind: 'local-path', valid: true },
        exitCode: EXIT_CODES.success,
        ok: true,
      });

      await expect(
        execute({ command: 'not-a-command', arguments: [], options: {} }),
      ).resolves.toMatchObject({
        errors: [{ code: 'UNKNOWN_COMMAND' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });

      await expect(
        execute({ command: 'release:check', arguments: [], options: { json: true } }),
      ).resolves.toEqual({
        data: { availableVersion: '0.2.0', installedVersion: '0.1.0' },
        exitCode: EXIT_CODES.success,
        ok: true,
      });

      await expect(
        execute({ command: 'self-update', arguments: [], options: {} }),
      ).resolves.toEqual({
        data: 'CLI update completed for @moonryc/skill-sync@latest.',
        exitCode: EXIT_CODES.success,
        ok: true,
      });
    });
  });

  it('blocks real mutations on unresolved recovery evidence before workflow access', async () => {
    await withTempDirectory('skill-sync-recovery-gate-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const project = join(root, 'project');
      await mkdir(project);
      const projectRoot = await realpath(project);
      const storage = projectMutationStorage(paths, projectRoot);
      const journal = await createOperationJournal(storage.journalDirectory, {
        kind: 'install',
        operationId: 'interrupted-install',
      });
      const journalBefore = await readFile(journal.path, 'utf8');
      const execute = createDefaultCommandExecutor(memoryIo(), {
        environment,
        paths,
        releaseManagement: {
          availableUpdate: () => Promise.reject(new Error('registry must not be reached')),
          selfUpdate: () => Promise.reject(new Error('updater must not be reached')),
        },
      });

      await expect(
        execute({
          command: 'install',
          arguments: ['frontend/example'],
          options: { global: false, project: projectRoot, yes: true },
        }),
      ).resolves.toMatchObject({
        errors: [
          {
            code: 'RECOVERY_REQUIRED',
            details: {
              command: 'install',
              inspectCommand: 'skill-sync recovery inspect <id>',
              recoveryCommand: 'skill-sync recovery list',
            },
          },
        ],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });

      const preview = await execute({
        command: 'install',
        arguments: ['frontend/example'],
        options: { dryRun: true, global: false, noInput: true, project: projectRoot },
      });
      expect(preview.ok ? undefined : preview.errors[0]?.code).not.toBe('RECOVERY_REQUIRED');

      await expect(
        execute({ command: 'config:path', arguments: [], options: { json: true } }),
      ).resolves.toEqual({ ok: true, data: { path: paths.configFile }, exitCode: 0 });

      const listed = await execute({
        command: 'recovery:list',
        arguments: [],
        options: { json: true },
      });
      expect(listed).toMatchObject({
        data: {
          records: [
            {
              inspectOnly: true,
              kind: 'journal',
              operationId: 'interrupted-install',
            },
          ],
        },
        ok: true,
      });
      if (!listed.ok) throw new Error('Expected recovery list success.');
      const data = listed.data as { readonly records: readonly { readonly id: string }[] };
      const id = data.records[0]?.id;
      if (id === undefined) throw new Error('Expected recovery record ID.');
      await expect(
        execute({ command: 'recovery:inspect', arguments: [id], options: { json: true } }),
      ).resolves.toMatchObject({
        data: {
          record: { id, kind: 'journal', status: 'preparing' },
        },
        ok: true,
      });
      expect(await readFile(journal.path, 'utf8')).toBe(journalBefore);
    });
  });

  it('isolates recovery gates by project and global managed scope', async () => {
    await withTempDirectory('skill-sync-recovery-scope-gate-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const projectA = join(root, 'project-a');
      const projectB = join(root, 'project-b');
      await mkdir(projectA);
      await mkdir(projectB);
      const projectARoot = await realpath(projectA);
      const projectBRoot = await realpath(projectB);
      await createOperationJournal(projectMutationStorage(paths, projectARoot).journalDirectory, {
        kind: 'install',
        operationId: 'interrupted-project-a-install',
      });
      const execute = createDefaultCommandExecutor(memoryIo(), { environment, paths });

      const projectBResult = await execute({
        command: 'install',
        arguments: ['frontend/example'],
        options: { project: projectBRoot },
      });
      expect(projectBResult).toMatchObject({
        errors: [{ code: 'LIBRARY_NOT_CONFIGURED' }],
        ok: false,
      });

      const projectBPublish = await execute({
        command: 'publish',
        arguments: ['frontend/example'],
        options: { project: projectBRoot },
      });
      expect(projectBPublish).toMatchObject({
        errors: [{ code: 'LIBRARY_NOT_CONFIGURED' }],
        ok: false,
      });

      await expect(
        execute({
          command: 'install',
          arguments: ['frontend/example'],
          options: { project: projectARoot, yes: true },
        }),
      ).resolves.toMatchObject({
        errors: [{ code: 'RECOVERY_REQUIRED' }],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });

      await expect(
        execute({
          command: 'publish',
          arguments: ['frontend/example'],
          options: { project: projectARoot },
        }),
      ).resolves.toMatchObject({
        errors: [{ code: 'RECOVERY_REQUIRED' }],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });

      const publishPreview = await execute({
        command: 'publish',
        arguments: ['frontend/example'],
        options: { dryRun: true, project: projectARoot },
      });
      expect(publishPreview.ok ? undefined : publishPreview.errors[0]?.code).not.toBe(
        'RECOVERY_REQUIRED',
      );

      const globalResult = await execute({
        command: 'install',
        arguments: ['frontend/example'],
        options: { global: true },
      });
      expect(globalResult.ok ? undefined : globalResult.errors[0]?.code).not.toBe(
        'RECOVERY_REQUIRED',
      );

      await createOperationJournal(globalMutationStorage(paths).journalDirectory, {
        kind: 'global-install',
        operationId: 'interrupted-global-install',
      });

      await expect(
        execute({
          command: 'install',
          arguments: ['frontend/example'],
          options: { global: true, yes: true },
        }),
      ).resolves.toMatchObject({
        errors: [{ code: 'RECOVERY_REQUIRED' }],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });

      await expect(
        execute({
          command: 'config:set',
          arguments: ['defaults.gitignore', 'leave'],
          options: { json: true },
        }),
      ).resolves.toMatchObject({ data: { key: 'defaults.gitignore', value: 'leave' }, ok: true });

      const initResult = await execute({
        command: 'init',
        arguments: [],
        options: { noInput: true },
      });
      expect(initResult.ok ? undefined : initResult.errors[0]?.code).not.toBe('RECOVERY_REQUIRED');
    });
  });

  it('keeps legacy unscoped recovery evidence shared across managed scopes', async () => {
    await withTempDirectory('skill-sync-recovery-shared-gate-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const project = join(root, 'project');
      await mkdir(project);
      await createOperationJournal(paths.journalsDirectory, {
        kind: 'install',
        operationId: 'legacy-unscoped-install',
      });
      const execute = createDefaultCommandExecutor(memoryIo(), { environment, paths });

      for (const options of [
        { project, yes: true },
        { global: true, yes: true },
      ]) {
        await expect(
          execute({ command: 'install', arguments: ['frontend/example'], options }),
        ).resolves.toMatchObject({
          errors: [{ code: 'RECOVERY_REQUIRED' }],
          exitCode: EXIT_CODES.conflict,
          ok: false,
        });
      }
    });
  });

  it('previews, confirms, resumes, and idempotently rechecks a v2 recovery journal', async () => {
    await withTempDirectory('skill-sync-recovery-resume-command-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const project = join(root, 'project');
      const projectLink = join(root, 'project-link');
      const destinationRelative = '.codex/skills/example';
      const destination = join(project, ...destinationRelative.split('/'));
      const artifacts = deterministicOperationPaths(destinationRelative, 'resume-command', 0);
      const candidate = join(project, ...artifacts.candidate.split('/'));
      await mkdir(destination, { recursive: true });
      await mkdir(candidate, { recursive: true });
      const canonicalProjectRoot = await realpath(project);
      await symlink(project, projectLink, 'dir');
      await writeFile(join(destination, 'SKILL.md'), 'old');
      await writeFile(join(candidate, 'SKILL.md'), 'new');
      const originalDigest = await transactionContentDigest(destination);
      const finalDigest = await transactionContentDigest(candidate);
      const journal = await createOperationJournalV2(join(paths.journalsDirectory, 'project-key'), {
        entries: [
          {
            action: 'replace',
            candidate: artifacts.candidate,
            destination: destinationRelative,
            finalDigest,
            originalDigest,
            rollback: artifacts.rollback,
            sourceDigest: finalDigest,
            state: 'pending',
          },
        ],
        kind: 'install',
        operationId: 'resume-command',
        rootFingerprint: transactionRootFingerprint(canonicalProjectRoot),
        scope: { id: 'project-command', kind: 'project' },
      });
      const entry = journal.value.entries[0];
      if (entry === undefined) throw new Error('Expected journal entry.');
      await updateOperationJournalV2(journal.path, {
        entries: [{ ...entry, state: 'prepared' }],
        status: 'prepared',
      });
      const execute = createDefaultCommandExecutor(memoryIo(), { environment, paths });
      const listed = await execute({
        command: 'recovery:list',
        arguments: [],
        options: { json: true, scope: 'project-command' },
      });
      if (!listed.ok) throw new Error('Expected recovery list success.');
      const listedData = listed.data as {
        readonly records: readonly { readonly id: string; readonly kind: string }[];
      };
      const id = listedData.records.find((record) => record.kind === 'journal')?.id;
      if (id === undefined) throw new Error('Expected journal recovery ID.');
      expect(listed).toEqual({
        data: {
          records: [
            {
              id,
              inspectOnly: false,
              kind: 'journal',
              operationId: 'resume-command',
              operationKind: 'install',
              path: journal.path,
              scope: 'project:project-command',
              scopeKind: 'project',
              status: 'prepared',
            },
          ],
        },
        exitCode: EXIT_CODES.success,
        ok: true,
      });
      await expect(
        execute({
          command: 'recovery:list',
          arguments: [],
          options: { scope: 'project-command' },
        }),
      ).resolves.toEqual({
        data: [
          'Recovery records (1) for scope filter project-command:',
          `  ${id}`,
          '    Type: journal | Status: prepared | Scope: project:project-command | Mode: recoverable',
          'Read-only: no changes made.',
          `Next: Run skill-sync recovery inspect ${id}.`,
        ].join('\n'),
        exitCode: EXIT_CODES.success,
        ok: true,
      });

      const jsonPreview = await execute({
        command: 'recovery:resume',
        arguments: [id],
        options: { dryRun: true, json: true, project },
      });
      if (!jsonPreview.ok) throw new Error('Expected recovery resume preview success.');
      const jsonPreviewData = jsonPreview.data as { readonly fingerprint: unknown };
      expect(typeof jsonPreviewData.fingerprint).toBe('string');
      if (typeof jsonPreviewData.fingerprint !== 'string') {
        throw new Error('Expected a recovery resume plan fingerprint.');
      }
      expect(jsonPreview).toEqual({
        data: {
          applied: false,
          entries: [
            {
              actions: ['move-original', 'commit-candidate'],
              destination: await realpath(destination),
              index: 0,
            },
          ],
          fingerprint: jsonPreviewData.fingerprint,
          id,
          operationId: 'resume-command',
          root: canonicalProjectRoot,
          status: 'prepared',
        },
        exitCode: EXIT_CODES.success,
        ok: true,
      });
      await expect(
        execute({
          command: 'recovery:resume',
          arguments: [id],
          options: { dryRun: true, project },
        }),
      ).resolves.toEqual({
        data: [
          'Recovery resume preview (no changes made).',
          `Scope: project (${canonicalProjectRoot})`,
          `Record: ${id}`,
          'Operation: resume-command',
          'Current state: prepared',
          'Affected destinations (1):',
          `  ${await realpath(destination)}: move the current destination to rollback storage; install the prepared replacement`,
          `Plan fingerprint: ${jsonPreviewData.fingerprint}`,
          `Next: Apply this preview with skill-sync --project <affected-project> recovery resume ${id} --yes.`,
        ].join('\n'),
        exitCode: EXIT_CODES.success,
        ok: true,
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old');

      await expect(
        execute({
          command: 'recovery:resume',
          arguments: [id],
          options: { noInput: true, project },
        }),
      ).resolves.toMatchObject({
        errors: [{ code: 'RECOVERY_CONFIRMATION_REQUIRED' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });

      const competingLock = await acquireAdvisoryLock(
        projectMutationStorage(paths, canonicalProjectRoot).lockPath,
        { operationId: 'existing-project-operation' },
      );
      try {
        await expect(
          execute({
            command: 'recovery:resume',
            arguments: [id],
            options: { json: true, noInput: true, project: projectLink, yes: true },
          }),
        ).resolves.toMatchObject({
          errors: [{ code: 'ADVISORY_LOCK_UNAVAILABLE' }],
          exitCode: EXIT_CODES.conflict,
          ok: false,
        });
        expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('old');
      } finally {
        await competingLock.release();
      }

      await expect(
        execute({
          command: 'recovery:resume',
          arguments: [id],
          options: { json: true, noInput: true, project, yes: true },
        }),
      ).resolves.toMatchObject({
        data: { applied: true, id, status: 'committed' },
        ok: true,
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');

      await expect(
        execute({
          command: 'recovery:resume',
          arguments: [id],
          options: { json: true, noInput: true, project, yes: true },
        }),
      ).resolves.toMatchObject({
        data: { applied: false, id, status: 'committed' },
        ok: true,
      });
    });
  });
});
