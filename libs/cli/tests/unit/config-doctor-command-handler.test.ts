import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  ConfigService,
  type ConfigKey,
  type ConfigurationListing,
} from '../../src/application/config-service.js';
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
    list: () =>
      Promise.resolve({
        path: BASE_LISTING.path,
        configured: {
          'library.remote': values.get('library.remote'),
          'library.branch': values.get('library.branch'),
          'library.transport': values.get('library.transport'),
          'defaults.targets': values.get('defaults.targets'),
          'defaults.gitignore': values.get('defaults.gitignore'),
        },
        effective: {
          value: {
            ...(typeof values.get('library.remote') === 'string'
              ? { libraryUrl: values.get('library.remote') as string }
              : {}),
            branch:
              typeof values.get('library.branch') === 'string'
                ? (values.get('library.branch') as string)
                : 'main',
            defaultTargets: Array.isArray(values.get('defaults.targets'))
              ? (values.get('defaults.targets') as readonly ('claude' | 'codex')[])
              : [],
            gitignore: values.get('defaults.gitignore') === 'manage' ? 'manage' : 'leave',
            transport: values.get('library.transport') === 'ssh' ? 'ssh' : 'https',
          },
          sources: {
            branch: values.has('library.branch') ? 'user' : 'default',
            defaultTargets: values.has('defaults.targets') ? 'user' : 'default',
            gitignore: values.has('defaults.gitignore') ? 'user' : 'default',
            libraryUrl: values.has('library.remote') ? 'user' : 'default',
            transport: values.has('library.transport') ? 'user' : 'default',
          },
        },
      }),
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve(undefined);
    },
    unset: (key) => {
      let changedKeys: ConfigKey[] = [];
      if (key === 'library.remote' && values.has(key)) {
        changedKeys = [
          'library.remote',
          ...(values.has('library.branch') ? (['library.branch'] as const) : []),
          ...(values.has('library.transport') ? (['library.transport'] as const) : []),
        ];
        for (const changedKey of changedKeys) values.delete(changedKey);
      } else if (values.has(key)) {
        values.delete(key);
        changedKeys = [key as ConfigKey];
      }
      return Promise.resolve({ changed: changedKeys.length > 0, changedKeys });
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
      data: [
        'Configuration path: /config/config.json',
        'Next: Run skill-sync config list to inspect configured and effective values.',
      ].join('\n'),
      exitCode: 0,
    });
    await expect(
      requiredResult(handler, invocation('config:path', [], { json: true })),
    ).resolves.toMatchObject({ ok: true, data: { path: '/config/config.json' } });

    const humanList = await requiredResult(handler, invocation('config:list'));
    expect(humanList).toMatchObject({ ok: true });
    if (humanList.ok) {
      expect(humanList.data).toContain('Configuration path: /config/config.json');
      expect(humanList.data).toContain('Configured values: 2 of 5');
      expect(humanList.data).toContain('Key: library.branch');
      expect(humanList.data).toContain('Configured: stable');
      expect(humanList.data).toContain('Effective source: user');
      expect(humanList.data).toContain('Key: defaults.gitignore');
      expect(humanList.data).toContain('Configured: <unset>');
      expect(humanList.data).toContain('Next: Change a value with skill-sync config set');
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

    const humanGet = await requiredResult(handler, invocation('config:get', ['defaults.targets']));
    expect(humanGet).toMatchObject({ ok: true });
    if (humanGet.ok) {
      expect(humanGet.data).toContain('Key: defaults.targets');
      expect(humanGet.data).toContain('Configuration path: /config/config.json');
      expect(humanGet.data).toContain('Configured value: claude, codex');
      expect(humanGet.data).toContain('Effective value: claude, codex');
      expect(humanGet.data).toContain('Effective source: user');
      expect(humanGet.data).toContain('Next: Change it with skill-sync config set');
    }
    await expect(
      requiredResult(handler, invocation('config:get', ['library.remote'], { json: true })),
    ).resolves.toMatchObject({
      ok: true,
      data: { key: 'library.remote', configured: false, value: null },
    });
    const missingGet = await requiredResult(handler, invocation('config:get', ['library.remote']));
    expect(missingGet).toMatchObject({ ok: true });
    if (missingGet.ok) {
      expect(missingGet.data).toContain('Configured value: <unset>');
      expect(missingGet.data).toContain(
        'Next: Set it with skill-sync config set library.remote <value>.',
      );
      expect(missingGet.data).not.toContain('config unset library.remote');
    }
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
    const humanUnset = await requiredResult(
      handler,
      invocation('config:unset', ['defaults.gitignore']),
    );
    expect(humanUnset).toMatchObject({ ok: true });
    if (humanUnset.ok) expect(humanUnset.data).toContain('Configured value removed.');
    await expect(config.get('defaults.gitignore')).resolves.toBeUndefined();

    const humanSet = await requiredResult(
      handler,
      invocation('config:set', ['defaults.gitignore', 'manage']),
    );
    expect(humanSet).toMatchObject({ ok: true });
    if (humanSet.ok) {
      expect(humanSet.data).toContain('Configuration updated.');
      expect(humanSet.data).toContain('Key: defaults.gitignore');
      expect(humanSet.data).toContain('Configured value: manage');
      expect(humanSet.data).toContain('Effective value: manage');
      expect(humanSet.data).toContain('Effective source: user');
      expect(humanSet.data).toContain('Next: Run skill-sync config get defaults.gitignore');
    }

    const jsonUnset = await requiredResult(
      handler,
      invocation('config:unset', ['defaults.gitignore'], { json: true }),
    );
    expect(jsonUnset).toMatchObject({
      data: {
        changed: true,
        changedKeys: ['defaults.gitignore'],
        key: 'defaults.gitignore',
        unset: true,
      },
      ok: true,
    });

    const noOp = await requiredResult(handler, invocation('config:unset', ['defaults.gitignore']));
    expect(noOp).toMatchObject({ ok: true });
    if (noOp.ok) {
      expect(noOp.data).toContain('No configuration change.');
      expect(noOp.data).toContain('Changed keys (0): none');
      expect(noOp.data).toContain(
        'Next: Set an override with skill-sync config set defaults.gitignore <value>.',
      );
    }
    await expect(
      requiredResult(handler, invocation('config:unset', ['defaults.gitignore'], { json: true })),
    ).resolves.toMatchObject({
      data: { changed: false, changedKeys: [], unset: false },
      ok: true,
    });
  });

  it('renders empty configured arrays as none instead of a blank value', async () => {
    const emptyTargets: ConfigurationListing = {
      ...BASE_LISTING,
      configured: { ...BASE_LISTING.configured, 'defaults.targets': [] },
      effective: {
        value: { ...BASE_LISTING.effective.value, defaultTargets: [] },
        sources: { ...BASE_LISTING.effective.sources, defaultTargets: 'user' },
      },
    };
    const handler = createConfigDoctorCommandHandler({
      config: fakeConfig({
        get: (key) => Promise.resolve(key === 'defaults.targets' ? [] : undefined),
        list: () => Promise.resolve(emptyTargets),
      }),
    });

    const get = await requiredResult(handler, invocation('config:get', ['defaults.targets']));
    expect(get).toMatchObject({ ok: true });
    if (get.ok) {
      expect(get.data).toContain('Configured value: <none>');
      expect(get.data).toContain('Effective value: <none>');
    }
    const list = await requiredResult(handler, invocation('config:list'));
    expect(list).toMatchObject({ ok: true });
    if (list.ok) {
      expect(list.data).toContain('Key: defaults.targets');
      expect(list.data).toContain('Configured: <none>');
      expect(list.data).toContain('Effective: <none>');
    }
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

  it('names every coupled key when unsetting a configured library remote', async () => {
    await withTempDirectory('skill-sync-config-command-coupled-unset-', async (root) => {
      const environment = { SKILL_SYNC_CONFIG_HOME: root };
      const service = new ConfigService(
        environment,
        resolveApplicationPaths({ cwd: root, env: environment }),
      );
      const handler = createConfigDoctorCommandHandler({ config: service });
      await service.set('library.remote', 'https://github.com/acme/skills.git');
      await service.set('library.branch', 'stable');
      await service.set('library.transport', 'ssh');

      const human = await requiredResult(handler, invocation('config:unset', ['library.remote']));
      expect(human).toMatchObject({ ok: true });
      if (human.ok) {
        expect(human.data).toContain('Configuration updated.');
        expect(human.data).toContain('Requested key: library.remote');
        expect(human.data).toContain(
          'Changed keys (3): library.remote, library.branch, library.transport',
        );
        expect(human.data).toContain(
          'Next: Run skill-sync config list to review every effective value',
        );
      }
      expect(await service.get('library.remote')).toBeUndefined();
      expect(await service.get('library.branch')).toBeUndefined();
      expect(await service.get('library.transport')).toBeUndefined();

      await service.set('library.remote', 'https://github.com/acme/skills.git');
      await service.set('library.branch', 'stable');
      const json = await requiredResult(
        handler,
        invocation('config:unset', ['library.remote'], { json: true }),
      );
      expect(json).toMatchObject({
        data: {
          changed: true,
          changedKeys: ['library.remote', 'library.branch', 'library.transport'],
          key: 'library.remote',
          unset: true,
        },
        ok: true,
      });
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
