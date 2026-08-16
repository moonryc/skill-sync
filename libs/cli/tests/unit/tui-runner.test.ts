import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createTuiLauncher,
  DefaultTuiActionPort,
  parseTuiDoctorSummaryResult,
  parseTuiInstallPreviewResult,
  parseTuiLibraryInitPlanResult,
} from '../../src/ui/tui/runner.js';
import type { RuntimeIo } from '../../src/ports/index.js';
import type { CommandInvocation } from '../../src/commands/program.js';
import { EXIT_CODES, failure, success } from '../../src/domain/result.js';
import { withTempDirectory } from '../helpers/temp.js';

function doctorReport(): Readonly<Record<string, unknown>> {
  return {
    checks: [
      { id: 'node', message: 'Node.js is ready.', scope: 'local', status: 'pass' },
      {
        id: 'github-cli',
        message: 'GitHub CLI is unavailable.\u001b[31m',
        remediation: 'Install gh only if you want skill-sync to create a repository.',
        scope: 'local',
        status: 'warning',
      },
      {
        id: 'library-url',
        message: 'No library is configured.',
        remediation: 'Connect an existing repository or create a GitHub library.',
        scope: 'local',
        status: 'fail',
      },
      {
        id: 'library-access',
        message: 'Library access was not checked.',
        remediation: 'Resolve the library URL check first.',
        scope: 'remote',
        status: 'skipped',
      },
    ],
    exitCode: EXIT_CODES.validation,
    offline: false,
    projectRoot: '/workspace',
    scope: 'project',
  };
}

function projectInstallPlan(): Readonly<Record<string, unknown>> {
  return {
    applied: false,
    dryRun: true,
    fingerprint: `install-v1-${'f'.repeat(64)}`,
    freshness: 'cache-only',
    gitignore: {
      after: '# managed\n/.codex/skills/alpha/\n\u001b[31m',
      before: '# managed\n',
      changed: true,
      path: '/workspace/.gitignore',
    },
    libraryRevision: 'a'.repeat(40),
    operation: 'install',
    projectRoot: '/workspace',
    scope: 'project',
    skills: [
      {
        digest: 'd'.repeat(64),
        id: 'writing/zeta',
        projections: [{ destination: '.codex/skills/zeta', target: 'codex', write: false }],
        status: 'already-installed',
      },
      {
        digest: 'b'.repeat(64),
        id: 'frontend/alpha',
        projections: [
          { destination: '.codex/skills/alpha', target: 'codex', write: true },
          { destination: '.claude/skills/alpha', target: 'claude', write: false },
        ],
        status: 'expand-targets',
      },
    ],
    stale: true,
    state: { lockChanged: true, manifestChanged: false },
    writes: ['skill-sync.lock.json', '.codex/skills/alpha', '.gitignore'],
  };
}

function connectInitPlan(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    action: 'connect',
    applied: false,
    branch: 'main',
    configuration: {
      changed: true,
      nextIdentity: 'github.com/acme/skills',
      previousIdentity: null,
    },
    dryRun: true,
    effects: {
      cache: 'refresh',
      configuration: 'write',
      githubRepository: 'none',
      remoteLibrary: 'none',
    },
    fingerprint: `init-v1-${'f'.repeat(64)}`,
    operation: 'init',
    remote: {
      cloneUrl: 'https://github.com/acme/skills.git',
      identity: 'github.com/acme/skills',
      transport: 'https',
    },
    remoteState: 'compatible',
    repository: null,
    revision: 'a'.repeat(40),
    validation: { groups: 1, skills: 3 },
    visibility: null,
    ...overrides,
  };
}

function createInitPlan(): Readonly<Record<string, unknown>> {
  return {
    ...connectInitPlan(),
    action: 'create',
    effects: {
      cache: 'refresh',
      configuration: 'write',
      githubRepository: 'create',
      remoteLibrary: 'initialize',
    },
    fingerprint: `init-v1-${'e'.repeat(64)}`,
    remote: {
      cloneUrl: 'https://github.com/acme/new-skills.git',
      identity: 'github.com/acme/new-skills',
      transport: 'https',
    },
    remoteState: 'available',
    repository: 'acme/new-skills',
    revision: null,
    validation: null,
    visibility: 'private',
  };
}

function nonInteractiveIo(): RuntimeIo {
  return {
    stdinIsTty: false,
    stdoutIsTty: false,
    setExitCode: () => undefined,
    writeStderr: () => undefined,
    writeStdout: () => undefined,
  };
}

describe('TUI launcher', () => {
  it('refuses JSON, no-input, and non-terminal invocations before rendering', async () => {
    const launcher = createTuiLauncher({
      execute: () => Promise.reject(new Error('executor must not run')),
      io: nonInteractiveIo(),
    });

    await expect(
      launcher.launch({ implicit: false, options: { json: true } }),
    ).rejects.toMatchObject({
      code: 'INTERACTIVE_TERMINAL_REQUIRED',
    });
    await expect(launcher.launch({ implicit: false, options: {} })).rejects.toMatchObject({
      code: 'INTERACTIVE_TERMINAL_REQUIRED',
    });
  });

  it('extracts and normalizes structured doctor failure details', () => {
    const result = parseTuiDoctorSummaryResult(
      failure(
        {
          code: 'DOCTOR_LOCAL_FAILURE',
          details: { report: doctorReport() },
          message: 'Doctor found local failures.',
        },
        EXIT_CODES.validation,
      ),
    );

    expect(result).toMatchObject({
      data: {
        counts: { fail: 1, pass: 1, skipped: 1, warning: 1 },
        issues: [
          { id: 'library-url', status: 'fail' },
          { id: 'github-cli', status: 'warning' },
          { id: 'library-access', scope: 'remote', status: 'skipped' },
        ],
        location: '/workspace',
        scope: 'project',
      },
      ok: true,
    });
    expect(result.ok && result.data.issues[1]?.message).not.toContain('\u001b');
  });

  it('rejects malformed doctor data instead of exposing a raw result', () => {
    expect(parseTuiDoctorSummaryResult(success({ checks: 'not-an-array' }))).toMatchObject({
      errors: [{ code: 'INVALID_DOCTOR_REPORT' }],
      ok: false,
    });
  });

  it('runs TUI diagnostics in JSON mode and returns a typed summary', async () => {
    const calls: CommandInvocation[] = [];
    const port = new DefaultTuiActionPort(
      (input) => {
        calls.push(input);
        return Promise.resolve(
          failure(
            {
              code: 'DOCTOR_LOCAL_FAILURE',
              details: { report: doctorReport() },
              message: 'Doctor found local failures.',
            },
            EXIT_CODES.validation,
          ),
        );
      },
      { project: '/workspace' },
    );

    const result = await port.diagnose();
    expect(result).toMatchObject({ data: { counts: { fail: 1 } }, ok: true });
    expect(result.ok && result.data.issues[0]?.id).toBe('library-url');
    expect(calls).toEqual([
      {
        command: 'doctor',
        arguments: [],
        options: {
          color: true,
          json: true,
          noInput: true,
          project: '/workspace',
          yes: false,
        },
      },
    ]);
  });

  it.each([
    ['project', { project: '/workspace' }],
    ['global', { global: true }],
  ] as const)(
    'loads configured target defaults through a scope-free config query for %s dashboards',
    async (scope, options) => {
      await withTempDirectory('skill-sync-tui-config-', async (root) => {
        vi.stubEnv('HOME', root);
        vi.stubEnv('SKILL_SYNC_CONFIG_HOME', join(root, 'config'));
        try {
          const calls: CommandInvocation[] = [];
          const port = new DefaultTuiActionPort((input) => {
            calls.push(input);
            return Promise.resolve(
              input.command === 'config:list'
                ? success({
                    effective: {
                      value: {
                        defaultTargets: ['codex', 'claude'],
                        gitignore: 'manage',
                      },
                    },
                  })
                : input.command === 'group:list'
                  ? success([
                      { description: null, path: 'tools' },
                      { description: 'OpenSpec workflows', path: 'workflows/openspec' },
                    ])
                  : success({ skills: [] }),
            );
          }, options);

          const dashboard = await port.load();
          expect(dashboard.defaultTargets).toEqual(['claude', 'codex']);
          expect(dashboard.groups).toEqual(['tools', 'workflows/openspec']);
          expect(dashboard.manageGitignore).toBe(scope === 'project');
          expect(calls.find((call) => call.command === 'config:list')).toEqual({
            arguments: [],
            command: 'config:list',
            options: { color: true, json: true },
          });
          expect(calls.find((call) => call.command === 'group:list')).toEqual({
            arguments: [],
            command: 'group:list',
            options: { color: true, json: true, noInput: true, yes: false },
          });
        } finally {
          vi.unstubAllEnvs();
        }
      });
    },
  );

  it('rejects a partially valid configured target list instead of silently filtering it', async () => {
    const port = new DefaultTuiActionPort(
      (input) =>
        Promise.resolve(
          input.command === 'config:list'
            ? success({
                effective: {
                  value: { defaultTargets: ['claude', 'unsupported'], gitignore: 'leave' },
                },
              })
            : success({ skills: [] }),
        ),
      { project: '/workspace' },
    );

    await expect(port.load()).resolves.toMatchObject({ defaultTargets: [] });
  });

  it('normalizes a complete init dry-run into a typed setup plan', () => {
    const result = parseTuiLibraryInitPlanResult(success(connectInitPlan()));

    expect(result).toMatchObject({
      data: {
        action: 'connect',
        configurationChanged: true,
        effects: {
          configuration: 'write',
          githubRepository: 'none',
          remoteLibrary: 'none',
        },
        fingerprint: `init-v1-${'f'.repeat(64)}`,
        remote: { identity: 'github.com/acme/skills', transport: 'https' },
        remoteState: 'compatible',
        validation: { groups: 1, skills: 3 },
      },
      ok: true,
    });
  });

  it('rejects malformed or internally inconsistent init previews', () => {
    expect(
      parseTuiLibraryInitPlanResult(success(connectInitPlan({ fingerprint: 'local-json' }))),
    ).toMatchObject({ errors: [{ code: 'INVALID_INIT_PREVIEW' }], ok: false });
    expect(
      parseTuiLibraryInitPlanResult(
        success(
          connectInitPlan({
            effects: {
              cache: 'refresh',
              configuration: 'write',
              githubRepository: 'create',
              remoteLibrary: 'none',
            },
          }),
        ),
      ),
    ).toMatchObject({ errors: [{ code: 'INVALID_INIT_PREVIEW' }], ok: false });
  });

  it('normalizes a complete project install preview without losing exact review data', () => {
    const result = parseTuiInstallPreviewResult(success(projectInstallPlan()));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a valid preview.');
    expect(result.data.skills.map((skill) => skill.id)).toEqual(['frontend/alpha', 'writing/zeta']);
    expect(result.data.fingerprint).toBe(`install-v1-${'f'.repeat(64)}`);
    expect(result.data.skills[0]?.projections.map((projection) => projection.target)).toEqual([
      'claude',
      'codex',
    ]);
    expect(result.data.writes).toEqual([
      '.codex/skills/alpha',
      '.gitignore',
      'skill-sync.lock.json',
    ]);
    expect(result.data.gitignore).toMatchObject({
      after: '# managed\n/.codex/skills/alpha/\n\u001b[31m',
      applicable: true,
      before: '# managed\n',
      changed: true,
    });
  });

  it('rejects an incomplete or internally inconsistent install preview', () => {
    const malformed = projectInstallPlan();
    const result = parseTuiInstallPreviewResult(
      success({
        ...malformed,
        gitignore: {
          after: 'changed',
          before: 'original',
          changed: false,
          path: '/workspace/.gitignore',
        },
      }),
    );

    expect(result).toMatchObject({
      errors: [{ code: 'INVALID_INSTALL_PREVIEW' }],
      ok: false,
    });
  });

  it('rejects an install preview with a malformed server fingerprint', () => {
    expect(
      parseTuiInstallPreviewResult(success({ ...projectInstallPlan(), fingerprint: 'local-json' })),
    ).toMatchObject({ errors: [{ code: 'INVALID_INSTALL_PREVIEW' }], ok: false });
  });

  it('routes install previews through the existing dry-run command contract', async () => {
    const calls: CommandInvocation[] = [];
    const port = new DefaultTuiActionPort(
      (input) => {
        calls.push(input);
        return Promise.resolve(success(projectInstallPlan()));
      },
      { project: '/workspace' },
    );

    await expect(
      port.previewInstall(['frontend/alpha'], ['codex', 'claude'], true),
    ).resolves.toMatchObject({ ok: true, data: { scope: 'project' } });
    expect(calls).toEqual([
      {
        command: 'install',
        arguments: [['frontend/alpha']],
        options: {
          color: true,
          dryRun: true,
          gitignore: true,
          json: true,
          noInput: true,
          project: '/workspace',
          target: ['codex', 'claude'],
          yes: true,
        },
      },
    ]);
  });

  it.each([
    ['project', { project: '/workspace' }],
    ['global', { global: true }],
  ] as const)(
    'keeps %s dashboard scope out of typed user-wide setup preview and apply commands',
    async (_scope, options) => {
      const calls: CommandInvocation[] = [];
      const port = new DefaultTuiActionPort((input) => {
        calls.push(input);
        return Promise.resolve(
          input.options.dryRun === true
            ? success(input.options.create === undefined ? connectInitPlan() : createInitPlan())
            : success({ applied: true }),
        );
      }, options);

      await expect(
        port.previewLibrarySetup({
          kind: 'connect',
          value: 'https://github.com/acme/skills.git',
        }),
      ).resolves.toMatchObject({ ok: true, data: { action: 'connect' } });
      await port.applyLibrarySetup(
        { kind: 'connect', value: 'https://github.com/acme/skills.git' },
        `init-v1-${'f'.repeat(64)}`,
      );
      await expect(
        port.previewLibrarySetup({ kind: 'create', value: 'acme/new-skills' }),
      ).resolves.toMatchObject({ ok: true, data: { action: 'create' } });
      await port.applyLibrarySetup(
        { kind: 'create', value: 'acme/new-skills' },
        `init-v1-${'e'.repeat(64)}`,
      );

      expect(calls.map((call) => call.options)).toEqual([
        { color: true, dryRun: true, json: true, noInput: true, yes: false },
        {
          color: true,
          expectPlan: `init-v1-${'f'.repeat(64)}`,
          json: true,
          noInput: true,
          yes: true,
        },
        {
          color: true,
          create: 'acme/new-skills',
          dryRun: true,
          json: true,
          noInput: true,
          yes: false,
        },
        {
          color: true,
          create: 'acme/new-skills',
          expectPlan: `init-v1-${'e'.repeat(64)}`,
          json: true,
          noInput: true,
          yes: true,
        },
      ]);
      expect(calls.map((call) => call.arguments)).toEqual([
        ['https://github.com/acme/skills.git'],
        ['https://github.com/acme/skills.git'],
        [],
        [],
      ]);
    },
  );

  it('applies a reviewed server plan through the expected-plan precondition', async () => {
    const calls: CommandInvocation[] = [];
    const port = new DefaultTuiActionPort(
      (input) => {
        calls.push(input);
        return Promise.resolve(success({ applied: true }));
      },
      { project: '/workspace' },
    );

    await port.install(['frontend/alpha'], ['codex'], true, `install-v1-${'f'.repeat(64)}`);
    await port.applyLibrarySetup(
      { kind: 'connect', value: 'https://github.com/acme/skills.git' },
      `init-v1-${'e'.repeat(64)}`,
    );

    expect(calls[0]?.options).toMatchObject({
      expectPlan: `install-v1-${'f'.repeat(64)}`,
      gitignore: true,
      target: ['codex'],
    });
    expect(calls[1]).toMatchObject({
      command: 'init',
      arguments: ['https://github.com/acme/skills.git'],
      options: { expectPlan: `init-v1-${'e'.repeat(64)}`, yes: true },
    });
  });
});
