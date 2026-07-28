import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { ConfigService, type ConfigurationListing } from '../../src/application/config-service.js';
import type { DoctorReport, DoctorRequest } from '../../src/application/doctor.js';
import {
  createConfigDoctorCommandHandler,
  type ConfigCommandService,
  type ExtensibleCommandInvocation,
} from '../../src/commands/config-doctor-handler.js';
import type { CommandResult } from '../../src/domain/result.js';
import { resolveApplicationPaths } from '../../src/infrastructure/config.js';
import type { RuntimeIo } from '../../src/ports/index.js';
import { renderResult } from '../../src/ui/output.js';
import { withTempDirectory } from '../helpers/temp.js';

const BASE_LISTING: ConfigurationListing = {
  path: '/config/config.json',
  configured: {
    'library.remote': undefined,
    'library.branch': 'stable',
    'library.transport': undefined,
    'defaults.targets': ['claude', 'codex'],
    'defaults.gitignore': undefined,
  },
  effective: {
    value: {
      branch: 'stable',
      defaultTargets: ['claude', 'codex'],
      gitignore: 'leave',
      transport: 'https',
    },
    sources: {
      branch: 'user',
      defaultTargets: 'user',
      gitignore: 'default',
      libraryUrl: 'default',
      transport: 'default',
    },
  },
};

function invocation(
  command: string,
  arguments_: readonly unknown[] = [],
  options: Readonly<Record<string, unknown>> = {},
): ExtensibleCommandInvocation {
  return { command, arguments: arguments_, options };
}

async function requiredResult(
  handler: ReturnType<typeof createConfigDoctorCommandHandler>,
  request: ExtensibleCommandInvocation,
): Promise<CommandResult<unknown>> {
  const result = await handler(request);
  if (result === undefined) throw new Error(`Expected ${request.command} to be handled.`);
  return result;
}

function memoryIo(): {
  readonly io: RuntimeIo;
  readonly state: { stdout: string; stderr: string; exitCode: number };
} {
  const state = { stdout: '', stderr: '', exitCode: -1 };
  return {
    state,
    io: {
      stdinIsTty: false,
      stdoutIsTty: false,
      writeStdout: (value) => {
        state.stdout += value;
      },
      writeStderr: (value) => {
        state.stderr += value;
      },
      setExitCode: (code) => {
        state.exitCode = code;
      },
    },
  };
}

function fakeConfig(overrides: Partial<ConfigCommandService> = {}): ConfigCommandService {
  const values = new Map<string, string | readonly string[]>([
    ['library.branch', 'stable'],
    ['defaults.targets', ['claude', 'codex']],
  ]);
  return {
    path: () => '/config/config.json',
    list: () => Promise.resolve(BASE_LISTING),
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve(undefined);
    },
    unset: (key) => {
      values.delete(key);
      return Promise.resolve(undefined);
    },
    ...overrides,
  };
}

function doctorReport(checks: DoctorReport['checks'], offline = false): DoctorReport {
  return { checks, exitCode: 0, offline, projectRoot: '/project' };
}

describe('composable config and doctor command handler', () => {
  it('returns undefined for unrelated commands without calling dependencies', async () => {
    let calls = 0;
    const handler = createConfigDoctorCommandHandler({
      config: fakeConfig({
        list: () => {
          calls += 1;
          return Promise.resolve(BASE_LISTING);
        },
      }),
      runDoctor: () => {
        calls += 1;
        return Promise.resolve(doctorReport([]));
      },
    });
    await expect(handler(invocation('list'))).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it('returns mode-appropriate path, list, and get data', async () => {
    const handler = createConfigDoctorCommandHandler({ config: fakeConfig() });

    await expect(requiredResult(handler, invocation('config:path'))).resolves.toEqual({
      ok: true,
      data: '/config/config.json',
      exitCode: 0,
    });
    await expect(
      requiredResult(handler, invocation('config:path', [], { json: true })),
    ).resolves.toMatchObject({ ok: true, data: { path: '/config/config.json' } });

    const humanList = await requiredResult(handler, invocation('config:list'));
    expect(humanList).toMatchObject({ ok: true });
    if (humanList.ok) {
      expect(humanList.data).toContain('Configuration: /config/config.json');
      expect(humanList.data).toContain('library.branch = stable (user)');
      expect(humanList.data).toContain('defaults.gitignore = <unset>');
    }

    const jsonList = await requiredResult(handler, invocation('config:list', [], { json: true }));
    expect(jsonList).toMatchObject({
      ok: true,
      data: {
        configured: {
          'library.remote': null,
          'library.branch': 'stable',
          'defaults.targets': ['claude', 'codex'],
        },
      },
    });

    await expect(
      requiredResult(handler, invocation('config:get', ['defaults.targets'])),
    ).resolves.toMatchObject({ ok: true, data: 'claude, codex' });
    await expect(
      requiredResult(handler, invocation('config:get', ['library.remote'], { json: true })),
    ).resolves.toMatchObject({
      ok: true,
      data: { key: 'library.remote', configured: false, value: null },
    });
  });

  it('sets and unsets values through the injected service', async () => {
    const config = fakeConfig();
    const handler = createConfigDoctorCommandHandler({ config });
    await expect(
      requiredResult(
        handler,
        invocation('config:set', ['defaults.gitignore', 'manage'], { json: true }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      data: { key: 'defaults.gitignore', value: 'manage' },
    });
    await expect(
      requiredResult(handler, invocation('config:unset', ['defaults.gitignore'])),
    ).resolves.toMatchObject({ ok: true, data: 'Unset defaults.gitignore.' });
    await expect(config.get('defaults.gitignore')).resolves.toBeUndefined();
  });

  it('maps plain config validation errors to redacted status 3 failures', async () => {
    const handler = createConfigDoctorCommandHandler({
      config: fakeConfig({
        set: () => {
          throw new Error('Unsupported value token=github_pat_abcdefghijklmnopqrstuvwxyz');
        },
      }),
    });
    const result = await requiredResult(
      handler,
      invocation('config:set', ['defaults.targets', 'cursor']),
    );
    expect(result).toMatchObject({
      ok: false,
      exitCode: 3,
      errors: [{ code: 'CONFIG_VALIDATION_FAILED' }],
    });
    expect(JSON.stringify(result)).not.toContain('github_pat_');
  });

  it('uses usage status for missing handler arguments', async () => {
    const handler = createConfigDoctorCommandHandler({ config: fakeConfig() });
    await expect(
      requiredResult(handler, invocation('config:set', ['library.branch'])),
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 2,
      errors: [{ code: 'MISSING_ARGUMENT' }],
    });
  });

  it('works with the real atomic ConfigService and preserves invalid prior bytes', async () => {
    await withTempDirectory('skill-sync-config-command-', async (root) => {
      const environment = { SKILL_SYNC_CONFIG_HOME: root };
      const service = new ConfigService(
        environment,
        resolveApplicationPaths({ cwd: root, env: environment }),
      );
      const handler = createConfigDoctorCommandHandler({ config: service });
      await requiredResult(handler, invocation('config:set', ['defaults.gitignore', 'manage']));
      const before = await readFile(service.path(), 'utf8');
      const invalid = await requiredResult(
        handler,
        invocation('config:set', ['defaults.gitignore', 'invalid']),
      );
      expect(invalid).toMatchObject({ ok: false, exitCode: 3 });
      expect(await readFile(service.path(), 'utf8')).toBe(before);
    });
  });

  it('returns every doctor check and gives local failures precedence over remote failures', async () => {
    let receivedRequest: DoctorRequest | undefined;
    const report = doctorReport([
      {
        id: 'project-state',
        status: 'fail',
        scope: 'local',
        message: 'invalid project token=local-secret',
        remediation: 'repair local state',
      },
      {
        id: 'library-access',
        status: 'fail',
        scope: 'remote',
        message: 'access denied password=remote-secret',
        remediation: 'authenticate',
      },
      { id: 'git', status: 'pass', scope: 'local', message: 'Git available' },
    ]);
    const handler = createConfigDoctorCommandHandler({
      config: fakeConfig(),
      runDoctor: (request) => {
        receivedRequest = request;
        return Promise.resolve(report);
      },
    });

    const result = await requiredResult(
      handler,
      invocation('doctor', [], { json: true, offline: true, project: '/selected' }),
    );
    expect(receivedRequest).toEqual({ offline: true, project: '/selected' });
    expect(result).toMatchObject({
      ok: false,
      exitCode: 3,
      errors: [
        {
          code: 'DOCTOR_LOCAL_FAILURE',
          details: {
            report: { checks: [{ id: 'project-state' }, { id: 'library-access' }, { id: 'git' }] },
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('local-secret');
    expect(JSON.stringify(result)).not.toContain('remote-secret');
  });

  it('uses repository status when only a remote doctor check fails', async () => {
    const handler = createConfigDoctorCommandHandler({
      config: fakeConfig(),
      runDoctor: () =>
        Promise.resolve(
          doctorReport([
            {
              id: 'library-access',
              status: 'fail',
              scope: 'remote',
              message: 'network unavailable',
              remediation: 'check access',
            },
          ]),
        ),
    });
    await expect(
      requiredResult(handler, invocation('doctor', [], { json: true })),
    ).resolves.toMatchObject({
      ok: false,
      exitCode: 4,
      errors: [{ code: 'DOCTOR_REMOTE_FAILURE' }],
    });
  });

  it('preserves human and JSON doctor reporting through the existing renderer', async () => {
    const checks: DoctorReport['checks'] = [
      {
        id: 'project-state',
        status: 'fail',
        scope: 'local',
        message: 'invalid state',
        remediation: 'restore state',
      },
      { id: 'git', status: 'pass', scope: 'local', message: 'Git available' },
    ];
    const handler = createConfigDoctorCommandHandler({
      config: fakeConfig(),
      runDoctor: () => Promise.resolve(doctorReport(checks)),
    });

    const humanResult = await requiredResult(handler, invocation('doctor'));
    const human = memoryIo();
    renderResult('doctor', humanResult, { json: false, color: false }, human.io);
    expect(human.state.stdout).toBe('');
    expect(human.state.stderr).toContain('Doctor found blocking issues');
    expect(human.state.stderr).toContain('Project managed state');
    expect(human.state.stderr).toContain('Git');
    expect(human.state.stderr).toContain('Next actions');
    expect(human.state.stderr).toContain('restore state');
    expect(human.state.exitCode).toBe(3);

    const jsonResult = await requiredResult(handler, invocation('doctor', [], { json: true }));
    const json = memoryIo();
    renderResult('doctor', jsonResult, { json: true, color: false }, json.io);
    const envelope = JSON.parse(json.state.stdout) as {
      readonly errors: readonly { readonly details?: { readonly report?: DoctorReport } }[];
    };
    expect(json.state.stdout.trim().split('\n')).toHaveLength(1);
    expect(envelope.errors[0]?.details?.report?.checks).toHaveLength(2);
    expect(json.state.stderr).toBe('');
    expect(json.state.exitCode).toBe(3);
  });

  it('redacts unexpected doctor failures and uses stable internal status', async () => {
    const handler = createConfigDoctorCommandHandler({
      config: fakeConfig(),
      runDoctor: () => Promise.reject(new Error('token=github_pat_abcdefghijklmnopqrstuvwxyz')),
    });
    const result = await requiredResult(handler, invocation('doctor'));
    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      errors: [{ code: 'INTERNAL_ERROR' }],
    });
    expect(JSON.stringify(result)).not.toContain('github_pat_');
  });
});
