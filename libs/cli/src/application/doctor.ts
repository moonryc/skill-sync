import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LIBRARY_MANIFEST_PATH, parseLibraryManifest } from '../domain/library.js';
import { EXIT_CODES, redactSecrets, type ExitCode } from '../domain/result.js';
import {
  readUserConfig,
  resolveApplicationPaths,
  resolveConfiguration,
  type ApplicationPaths,
  type UserConfig,
} from '../infrastructure/config.js';
import { readGlobalLock, readGlobalManifest } from '../infrastructure/global-state.js';
import { normalizeGitRemote, type NormalizedGitRemote } from '../infrastructure/git.js';
import {
  assertProjectStatePair,
  readProjectLock,
  readProjectManifest,
  resolveProjectRoot,
} from '../infrastructure/project-state.js';
import {
  nonInteractiveProcessEnvironment,
  ProcessRunError,
  runProcess,
} from '../infrastructure/process-runner.js';
import {
  TargetRegistry,
  resolveContainedDestination,
  resolveContainedGlobalDestination,
} from '../targets/index.js';
import { globalMutationStorage } from './managed-scope.js';
import { inspectRecoveryState } from './recovery.js';

export type DoctorCheckStatus = 'pass' | 'warning' | 'fail' | 'skipped';
export type DoctorCheckScope = 'local' | 'remote';

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly scope: DoctorCheckScope;
  readonly message: string;
  readonly remediation?: string;
}

export interface DoctorReport {
  readonly globalStateDirectory?: string;
  readonly offline: boolean;
  readonly projectRoot?: string;
  readonly scope?: 'global' | 'project';
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: ExitCode;
}

export interface DoctorCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface DoctorCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export type DoctorCommandRunner = (
  executable: string,
  arguments_: readonly string[],
  options?: DoctorCommandOptions,
) => Promise<DoctorCommandOutput>;

export interface DoctorRequest {
  readonly commandTimeoutMs?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly global?: boolean;
  readonly nodeVersion?: string;
  readonly offline?: boolean;
  readonly paths?: ApplicationPaths;
  readonly project?: string;
  readonly runCommand?: DoctorCommandRunner;
  readonly signal?: AbortSignal;
  readonly targets?: TargetRegistry;
}

interface CachedLibrary {
  readonly repositoryDirectory: string;
  readonly revision: string;
}

interface CacheInspection {
  readonly check: DoctorCheck;
  readonly library?: CachedLibrary;
}

const DOCTOR_PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: DoctorCommandOptions = {},
): Promise<DoctorCommandOutput> {
  return await runProcess({
    arguments: arguments_,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    executable,
    maxOutputBytes: PROCESS_OUTPUT_LIMIT_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? DOCTOR_PROCESS_TIMEOUT_MS,
  });
}

function makeCheck(
  id: string,
  status: DoctorCheckStatus,
  scope: DoctorCheckScope,
  message: string,
  remediation?: string,
): DoctorCheck {
  if (status !== 'pass' && remediation === undefined) {
    throw new Error(`Doctor check ${id} requires remediation for status ${status}.`);
  }
  return {
    id,
    status,
    scope,
    message: redactSecrets(message),
    ...(remediation === undefined ? {} : { remediation: redactSecrets(remediation) }),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ProcessRunError && error.output.stderr.trim() !== '') {
    return redactSecrets(error.output.stderr.trim());
  }
  if (typeof error === 'object' && error !== null) {
    const stderr: unknown = (error as { readonly stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') return redactSecrets(stderr.trim());
  }
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function commandNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = (error as { readonly code?: unknown }).code;
  if (code === 'ENOENT' || code === 127) return true;
  if (error instanceof ProcessRunError) {
    return error.output.exitCode === 127 || commandNotFound(error.cause);
  }
  return false;
}

function gitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...nonInteractiveProcessEnvironment(environment),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_KEY_1: 'protocol.file.allow',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_VALUE_1: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function cacheKey(identity: string): string {
  return createHash('sha256').update(identity).digest('hex');
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function inspectRecoveryEvidence(paths: ApplicationPaths): Promise<DoctorCheck> {
  const remediation =
    'Run skill-sync recovery list to get a stable record ID, then skill-sync recovery inspect <id>.';
  try {
    const inspection = await inspectRecoveryState(paths);
    const counts = `${String(inspection.locks.length)} lock(s), ${String(inspection.journals.length)} incomplete journal(s), ${String(inspection.backups.length)} backup(s), and ${String(inspection.problems.length)} validation problem(s)`;
    if (inspection.problems.length > 0) {
      return makeCheck(
        'recovery-state',
        'fail',
        'local',
        `Application recovery evidence is unsafe or malformed: ${counts}.`,
        remediation,
      );
    }
    if (
      inspection.locks.length > 0 ||
      inspection.journals.length > 0 ||
      inspection.backups.length > 0
    ) {
      return makeCheck(
        'recovery-state',
        'warning',
        'local',
        `Application recovery evidence needs review: ${counts}.`,
        remediation,
      );
    }
    return makeCheck(
      'recovery-state',
      'pass',
      'local',
      'No application recovery locks, incomplete journals, backups, or validation problems were found.',
    );
  } catch (error) {
    return makeCheck(
      'recovery-state',
      'fail',
      'local',
      `Application recovery evidence could not be inspected safely: ${errorMessage(error)}`,
      remediation,
    );
  }
}

function parseCacheState(value: unknown, expectedIdentity: string): { readonly revision: string } {
  if (typeof value !== 'object' || value === null) throw new Error('Cache state is not an object.');
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.identity !== expectedIdentity ||
    typeof record.branch !== 'string' ||
    record.branch.length === 0 ||
    typeof record.revision !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(record.revision) ||
    typeof record.refreshedAt !== 'string' ||
    Number.isNaN(Date.parse(record.refreshedAt))
  ) {
    throw new Error('Cache state does not match the supported schema or configured library.');
  }
  return { revision: record.revision };
}

async function inspectCache(
  paths: ApplicationPaths,
  remote: NormalizedGitRemote | undefined,
  command: DoctorCommandRunner,
  environment: NodeJS.ProcessEnv,
  gitAvailable: boolean,
): Promise<CacheInspection> {
  try {
    const rootInformation = await safeLstat(paths.cacheDirectory);
    if (rootInformation === undefined) {
      return {
        check: makeCheck(
          'cache',
          'warning',
          'local',
          'The library cache does not exist yet.',
          'Run init or a read command online to populate the cache.',
        ),
      };
    }
    if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
      return {
        check: makeCheck(
          'cache',
          'fail',
          'local',
          'The cache root is not a safe directory.',
          `Move the unexpected path aside and recreate the cache through skill-sync: ${paths.cacheDirectory}`,
        ),
      };
    }
    await readdir(paths.cacheDirectory);

    if (remote === undefined) {
      return {
        check: makeCheck(
          'cache',
          'warning',
          'local',
          'The cache root is readable, but no active library is configured.',
          'Configure library.remote before validating a specific cache entry.',
        ),
      };
    }

    const libraryDirectory = join(paths.cacheDirectory, cacheKey(remote.identity));
    const libraryInformation = await safeLstat(libraryDirectory);
    if (libraryInformation === undefined) {
      return {
        check: makeCheck(
          'cache',
          'warning',
          'local',
          'No cached revision exists for the configured library.',
          'Run a library read command online to populate this cache entry.',
        ),
      };
    }
    if (!libraryInformation.isDirectory() || libraryInformation.isSymbolicLink()) {
      throw new Error('The configured library cache entry is not a safe directory.');
    }

    const statePath = join(libraryDirectory, 'state.json');
    const repositoryDirectory = join(libraryDirectory, 'repository.git');
    const repositoryInformation = await safeLstat(repositoryDirectory);
    if (
      repositoryInformation === undefined ||
      !repositoryInformation.isDirectory() ||
      repositoryInformation.isSymbolicLink()
    ) {
      throw new Error('The configured library cache does not contain a safe bare repository.');
    }
    const state = parseCacheState(
      JSON.parse(await readFile(statePath, 'utf8')) as unknown,
      remote.identity,
    );

    if (gitAvailable) {
      const bare = await command(
        'git',
        ['--git-dir', repositoryDirectory, 'rev-parse', '--is-bare-repository'],
        { env: gitEnvironment(environment) },
      );
      if (bare.stdout.trim() !== 'true') throw new Error('The cached repository is not bare.');
      await command(
        'git',
        ['--git-dir', repositoryDirectory, 'cat-file', '-e', `${state.revision}^{commit}`],
        { env: gitEnvironment(environment) },
      );
    }

    return {
      check: makeCheck(
        'cache',
        'pass',
        'local',
        `The configured cache entry is readable at revision ${state.revision}.`,
      ),
      library: { repositoryDirectory, revision: state.revision },
    };
  } catch (error) {
    return {
      check: makeCheck(
        'cache',
        'fail',
        'local',
        `The configured library cache is invalid: ${errorMessage(error)}`,
        'Move the affected cache entry aside, then repopulate it with an online read command.',
      ),
    };
  }
}

async function nearestExistingPath(path: string): Promise<string> {
  let cursor = path;
  for (;;) {
    if ((await safeLstat(cursor)) !== undefined) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}

async function inspectProject(
  request: DoctorRequest,
  checks: DoctorCheck[],
): Promise<string | undefined> {
  let projectRoot: string;
  try {
    projectRoot = await resolveProjectRoot({
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.project === undefined ? {} : { explicitPath: request.project }),
    });
  } catch (error) {
    checks.push(
      makeCheck(
        'project-root',
        'fail',
        'local',
        `The project root could not be resolved: ${errorMessage(error)}`,
        'Pass --project with an existing directory or run from a readable project directory.',
      ),
    );
    checks.push(
      makeCheck(
        'project-state',
        'skipped',
        'local',
        'Project metadata was not checked because the project root is unavailable.',
        'Resolve the project-root check first.',
      ),
    );
    checks.push(
      makeCheck(
        'target-permissions',
        'skipped',
        'local',
        'Target destinations were not checked because the project root is unavailable.',
        'Resolve the project-root check first.',
      ),
    );
    return undefined;
  }

  checks.push(makeCheck('project-root', 'pass', 'local', `Project root: ${projectRoot}`));

  let manifest: Awaited<ReturnType<typeof readProjectManifest>>;
  let lock: Awaited<ReturnType<typeof readProjectLock>>;
  const stateProblems: string[] = [];
  try {
    manifest = await readProjectManifest(projectRoot);
  } catch (error) {
    stateProblems.push(`manifest: ${errorMessage(error)}`);
  }
  try {
    lock = await readProjectLock(projectRoot);
  } catch (error) {
    stateProblems.push(`lock: ${errorMessage(error)}`);
  }
  if (stateProblems.length === 0 && (manifest === undefined) !== (lock === undefined)) {
    stateProblems.push(
      'skill-sync.json and skill-sync.lock.json must either both exist or both be absent.',
    );
  }
  if (stateProblems.length === 0 && manifest !== undefined && lock !== undefined) {
    try {
      assertProjectStatePair(manifest, lock);
    } catch (error) {
      stateProblems.push(errorMessage(error));
    }
  }

  checks.push(
    stateProblems.length === 0
      ? makeCheck(
          'project-state',
          'pass',
          'local',
          manifest === undefined
            ? 'No skill-sync project metadata is present.'
            : `Project metadata is valid for ${String(manifest.skills.length)} tracked skill(s).`,
        )
      : makeCheck(
          'project-state',
          'fail',
          'local',
          `Project metadata is invalid: ${stateProblems.join(' ')}`,
          'Correct or restore both project state files before running a mutating command.',
        ),
  );

  const targetProblems: string[] = [];
  for (const target of (request.targets ?? new TargetRegistry()).list()) {
    try {
      const destination = await resolveContainedDestination(
        projectRoot,
        target.relativeDestination('__doctor__'),
      );
      const existing = await nearestExistingPath(destination);
      await access(existing, constants.W_OK);
    } catch (error) {
      targetProblems.push(`${target.name}: ${errorMessage(error)}`);
    }
  }
  checks.push(
    targetProblems.length === 0
      ? makeCheck(
          'target-permissions',
          'pass',
          'local',
          'Codex and Claude destination ancestors are contained and writable.',
        )
      : makeCheck(
          'target-permissions',
          'fail',
          'local',
          `One or more target destinations are unsafe or not writable: ${targetProblems.join(' ')}`,
          'Repair destination ownership or remove escaping symlinks before installing skills.',
        ),
  );

  return projectRoot;
}

async function inspectGlobal(
  request: DoctorRequest,
  paths: ApplicationPaths,
  checks: DoctorCheck[],
): Promise<string> {
  if (
    paths.globalStateDirectory === undefined ||
    paths.globalManifestFile === undefined ||
    paths.globalLockFile === undefined
  ) {
    checks.push(
      makeCheck(
        'global-state',
        'fail',
        'local',
        'Global state paths are unavailable.',
        'Use a supported user configuration location and rerun doctor --global.',
      ),
    );
    return paths.stateDirectory;
  }

  const stateProblems: string[] = [];
  let manifest: Awaited<ReturnType<typeof readGlobalManifest>>;
  let lock: Awaited<ReturnType<typeof readGlobalLock>>;
  try {
    manifest = await readGlobalManifest(paths);
  } catch (error) {
    stateProblems.push(`manifest: ${errorMessage(error)}`);
  }
  try {
    lock = await readGlobalLock(paths);
  } catch (error) {
    stateProblems.push(`lock: ${errorMessage(error)}`);
  }
  if (stateProblems.length === 0 && (manifest === undefined) !== (lock === undefined)) {
    stateProblems.push('Global manifest and lock must either both exist or both be absent.');
  }
  if (stateProblems.length === 0 && manifest !== undefined && lock !== undefined) {
    if (manifest.library.identity !== lock.library.identity) {
      stateProblems.push('Global manifest and lock reference different libraries.');
    }
    const manifestIds = manifest.skills.map((skill) => skill.id).sort();
    const lockIds = lock.skills.map((skill) => skill.id).sort();
    if (manifestIds.join('\n') !== lockIds.join('\n')) {
      stateProblems.push('Global manifest and lock contain different skill IDs.');
    }
  }
  checks.push(
    stateProblems.length === 0
      ? makeCheck(
          'global-state',
          'pass',
          'local',
          manifest === undefined
            ? `No global skill metadata is present at ${paths.globalStateDirectory}.`
            : `Global metadata is valid for ${String(manifest.skills.length)} tracked skill(s).`,
        )
      : makeCheck(
          'global-state',
          'fail',
          'local',
          `Global metadata is invalid: ${stateProblems.join(' ')}`,
          'Correct or restore both global state files before running a mutating command.',
        ),
  );

  const targetProblems: string[] = [];
  for (const target of (request.targets ?? new TargetRegistry()).list()) {
    try {
      if (target.globalDestination === undefined || target.globalRoot === undefined) {
        throw new Error('This target has no supported global destination.');
      }
      const destination = await resolveContainedGlobalDestination(
        target.globalRoot(),
        target.globalDestination('__doctor__'),
      );
      const existing = await nearestExistingPath(destination);
      await access(existing, constants.W_OK);
    } catch (error) {
      targetProblems.push(`${target.name}: ${errorMessage(error)}`);
    }
  }
  checks.push(
    targetProblems.length === 0
      ? makeCheck(
          'global-target-permissions',
          'pass',
          'local',
          'Global Codex and Claude destination ancestors are contained and writable.',
        )
      : makeCheck(
          'global-target-permissions',
          'fail',
          'local',
          `One or more global target destinations are unsafe or not writable: ${targetProblems.join(' ')}`,
          'Repair destination ownership or remove escaping symlinks before installing global skills.',
        ),
  );

  const storage = globalMutationStorage(paths);
  const recoveryPaths = [storage.lockPath, storage.journalDirectory, storage.backupRoot];
  const recoveryProblems: string[] = [];
  for (const path of recoveryPaths) {
    try {
      const information = await safeLstat(path);
      if (information?.isSymbolicLink()) recoveryProblems.push(`${path} is a symbolic link`);
    } catch (error) {
      recoveryProblems.push(errorMessage(error));
    }
  }
  checks.push(
    recoveryProblems.length === 0
      ? makeCheck(
          'global-recovery',
          'pass',
          'local',
          'Global lock, journal, and backup locations are safe to use.',
        )
      : makeCheck(
          'global-recovery',
          'fail',
          'local',
          `Global recovery state is unsafe: ${recoveryProblems.join(' ')}`,
          'Remove unsafe links and inspect any unfinished global operation before retrying.',
        ),
  );
  return paths.globalStateDirectory;
}

function reportExitCode(checks: readonly DoctorCheck[]): ExitCode {
  if (checks.some((check) => check.status === 'fail' && check.scope === 'local')) {
    return EXIT_CODES.validation;
  }
  if (checks.some((check) => check.status === 'fail' && check.scope === 'remote')) {
    return EXIT_CODES.repository;
  }
  return EXIT_CODES.success;
}

export async function runDoctor(request: DoctorRequest = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const environment = request.env ?? process.env;
  const subprocessEnvironment = nonInteractiveProcessEnvironment(environment);
  const baseCommand = request.runCommand ?? runCommand;
  const command: DoctorCommandRunner = async (executable, arguments_, options = {}) =>
    await baseCommand(executable, arguments_, {
      ...options,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.commandTimeoutMs === undefined ? {} : { timeoutMs: request.commandTimeoutMs }),
    });
  const offline = request.offline === true;
  const paths =
    request.paths ??
    resolveApplicationPaths({
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      env: environment,
    });

  const nodeVersion = request.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  checks.push(
    Number.isInteger(nodeMajor) && nodeMajor >= 22
      ? makeCheck('node', 'pass', 'local', `Node.js ${nodeVersion} satisfies the >=22 requirement.`)
      : makeCheck(
          'node',
          'fail',
          'local',
          `Node.js ${nodeVersion} does not satisfy the >=22 requirement.`,
          'Install Node.js 22 or newer and rerun skill-sync doctor.',
        ),
  );

  let gitAvailable = false;
  try {
    const git = await command('git', ['--version'], { env: gitEnvironment(environment) });
    gitAvailable = true;
    checks.push(makeCheck('git', 'pass', 'local', git.stdout.trim() || 'Git is available.'));
  } catch (error) {
    checks.push(
      makeCheck(
        'git',
        'fail',
        'local',
        commandNotFound(error) ? 'Git is not installed or not on PATH.' : errorMessage(error),
        'Install Git and ensure the git executable is on PATH.',
      ),
    );
  }

  let githubCliAvailable = false;
  try {
    const github = await command('gh', ['--version'], { env: subprocessEnvironment });
    githubCliAvailable = true;
    const githubVersion = github.stdout.split(/\r?\n/u)[0]?.trim();
    checks.push(
      makeCheck(
        'github-cli',
        'pass',
        'local',
        githubVersion === undefined || githubVersion === ''
          ? 'GitHub CLI is available.'
          : githubVersion,
      ),
    );
  } catch (error) {
    checks.push(
      makeCheck(
        'github-cli',
        'warning',
        'local',
        commandNotFound(error)
          ? 'GitHub CLI is unavailable; URL-based workflows can still use Git.'
          : `GitHub CLI could not be executed: ${errorMessage(error)}`,
        'Install and authenticate gh before using init --create.',
      ),
    );
  }

  let userConfig: UserConfig | undefined;
  let effectiveLibraryUrl: string | undefined;
  let configValid = true;
  try {
    userConfig = await readUserConfig(paths.configFile);
    const resolved = resolveConfiguration({
      env: environment,
      ...(userConfig === undefined ? {} : { user: userConfig }),
    });
    effectiveLibraryUrl = resolved.value.libraryUrl;
    checks.push(
      userConfig === undefined && effectiveLibraryUrl === undefined
        ? makeCheck(
            'config',
            'warning',
            'local',
            'No user configuration or environment-provided library is present.',
            'Run skill-sync init <url> or set SKILL_SYNC_LIBRARY.',
          )
        : makeCheck('config', 'pass', 'local', 'The active configuration is parseable.'),
    );
  } catch (error) {
    configValid = false;
    checks.push(
      makeCheck(
        'config',
        'fail',
        'local',
        `The active configuration is invalid: ${errorMessage(error)}`,
        `Correct or move the invalid configuration file: ${paths.configFile}`,
      ),
    );
  }

  checks.push(await inspectRecoveryEvidence(paths));

  let remote: NormalizedGitRemote | undefined;
  if (!configValid) {
    checks.push(
      makeCheck(
        'library-url',
        'skipped',
        'local',
        'The library URL was not checked because configuration parsing failed.',
        'Resolve the config check first.',
      ),
    );
  } else if (effectiveLibraryUrl === undefined) {
    checks.push(
      makeCheck(
        'library-url',
        'warning',
        'local',
        'No library URL is configured.',
        'Run skill-sync init <url> to configure a library.',
      ),
    );
  } else {
    try {
      remote = normalizeGitRemote(effectiveLibraryUrl);
      if (userConfig?.library !== undefined && userConfig.library.identity !== remote.identity) {
        throw new Error('The stored library identity does not match its normalized URL.');
      }
      checks.push(
        makeCheck('library-url', 'pass', 'local', `Configured library: ${remote.identity}`),
      );
    } catch (error) {
      checks.push(
        makeCheck(
          'library-url',
          'fail',
          'local',
          `The configured library URL is invalid: ${errorMessage(error)}`,
          'Set library.remote to a credential-free HTTPS or SSH owner/repository URL.',
        ),
      );
    }
  }

  if (offline) {
    checks.push(
      makeCheck(
        'github-auth',
        'skipped',
        'remote',
        'GitHub authentication was intentionally skipped in offline mode.',
        'Run doctor without --offline to check authentication.',
      ),
      makeCheck(
        'library-access',
        'skipped',
        'remote',
        'Remote library access was intentionally skipped in offline mode.',
        'Run doctor without --offline to check repository access.',
      ),
    );
  } else {
    if (!githubCliAvailable || remote === undefined) {
      checks.push(
        makeCheck(
          'github-auth',
          'skipped',
          'remote',
          !githubCliAvailable
            ? 'GitHub authentication was not checked because gh is unavailable.'
            : 'GitHub authentication was not checked because no valid library URL is configured.',
          !githubCliAvailable
            ? 'Install and authenticate gh to enable this optional diagnostic.'
            : 'Configure a valid library URL first.',
        ),
      );
    } else {
      try {
        await command('gh', ['auth', 'status', '--hostname', remote.host], {
          env: subprocessEnvironment,
        });
        checks.push(
          makeCheck(
            'github-auth',
            'pass',
            'remote',
            `GitHub CLI reports authentication for ${remote.host}.`,
          ),
        );
      } catch (error) {
        checks.push(
          makeCheck(
            'github-auth',
            'warning',
            'remote',
            `GitHub CLI authentication is unavailable: ${errorMessage(error)}`,
            `Run gh auth login --hostname ${remote.host}; Git credential or SSH access may still work.`,
          ),
        );
      }
    }

    if (!gitAvailable || remote === undefined) {
      checks.push(
        makeCheck(
          'library-access',
          'skipped',
          'remote',
          !gitAvailable
            ? 'Remote access was not checked because Git is unavailable.'
            : 'Remote access was not checked because no valid library URL is configured.',
          !gitAvailable ? 'Install Git first.' : 'Configure a valid library URL first.',
        ),
      );
    } else {
      try {
        await command('git', ['ls-remote', '--exit-code', remote.cloneUrl, 'HEAD'], {
          env: gitEnvironment(environment),
        });
        checks.push(
          makeCheck(
            'library-access',
            'pass',
            'remote',
            `The configured library is reachable through ${remote.transport}.`,
          ),
        );
      } catch (error) {
        checks.push(
          makeCheck(
            'library-access',
            'fail',
            'remote',
            `The configured library is inaccessible: ${errorMessage(error)}`,
            'Verify the URL, network connection, repository permissions, and external Git authentication.',
          ),
        );
      }
    }
  }

  const cache = await inspectCache(paths, remote, command, environment, gitAvailable);
  checks.push(cache.check);
  if (cache.library === undefined) {
    checks.push(
      makeCheck(
        'library-schema',
        'skipped',
        'local',
        'No verified cached revision is available for schema inspection.',
        'Populate or repair the configured library cache first.',
      ),
    );
  } else if (!gitAvailable) {
    checks.push(
      makeCheck(
        'library-schema',
        'skipped',
        'local',
        'The cached library schema was not checked because Git is unavailable.',
        'Install Git first.',
      ),
    );
  } else {
    try {
      const manifest = await command(
        'git',
        [
          '--git-dir',
          cache.library.repositoryDirectory,
          'show',
          `${cache.library.revision}:${LIBRARY_MANIFEST_PATH}`,
        ],
        { env: gitEnvironment(environment) },
      );
      const parsed = parseLibraryManifest(JSON.parse(manifest.stdout) as unknown);
      if (!parsed.success) throw new Error(parsed.messages.join(' '));
      checks.push(
        makeCheck(
          'library-schema',
          'pass',
          'local',
          `The cached library declares schema version ${String(parsed.data.schemaVersion)}.`,
        ),
      );
    } catch (error) {
      checks.push(
        makeCheck(
          'library-schema',
          'fail',
          'local',
          `The cached library schema is invalid: ${errorMessage(error)}`,
          'Repair the library with a supported CLI version or select a valid cached revision.',
        ),
      );
    }
  }

  const globalStateDirectory =
    request.global === true ? await inspectGlobal(request, paths, checks) : undefined;
  const projectRoot = request.global === true ? undefined : await inspectProject(request, checks);
  return {
    offline,
    ...(globalStateDirectory === undefined ? {} : { globalStateDirectory }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    scope: request.global === true ? 'global' : 'project',
    checks,
    exitCode: reportExitCode(checks),
  };
}
