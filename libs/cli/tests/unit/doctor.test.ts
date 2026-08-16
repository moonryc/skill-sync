import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor, type DoctorCommandRunner } from '../../src/application/doctor.js';
import { EXIT_CODES } from '../../src/domain/result.js';
import type { ApplicationPaths } from '../../src/infrastructure/config.js';
import { ProcessRunError } from '../../src/infrastructure/process-runner.js';
import {
  acquireAdvisoryLock,
  createOperationJournal,
  createRecoverableBackup,
} from '../../src/infrastructure/transactions.js';

const REMOTE = 'https://github.com/example/skills.git';
const IDENTITY = 'github.com/example/skills';
const REVISION = 'a'.repeat(40);
const temporaryRoots: string[] = [];

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function applicationPaths(root: string): ApplicationPaths {
  const configDirectory = join(root, 'config');
  const cacheDirectory = join(root, 'cache');
  const stateDirectory = join(root, 'state');
  return {
    backupsDirectory: join(stateDirectory, 'backups'),
    cacheDirectory,
    configDirectory,
    configFile: join(configDirectory, 'config.json'),
    journalsDirectory: join(stateDirectory, 'journals'),
    locksDirectory: join(stateDirectory, 'locks'),
    stateDirectory,
  };
}

async function writeConfiguration(paths: ApplicationPaths): Promise<void> {
  await mkdir(paths.configDirectory, { recursive: true });
  await writeFile(
    paths.configFile,
    `${JSON.stringify({
      schemaVersion: 1,
      library: { identity: IDENTITY, remote: REMOTE, transport: 'https' },
    })}\n`,
  );
}

async function writeValidCache(paths: ApplicationPaths): Promise<void> {
  const key = createHash('sha256').update(IDENTITY).digest('hex');
  const libraryDirectory = join(paths.cacheDirectory, key);
  await mkdir(join(libraryDirectory, 'repository.git'), { recursive: true });
  await writeFile(
    join(libraryDirectory, 'state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      identity: IDENTITY,
      branch: 'main',
      revision: REVISION,
      refreshedAt: '2026-07-19T12:00:00.000Z',
    })}\n`,
  );
}

function successfulRunner(calls: string[]): DoctorCommandRunner {
  return (executable, arguments_) => {
    const signature = `${executable} ${arguments_.join(' ')}`;
    calls.push(signature);
    if (signature === 'git --version') {
      return Promise.resolve({ stdout: 'git version 2.50.0\n', stderr: '' });
    }
    if (signature === 'gh --version') {
      return Promise.resolve({ stdout: 'gh version 2.75.0\n', stderr: '' });
    }
    if (arguments_.includes('--is-bare-repository')) {
      return Promise.resolve({ stdout: 'true\n', stderr: '' });
    }
    if (arguments_.includes('cat-file')) {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (arguments_.includes('show')) {
      return Promise.resolve({ stdout: '{"schemaVersion":1}\n', stderr: '' });
    }
    if (executable === 'gh' && arguments_[0] === 'auth') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (executable === 'git' && arguments_[0] === 'ls-remote') {
      return Promise.resolve({ stdout: `${REVISION}\tHEAD\n`, stderr: '' });
    }
    return Promise.reject(new Error(`Unexpected diagnostic command: ${signature}`));
  };
}

async function snapshot(root: string): Promise<readonly string[]> {
  const entries: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      const candidate = join(path, name);
      const information = await stat(candidate);
      const label = relative(root, candidate);
      if (information.isDirectory()) {
        entries.push(`d:${label}:${String(information.mode)}:${String(information.mtimeMs)}`);
        await visit(candidate);
      } else {
        entries.push(
          `f:${label}:${String(information.mode)}:${String(information.mtimeMs)}:${await readFile(candidate, 'utf8')}`,
        );
      }
    }
  }
  await visit(root);
  return entries;
}

describe('doctor diagnostics', () => {
  it('runs local checks without network access or filesystem mutation in offline mode', async () => {
    const root = await makeTemporaryDirectory('skill-sync-doctor-offline-');
    const project = join(root, 'project');
    const paths = applicationPaths(root);
    await mkdir(project);
    await writeConfiguration(paths);
    await writeValidCache(paths);
    const before = await snapshot(root);
    const calls: string[] = [];

    const report = await runDoctor({
      env: {},
      nodeVersion: '24.4.0',
      offline: true,
      paths,
      project,
      runCommand: successfulRunner(calls),
    });

    expect(report.exitCode).toBe(EXIT_CODES.success);
    expect(report.checks.filter((check) => check.scope === 'remote')).toEqual([
      expect.objectContaining({ id: 'github-auth', status: 'skipped' }),
      expect.objectContaining({ id: 'library-access', status: 'skipped' }),
    ]);
    expect(report.checks.find((check) => check.id === 'recovery-state')).toMatchObject({
      status: 'pass',
    });
    expect(calls.some((call) => call.includes('ls-remote'))).toBe(false);
    expect(calls.some((call) => call.includes('auth status'))).toBe(false);
    expect(await snapshot(root)).toEqual(before);
  });

  it('reports all valid recovery evidence without changing it', async () => {
    const root = await makeTemporaryDirectory('skill-sync-doctor-recovery-');
    const project = join(root, 'project');
    const paths = applicationPaths(root);
    await mkdir(project);
    await writeConfiguration(paths);
    await writeValidCache(paths);
    const lock = await acquireAdvisoryLock(join(paths.locksDirectory, 'project.lock'), {
      operationId: 'active-project-operation',
      scope: { id: 'project-example', kind: 'project' },
    });
    await createOperationJournal(join(paths.journalsDirectory, 'project-example'), {
      kind: 'install',
      operationId: 'interrupted-install',
    });
    const source = join(project, 'source.txt');
    await writeFile(source, 'recoverable content\n');
    await createRecoverableBackup({
      backupRoot: join(paths.backupsDirectory, 'project-example'),
      entries: [{ path: source, relativePath: 'source.txt' }],
      operationId: 'install-backup',
      projectRoot: project,
    });
    const before = await snapshot(root);

    const report = await runDoctor({
      env: {},
      nodeVersion: '24.4.0',
      offline: true,
      paths,
      project,
      runCommand: successfulRunner([]),
    });

    expect(report.checks.find((check) => check.id === 'recovery-state')).toMatchObject({
      message:
        'Application recovery evidence needs review: 1 lock(s), 1 incomplete journal(s), 1 backup(s), and 0 validation problem(s).',
      remediation:
        'Run skill-sync recovery list to get a stable record ID, then skill-sync recovery inspect <id>.',
      scope: 'local',
      status: 'warning',
    });
    expect(report.exitCode).toBe(EXIT_CODES.success);
    expect(await snapshot(root)).toEqual(before);
    await lock.release();
  });

  it('fails locally on malformed recovery evidence and preserves its exact bytes', async () => {
    const root = await makeTemporaryDirectory('skill-sync-doctor-invalid-recovery-');
    const project = join(root, 'project');
    const paths = applicationPaths(root);
    await mkdir(project);
    await mkdir(paths.locksDirectory, { recursive: true });
    const malformed = join(paths.locksDirectory, 'malformed.lock');
    await writeFile(malformed, '{"broken":true}\n');
    const before = await snapshot(root);

    const report = await runDoctor({
      env: {},
      nodeVersion: '24.4.0',
      offline: true,
      paths,
      project,
      runCommand: successfulRunner([]),
    });

    expect(report.checks.find((check) => check.id === 'recovery-state')).toMatchObject({
      remediation:
        'Run skill-sync recovery list to get a stable record ID, then skill-sync recovery inspect <id>.',
      scope: 'local',
      status: 'fail',
    });
    expect(report.exitCode).toBe(EXIT_CODES.validation);
    expect(await readFile(malformed, 'utf8')).toBe('{"broken":true}\n');
    expect(await snapshot(root)).toEqual(before);
  });

  it('reports local project and remote access failures in one run with local precedence', async () => {
    const root = await makeTemporaryDirectory('skill-sync-doctor-problems-');
    const project = join(root, 'project');
    const paths = applicationPaths(root);
    await mkdir(project);
    await writeConfiguration(paths);
    await writeFile(join(project, 'skill-sync.json'), '{not-json\n');
    const calls: string[] = [];
    const runner = successfulRunner(calls);

    const report = await runDoctor({
      env: {},
      nodeVersion: '24.4.0',
      paths,
      project,
      runCommand: async (executable, arguments_, options) => {
        if (executable === 'git' && arguments_[0] === 'ls-remote') {
          calls.push(`${executable} ${arguments_.join(' ')}`);
          throw Object.assign(new Error('access denied'), { stderr: 'authentication failed' });
        }
        return await runner(executable, arguments_, options);
      },
    });

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'library-access', status: 'fail', scope: 'remote' }),
        expect.objectContaining({ id: 'project-state', status: 'fail', scope: 'local' }),
      ]),
    );
    expect(report.exitCode).toBe(EXIT_CODES.validation);
  });

  it('uses repository status when the only failing check is remote access', async () => {
    const root = await makeTemporaryDirectory('skill-sync-doctor-remote-');
    const project = join(root, 'project');
    const paths = applicationPaths(root);
    await mkdir(project);
    await writeConfiguration(paths);
    const runner = successfulRunner([]);

    const report = await runDoctor({
      env: {},
      nodeVersion: '24.4.0',
      paths,
      project,
      runCommand: async (executable, arguments_, options) => {
        if (executable === 'git' && arguments_[0] === 'ls-remote') {
          throw new Error('network unavailable');
        }
        return await runner(executable, arguments_, options);
      },
    });

    expect(report.exitCode).toBe(EXIT_CODES.repository);
    expect(report.checks.find((check) => check.id === 'library-access')).toMatchObject({
      status: 'fail',
    });
    expect(report.checks.find((check) => check.id === 'cache')).toMatchObject({
      status: 'warning',
    });
  });

  it('maps shared-runner failures and propagates noninteractive cancellation policy', async () => {
    const root = await makeTemporaryDirectory('skill-sync-doctor-process-policy-');
    const project = join(root, 'project');
    const paths = applicationPaths(root);
    await mkdir(project);
    const controller = new AbortController();
    const optionsSeen: Parameters<DoctorCommandRunner>[2][] = [];

    const report = await runDoctor({
      commandTimeoutMs: 41,
      env: { GIT_DIR: '/hostile' },
      nodeVersion: '24.4.0',
      paths,
      project,
      runCommand: (executable, _arguments, options) => {
        optionsSeen.push(options);
        if (executable === 'git') {
          throw new ProcessRunError(
            'spawn-failed',
            'Could not start git.',
            { exitCode: null, stderr: '', stdout: '' },
            { cause: Object.assign(new Error('missing'), { code: 'ENOENT' }) },
          );
        }
        throw new ProcessRunError('timeout', 'Child process gh stopped: timeout.', {
          exitCode: null,
          stderr: 'token=top-secret timed out',
          stdout: '',
        });
      },
      signal: controller.signal,
    });

    expect(report.checks.find((check) => check.id === 'git')).toMatchObject({
      message: 'Git is not installed or not on PATH.',
      status: 'fail',
    });
    expect(report.checks.find((check) => check.id === 'github-cli')).toMatchObject({
      message: 'GitHub CLI could not be executed: token=[REDACTED] timed out',
      status: 'warning',
    });
    expect(optionsSeen).toHaveLength(2);
    expect(optionsSeen).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: controller.signal,
          timeoutMs: 41,
        }),
      ]),
    );
    for (const options of optionsSeen) {
      expect(options?.env).toMatchObject({
        GCM_INTERACTIVE: 'never',
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
      });
      expect(options?.env?.GIT_DIR).toBeUndefined();
    }
  });
});
