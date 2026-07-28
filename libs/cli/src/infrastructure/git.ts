import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REDACTION_MARKER = '[REDACTED]';
const URL_WITH_AUTHORITY_PATTERN = /\b(?:https?|ssh):\/\/[^\s'"<>]+/giu;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(password|passwd|token|access_token|oauth_token|authorization)=([^\s&;]+)/giu;
const SCP_PASSWORD_PATTERN = /\b[^\s:@/]+:[^\s@/]+@([^\s:/]+):([^\s]+)/gu;

const FORBIDDEN_GIT_ENVIRONMENT_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
] as const;

export type GitTransport = 'https' | 'ssh';

export interface NormalizedGitRemote {
  /** Credential-free identity shared by HTTPS and SSH forms of the same repository. */
  readonly identity: string;
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly transport: GitTransport;
  /** A credential-free URL suitable for passing directly to Git as one argument. */
  readonly cloneUrl: string;
  readonly upgradedFromHttp: boolean;
}

export type GitRemoteUrlErrorCode =
  | 'EMPTY_REMOTE_URL'
  | 'REMOTE_CREDENTIALS_FORBIDDEN'
  | 'UNSUPPORTED_REMOTE_URL'
  | 'INVALID_REMOTE_PATH';

export class GitRemoteUrlError extends Error {
  readonly code: GitRemoteUrlErrorCode;

  constructor(code: GitRemoteUrlErrorCode, message: string) {
    super(message);
    this.name = 'GitRemoteUrlError';
    this.code = code;
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function invalidRemotePath(): never {
  throw new GitRemoteUrlError(
    'INVALID_REMOTE_PATH',
    'The repository URL must identify an owner and repository using portable path segments.',
  );
}

function normalizeRepositoryPath(pathname: string): {
  readonly owner: string;
  readonly repository: string;
} {
  if (/%2f|%5c/iu.test(pathname) || pathname.includes('\\')) {
    return invalidRemotePath();
  }

  const trimmedPath = pathname.replace(/^\/+|\/+$/gu, '').replace(/\.git$/iu, '');
  const encodedSegments = trimmedPath.split('/');
  if (encodedSegments.length !== 2) {
    return invalidRemotePath();
  }

  let segments: string[];
  try {
    segments = encodedSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return invalidRemotePath();
  }

  const [owner, repository] = segments;
  const isPortableSegment = (value: string | undefined): value is string =>
    value !== undefined &&
    value !== '.' &&
    value !== '..' &&
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(value);

  if (!isPortableSegment(owner) || !isPortableSegment(repository)) {
    return invalidRemotePath();
  }

  return { owner, repository };
}

function normalizedIdentity(host: string, owner: string, repository: string): string {
  return `${host.toLowerCase()}/${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

/**
 * Normalize the supported GitHub/GitHub Enterprise transports without performing
 * any network operation. Embedded HTTPS credentials are rejected, not stripped,
 * so a caller cannot accidentally persist or use them.
 */
export function normalizeGitRemote(value: string): NormalizedGitRemote {
  const input = value.trim();
  if (input.length === 0) {
    throw new GitRemoteUrlError('EMPTY_REMOTE_URL', 'A repository URL is required.');
  }
  if (/\s/u.test(input) || containsControlCharacter(input)) {
    throw new GitRemoteUrlError(
      'UNSUPPORTED_REMOTE_URL',
      'The repository URL contains unsupported whitespace or control characters.',
    );
  }

  const scpMatch = /^(?<user>[^@/:]+)@(?<host>[^/:]+):(?<path>.+)$/u.exec(input);
  if (scpMatch?.groups !== undefined) {
    const user = scpMatch.groups.user;
    const host = scpMatch.groups.host;
    const pathname = scpMatch.groups.path;
    if (user === undefined || host === undefined || pathname === undefined) {
      throw new GitRemoteUrlError('UNSUPPORTED_REMOTE_URL', 'The SSH repository URL is invalid.');
    }
    const { owner, repository } = normalizeRepositoryPath(pathname);
    const normalizedHost = host.toLowerCase();
    return {
      identity: normalizedIdentity(normalizedHost, owner, repository),
      host: normalizedHost,
      owner,
      repository,
      transport: 'ssh',
      cloneUrl: `${user}@${normalizedHost}:${owner}/${repository}.git`,
      upgradedFromHttp: false,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new GitRemoteUrlError(
      'UNSUPPORTED_REMOTE_URL',
      'Use an HTTPS, ssh://, or user@host:owner/repository Git URL.',
    );
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'ssh:') {
    throw new GitRemoteUrlError(
      'UNSUPPORTED_REMOTE_URL',
      'Use an HTTPS, ssh://, or user@host:owner/repository Git URL.',
    );
  }
  if (parsed.password.length > 0 || (protocol !== 'ssh:' && parsed.username.length > 0)) {
    throw new GitRemoteUrlError(
      'REMOTE_CREDENTIALS_FORBIDDEN',
      'Repository URLs must not contain credentials; use Git credential helpers or SSH authentication.',
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new GitRemoteUrlError(
      'REMOTE_CREDENTIALS_FORBIDDEN',
      'Repository URLs must not contain query parameters or fragments; use external Git authentication.',
    );
  }
  if (parsed.hostname.length === 0) {
    throw new GitRemoteUrlError('UNSUPPORTED_REMOTE_URL', 'The repository URL needs a host.');
  }

  const { owner, repository } = normalizeRepositoryPath(parsed.pathname);
  const host = parsed.hostname.toLowerCase();
  const hostWithPort = parsed.port.length > 0 ? `${host}:${parsed.port}` : host;
  const identity = normalizedIdentity(host, owner, repository);

  if (protocol === 'ssh:') {
    const user = parsed.username.length > 0 ? decodeURIComponent(parsed.username) : 'git';
    if (!/^[a-z0-9._-]+$/iu.test(user)) {
      throw new GitRemoteUrlError('UNSUPPORTED_REMOTE_URL', 'The SSH URL has an invalid user.');
    }
    return {
      identity,
      host,
      owner,
      repository,
      transport: 'ssh',
      cloneUrl: `ssh://${user}@${hostWithPort}/${owner}/${repository}.git`,
      upgradedFromHttp: false,
    };
  }

  const upgradedFromHttp = protocol === 'http:';
  return {
    identity,
    host,
    owner,
    repository,
    transport: 'https',
    cloneUrl: `https://${hostWithPort}/${owner}/${repository}.git`,
    upgradedFromHttp,
  };
}

function redactUrlToken(token: string): string {
  const schemeEnd = token.indexOf('://') + 3;
  const pathStartCandidates = [
    token.indexOf('/', schemeEnd),
    token.indexOf('?', schemeEnd),
    token.indexOf('#', schemeEnd),
  ].filter((index) => index >= 0);
  const pathStart =
    pathStartCandidates.length > 0 ? Math.min(...pathStartCandidates) : token.length;
  const authority = token.slice(schemeEnd, pathStart);
  const atIndex = authority.lastIndexOf('@');
  const safeAuthority =
    atIndex >= 0 ? `${REDACTION_MARKER}@${authority.slice(atIndex + 1)}` : authority;
  let suffix = token.slice(pathStart);
  const queryIndex = suffix.indexOf('?');
  const fragmentIndex = suffix.indexOf('#');
  const secretSuffixIndex = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  if (secretSuffixIndex.length > 0) {
    suffix = `${suffix.slice(0, Math.min(...secretSuffixIndex))}?${REDACTION_MARKER}`;
  }
  return `${token.slice(0, schemeEnd)}${safeAuthority}${suffix}`;
}

/** Redact credential-bearing URL components from Git diagnostics before display or serialization. */
export function redactGitCredentials(value: string): string {
  return value
    .replace(URL_WITH_AUTHORITY_PATTERN, redactUrlToken)
    .replace(SCP_PASSWORD_PATTERN, `${REDACTION_MARKER}@$1:$2`)
    .replace(SECRET_ASSIGNMENT_PATTERN, `$1=${REDACTION_MARKER}`);
}

export interface GitProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitProcessOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

export type GitProcessRunner = (
  executable: string,
  arguments_: readonly string[],
  options: GitProcessOptions,
) => Promise<GitProcessResult>;

const defaultProcessRunner: GitProcessRunner = async (executable, arguments_, options) =>
  await new Promise<GitProcessResult>((resolve, reject) => {
    const childOptions = {
      env: options.env,
      windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
    execFile(executable, [...arguments_], childOptions, (error, stdout, stderr) => {
      if (error !== null) {
        Object.assign(error, { stdout, stderr });
        reject(error instanceof Error ? error : new Error('Git exited unsuccessfully.'));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export interface GitClientOptions {
  readonly executable?: string;
  readonly processRunner?: GitProcessRunner;
  readonly safetyDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface GitRunOptions {
  readonly cwd?: string;
  /**
   * Content mode additionally ignores system/global filter configuration. Network
   * mode preserves Git credential helpers and SSH configuration for authentication.
   */
  readonly profile?: 'network' | 'content';
  readonly environment?: NodeJS.ProcessEnv;
}

export type GitExecutionErrorCode = 'GIT_ARGUMENT_REJECTED' | 'GIT_EXECUTION_FAILED';

function errorField(error: unknown, field: 'code' | 'stdout' | 'stderr'): unknown {
  if (typeof error !== 'object' || error === null || !(field in error)) {
    return undefined;
  }
  return Reflect.get(error, field);
}

function stringField(error: unknown, field: 'stdout' | 'stderr'): string {
  const value = errorField(error, field);
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

export class GitExecutionError extends Error {
  readonly code: GitExecutionErrorCode;
  readonly command: readonly string[];
  readonly exitCode: number | string | undefined;
  readonly stderr: string;
  readonly stdout: string;

  constructor(options: {
    readonly code: GitExecutionErrorCode;
    readonly message: string;
    readonly command: readonly string[];
    readonly exitCode?: number | string;
    readonly stderr?: string;
    readonly stdout?: string;
  }) {
    super(redactGitCredentials(options.message));
    this.name = 'GitExecutionError';
    this.code = options.code;
    this.command = options.command.map(redactGitCredentials);
    this.exitCode = options.exitCode;
    this.stderr = redactGitCredentials(options.stderr ?? '');
    this.stdout = redactGitCredentials(options.stdout ?? '');
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      command: this.command,
      exitCode: this.exitCode,
      stderr: this.stderr,
      stdout: this.stdout,
    };
  }
}

function validateGitArguments(arguments_: readonly string[], profile: 'network' | 'content'): void {
  if (arguments_.length === 0) {
    throw new GitExecutionError({
      code: 'GIT_ARGUMENT_REJECTED',
      message: 'A Git subcommand is required.',
      command: [],
    });
  }
  if (arguments_.some((argument) => argument.includes('\u0000'))) {
    throw new GitExecutionError({
      code: 'GIT_ARGUMENT_REJECTED',
      message: 'Git arguments must not contain null bytes.',
      command: arguments_,
    });
  }

  const subcommand = arguments_.find((argument) => !argument.startsWith('-'));
  const requestsSubmodules =
    subcommand === 'submodule' ||
    arguments_.some(
      (argument) =>
        argument === '--recursive' ||
        argument.startsWith('--recurse-submodules') ||
        argument.startsWith('submodule.recurse='),
    );
  if (requestsSubmodules) {
    throw new GitExecutionError({
      code: 'GIT_ARGUMENT_REJECTED',
      message: 'Recursive submodule operations are disabled for skill libraries.',
      command: arguments_,
    });
  }

  const overridesSafetyConfiguration = arguments_.some(
    (argument) =>
      argument.startsWith('-c') ||
      argument.startsWith('--config-env') ||
      argument.startsWith('--exec-path') ||
      argument.startsWith('core.hooksPath=') ||
      argument.startsWith('init.templateDir='),
  );
  if (overridesSafetyConfiguration) {
    throw new GitExecutionError({
      code: 'GIT_ARGUMENT_REJECTED',
      message: 'Per-command Git configuration overrides are not accepted by the safe Git adapter.',
      command: arguments_,
    });
  }

  const cloneCouldCheckout =
    subcommand === 'clone' &&
    !arguments_.includes('--bare') &&
    !arguments_.includes('--no-checkout') &&
    profile !== 'content';
  if (cloneCouldCheckout) {
    throw new GitExecutionError({
      code: 'GIT_ARGUMENT_REJECTED',
      message: 'Network-profile clones must be bare or use --no-checkout.',
      command: arguments_,
    });
  }
}

function commandFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'Git exited unsuccessfully.';
}

/**
 * Execute Git without a shell. Safety configuration is prepended as individual
 * arguments and cannot be overridden by callers.
 */
export class GitClient {
  private readonly executable: string;
  private readonly processRunner: GitProcessRunner;
  private readonly safetyDirectory: string;
  private readonly baseEnvironment: NodeJS.ProcessEnv;

  constructor(options: GitClientOptions = {}) {
    this.executable = options.executable ?? 'git';
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.safetyDirectory = options.safetyDirectory ?? join(tmpdir(), 'skill-sync-git-safety');
    this.baseEnvironment = { ...process.env, ...options.environment };
  }

  async run(arguments_: readonly string[], options: GitRunOptions = {}): Promise<GitProcessResult> {
    const profile = options.profile ?? 'network';
    validateGitArguments(arguments_, profile);
    await this.prepareSafetyDirectory();

    const hooksDirectory = join(this.safetyDirectory, 'hooks-disabled');
    const templateDirectory = join(this.safetyDirectory, 'template-empty');
    const safeArguments = [
      '-c',
      `core.hooksPath=${hooksDirectory}`,
      '-c',
      `init.templateDir=${templateDirectory}`,
      '-c',
      'submodule.recurse=false',
      '-c',
      'fetch.recurseSubmodules=false',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.longpaths=true',
      ...arguments_,
    ];
    const environment: NodeJS.ProcessEnv = {
      ...this.baseEnvironment,
      ...options.environment,
      GIT_ALLOW_PROTOCOL: 'https:ssh:file',
      GIT_ANNEX_SKIP_SMUDGE: '1',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_PAGER: 'cat',
      GIT_PROTOCOL_FROM_USER: '0',
    };
    for (const key of FORBIDDEN_GIT_ENVIRONMENT_KEYS) {
      Reflect.deleteProperty(environment, key);
    }
    for (const key of Object.keys(environment)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key)) {
        Reflect.deleteProperty(environment, key);
      }
    }
    if (profile === 'content') {
      environment.GIT_CONFIG_NOSYSTEM = '1';
      environment.GIT_CONFIG_GLOBAL = join(this.safetyDirectory, 'global-empty.gitconfig');
    }

    try {
      return await this.processRunner(this.executable, safeArguments, {
        env: environment,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      });
    } catch (error) {
      const rawExitCode = errorField(error, 'code');
      const exitCode =
        typeof rawExitCode === 'number' || typeof rawExitCode === 'string'
          ? rawExitCode
          : undefined;
      throw new GitExecutionError({
        code: 'GIT_EXECUTION_FAILED',
        message: commandFailureMessage(error),
        command: [this.executable, ...safeArguments],
        ...(exitCode === undefined ? {} : { exitCode }),
        stderr: stringField(error, 'stderr'),
        stdout: stringField(error, 'stdout'),
      });
    }
  }

  private async prepareSafetyDirectory(): Promise<void> {
    await mkdir(join(this.safetyDirectory, 'hooks-disabled'), { recursive: true });
    await mkdir(join(this.safetyDirectory, 'template-empty'), { recursive: true });
    await writeFile(join(this.safetyDirectory, 'global-empty.gitconfig'), '', { flag: 'a' });
  }
}
