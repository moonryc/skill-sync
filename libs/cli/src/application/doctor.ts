import { execFile } from 'node:child_process';
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
import { normalizeGitRemote, type NormalizedGitRemote } from '../infrastructure/git.js';
import {
  assertProjectStatePair,
  readProjectLock,
  readProjectManifest,
  resolveProjectRoot,
} from '../infrastructure/project-state.js';
import { readGlobalLock, readGlobalManifest } from '../infrastructure/global-state.js';
import {
  TargetRegistry,
  resolveContainedDestination,
  resolveContainedGlobalDestination,
} from '../targets/index.js';
import { globalMutationStorage } from './managed-scope.js';

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
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly global?: boolean;
  readonly nodeVersion?: string;
  readonly offline?: boolean;
  readonly paths?: ApplicationPaths;
  readonly project?: string;
  readonly runCommand?: DoctorCommandRunner;
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

function runCommand(
  executable: string,
  arguments_: readonly string[],
  options: DoctorCommandOptions = {},
): Promise<DoctorCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...arguments_],
      {
        cwd: options.cwd,
        encoding: 'utf8',
        env: options.env,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const commandError =
            error instanceof Error ? error : new Error('The diagnostic command failed.');
          Object.assign(commandError, { stdout, stderr });
          reject(commandError);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
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
  if (typeof error === 'object' && error !== null) {
    const stderr: unknown = (error as { readonly stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') return redactSecrets(stderr.trim());
  }
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function commandNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = (error as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === 127;
}

function gitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...environment,
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

export interface DoctorReportFormatOptions {
  readonly color?: boolean;
}

const CHECK_LABELS: Readonly<Record<string, string>> = {
  cache: 'Library cache',
  config: 'Configuration',
  git: 'Git',
  'github-auth': 'GitHub authentication',
  'github-cli': 'GitHub CLI',
  'global-recovery': 'Global recovery paths',
  'global-state': 'Global managed state',
  'global-target-permissions': 'Global target permissions',
  'library-access': 'Library access',
  'library-schema': 'Library schema',
  'library-url': 'Library URL',
  node: 'Node.js',
  'project-root': 'Project root',
  'project-state': 'Project managed state',
  'target-permissions': 'Target permissions',
};

const STATUS_ORDER: readonly DoctorCheckStatus[] = ['fail', 'warning', 'skipped', 'pass'];

const STATUS_DETAILS: Readonly<
  Record<
    DoctorCheckStatus,
    { readonly color: number; readonly glyph: string; readonly label: string }
  >
> = {
  fail: { color: 31, glyph: '✕', label: 'BLOCKED' },
  warning: { color: 33, glyph: '!', label: 'ATTENTION' },
  skipped: { color: 36, glyph: '•', label: 'SKIPPED' },
  pass: { color: 32, glyph: '✓', label: 'PASS' },
};

function colour(value: string, code: number, enabled: boolean): string {
  return enabled ? `\u001B[${String(code)}m${value}\u001B[0m` : value;
}

function formattedStatus(status: DoctorCheckStatus, color: boolean): string {
  const detail = STATUS_DETAILS[status];
  return color ? colour(detail.glyph, detail.color, true) : detail.label;
}

function checkLabel(check: DoctorCheck): string {
  return CHECK_LABELS[check.id] ?? check.id.replaceAll('-', ' ');
}

function reportScope(report: DoctorReport): string {
  if (report.scope === 'global') {
    return `global${report.globalStateDirectory === undefined ? '' : ` (${report.globalStateDirectory})`}`;
  }
  if (report.scope === 'project' || report.projectRoot !== undefined) {
    return `project${report.projectRoot === undefined ? '' : ` (${report.projectRoot})`}`;
  }
  return 'current environment';
}

function overallStatus(checks: readonly DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'pass';
}

function overallLabel(status: DoctorCheckStatus): string {
  if (status === 'fail') return 'Doctor found blocking issues';
  if (status === 'warning') return 'Doctor found items that need attention';
  return 'Your skill-sync setup looks healthy';
}

/** Render the existing structured report for people without changing its JSON contract. */
export function formatDoctorReport(
  report: DoctorReport,
  options: DoctorReportFormatOptions = {},
): string {
  const color = options.color === true;
  const overall = overallStatus(report.checks);
  const lines = [
    colour(`skill-sync doctor · ${overallLabel(overall)}`, STATUS_DETAILS[overall].color, color),
    `Scope: ${reportScope(report)}`,
    report.offline ? 'Remote checks: skipped (--offline)' : 'Remote checks: included',
  ];

  for (const status of STATUS_ORDER) {
    const checks = report.checks.filter((check) => check.status === status);
    if (checks.length === 0) continue;
    const heading = color
      ? `${formattedStatus(status, true)} ${STATUS_DETAILS[status].label}`
      : STATUS_DETAILS[status].label;
    lines.push('', `${heading} (${String(checks.length)})`);
    for (const check of checks) {
      lines.push(`  ${checkLabel(check)}${check.scope === 'remote' ? ' · remote' : ''}`);
      lines.push(`    ${check.message}`);
    }
  }

  const remediations = report.checks.filter(
    (check): check is DoctorCheck & { readonly remediation: string } =>
      (check.status === 'fail' || check.status === 'warning') && check.remediation !== undefined,
  );
  if (remediations.length > 0) {
    lines.push('', colour('Next actions', 35, color));
    for (const [index, check] of remediations.entries()) {
      lines.push(`${String(index + 1)}. ${checkLabel(check)} — ${check.remediation}`);
    }
  }

  return lines.join('\n');
}

export async function runDoctor(request: DoctorRequest = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const environment = request.env ?? process.env;
  const command = request.runCommand ?? runCommand;
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
    const github = await command('gh', ['--version'], { env: environment });
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
          env: { ...environment, GH_PROMPT_DISABLED: '1' },
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
