import { readFile } from 'node:fs/promises';
import { homedir as systemHomedir } from 'node:os';
import { posix, win32 } from 'node:path';

import { z } from 'zod';

import { libraryIdentitySchema } from '../domain/project-state.js';
import { writeJsonAtomic } from './stable-json.js';

export const USER_CONFIG_SCHEMA_VERSION = 1 as const;
export const REDACTION_MARKER = '[REDACTED]' as const;

const targetSchema = z.enum(['codex', 'claude']);
const transportSchema = z.enum(['https', 'ssh']);
const gitignorePolicySchema = z.enum(['manage', 'leave']);

function hasCredentialBearingUrl(value: string): boolean {
  if (/^https?:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.username !== '' || url.password !== '') {
        return true;
      }
      for (const key of url.searchParams.keys()) {
        if (/^(?:access[_-]?token|auth|key|password|secret|token)$/iu.test(key)) {
          return true;
        }
      }
    } catch {
      // URL syntax is validated separately. Do not treat malformed input as credential-free.
      return true;
    }
  }
  return false;
}

export class CredentialBearingUrlError extends Error {
  public constructor() {
    super(
      'Repository URLs must not contain credentials. Use a Git credential helper, SSH agent, or authenticated GitHub tooling.',
    );
    this.name = 'CredentialBearingUrlError';
  }
}

/** Refuse secrets without including the supplied value in the resulting error. */
export function assertCredentialFreeRepositoryUrl(value: string): void {
  if (hasCredentialBearingUrl(value)) {
    throw new CredentialBearingUrlError();
  }
}

function isSupportedCredentialFreeRepositoryUrl(value: string): boolean {
  if (/[\r\n\0]/u.test(value) || value.length > 2_048) {
    return false;
  }

  if (/^[^@/:\s]+@[^:/\s]+:[^\s]+$/u.test(value)) {
    return true;
  }

  try {
    const url = new URL(value);
    if (!['https:', 'ssh:'].includes(url.protocol)) {
      return false;
    }
    if (url.hostname === '' || url.hash !== '' || url.search !== '') {
      return false;
    }
    if (url.protocol === 'https:' && (url.username !== '' || url.password !== '')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const credentialFreeRepositoryUrlSchema = z.string().superRefine((value, context) => {
  if (hasCredentialBearingUrl(value)) {
    context.addIssue({
      code: 'custom',
      message: 'Repository URLs must not contain credentials; use external Git authentication.',
    });
    return;
  }
  if (!isSupportedCredentialFreeRepositoryUrl(value)) {
    context.addIssue({
      code: 'custom',
      message: 'Expected a credential-free HTTPS, ssh://, or scp-style SSH repository URL.',
    });
  }
});

const configuredLibrarySchema = z.strictObject({
  branch: z.string().trim().min(1).max(255).optional(),
  identity: libraryIdentitySchema,
  remote: credentialFreeRepositoryUrlSchema,
  transport: transportSchema,
});

export const userConfigSchema = z.strictObject({
  defaults: z
    .strictObject({
      gitignore: gitignorePolicySchema.optional(),
      targets: z.array(targetSchema).max(32).optional(),
    })
    .optional(),
  library: configuredLibrarySchema.optional(),
  schemaVersion: z.literal(USER_CONFIG_SCHEMA_VERSION),
});

export type UserConfig = z.infer<typeof userConfigSchema>;
export type TargetName = z.infer<typeof targetSchema>;
export type GitTransport = z.infer<typeof transportSchema>;
export type GitignorePolicy = z.infer<typeof gitignorePolicySchema>;

export interface ApplicationPaths {
  readonly backupsDirectory: string;
  readonly cacheDirectory: string;
  readonly configDirectory: string;
  readonly configFile: string;
  readonly journalsDirectory: string;
  readonly locksDirectory: string;
  readonly stateDirectory: string;
  readonly globalManifestFile?: string;
  readonly globalLockFile?: string;
  readonly globalStateDirectory?: string;
}

export interface ApplicationPathOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: string;
  readonly platform?: NodeJS.Platform;
}

function nonemptyEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === '' ? undefined : value;
}

/** Resolve all user-owned storage without accessing or creating it. */
export function resolveApplicationPaths(options: ApplicationPathOptions = {}): ApplicationPaths {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const path = platform === 'win32' ? win32 : posix;
  const home = options.homedir ?? systemHomedir();
  const cwd = options.cwd ?? process.cwd();
  const override = nonemptyEnvironmentValue(env, 'SKILL_SYNC_CONFIG_HOME');

  let configDirectory: string;
  let cacheDirectory: string;
  let stateDirectory: string;

  if (override !== undefined) {
    const isolatedRoot = path.resolve(cwd, override);
    configDirectory = isolatedRoot;
    cacheDirectory = path.join(isolatedRoot, 'cache');
    stateDirectory = path.join(isolatedRoot, 'state');
  } else if (platform === 'darwin') {
    configDirectory = path.join(home, 'Library', 'Application Support', 'skill-sync');
    cacheDirectory = path.join(home, 'Library', 'Caches', 'skill-sync');
    stateDirectory = path.join(configDirectory, 'state');
  } else if (platform === 'win32') {
    const roaming =
      nonemptyEnvironmentValue(env, 'APPDATA') ?? path.join(home, 'AppData', 'Roaming');
    const local =
      nonemptyEnvironmentValue(env, 'LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local');
    configDirectory = path.join(roaming, 'skill-sync');
    cacheDirectory = path.join(local, 'skill-sync', 'cache');
    stateDirectory = path.join(local, 'skill-sync', 'state');
  } else {
    const configRoot =
      nonemptyEnvironmentValue(env, 'XDG_CONFIG_HOME') ?? path.join(home, '.config');
    const cacheRoot = nonemptyEnvironmentValue(env, 'XDG_CACHE_HOME') ?? path.join(home, '.cache');
    const stateRoot =
      nonemptyEnvironmentValue(env, 'XDG_STATE_HOME') ?? path.join(home, '.local', 'state');
    configDirectory = path.join(configRoot, 'skill-sync');
    cacheDirectory = path.join(cacheRoot, 'skill-sync');
    stateDirectory = path.join(stateRoot, 'skill-sync');
  }

  return {
    backupsDirectory: path.join(stateDirectory, 'backups'),
    cacheDirectory,
    configDirectory,
    configFile: path.join(configDirectory, 'config.json'),
    journalsDirectory: path.join(stateDirectory, 'journals'),
    locksDirectory: path.join(stateDirectory, 'locks'),
    stateDirectory,
    globalManifestFile: path.join(stateDirectory, 'global', 'skill-sync.json'),
    globalLockFile: path.join(stateDirectory, 'global', 'skill-sync.lock.json'),
    globalStateDirectory: path.join(stateDirectory, 'global'),
  };
}

function canonicalizeTargets(targets: readonly TargetName[] | undefined): TargetName[] | undefined {
  if (targets === undefined) {
    return undefined;
  }
  return [...new Set(targets)].sort((left, right) => left.localeCompare(right));
}

export function parseUserConfig(input: unknown): UserConfig {
  const parsed = userConfigSchema.parse(input);
  return {
    ...(parsed.defaults === undefined
      ? {}
      : {
          defaults: {
            ...(parsed.defaults.gitignore === undefined
              ? {}
              : { gitignore: parsed.defaults.gitignore }),
            ...(parsed.defaults.targets === undefined
              ? {}
              : { targets: canonicalizeTargets(parsed.defaults.targets) }),
          },
        }),
    ...(parsed.library === undefined ? {} : { library: parsed.library }),
    schemaVersion: USER_CONFIG_SCHEMA_VERSION,
  };
}

export async function readUserConfig(path: string): Promise<UserConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  return parseUserConfig(JSON.parse(contents) as unknown);
}

/** Validate before any directory or temporary file is created. */
export async function writeUserConfig(path: string, input: unknown): Promise<UserConfig> {
  const config = parseUserConfig(input);
  await writeJsonAtomic(path, config, { mode: 0o600 });
  return config;
}

export interface ConfigOverrides {
  readonly branch?: string;
  readonly defaultTargets?: readonly TargetName[];
  readonly gitignore?: GitignorePolicy;
  readonly libraryUrl?: string;
  readonly transport?: GitTransport;
}

export interface EffectiveConfig {
  readonly branch?: string;
  readonly defaultTargets: readonly TargetName[];
  readonly gitignore: GitignorePolicy;
  readonly libraryUrl?: string;
  readonly transport: GitTransport;
}

export type ConfigValueSource = 'cli' | 'environment' | 'user' | 'default';

export interface ResolvedConfig {
  readonly sources: Readonly<Record<keyof EffectiveConfig, ConfigValueSource>>;
  readonly value: EffectiveConfig;
}

function selectValue<T>(
  cli: T | undefined,
  environment: T | undefined,
  user: T | undefined,
  fallback: T,
): readonly [T, ConfigValueSource] {
  if (cli !== undefined) return [cli, 'cli'];
  if (environment !== undefined) return [environment, 'environment'];
  if (user !== undefined) return [user, 'user'];
  return [fallback, 'default'];
}

function parseTargetsEnvironment(value: string | undefined): TargetName[] | undefined {
  if (value === undefined) return undefined;
  const targets = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return canonicalizeTargets(z.array(targetSchema).min(1).max(2).parse(targets));
}

function parseEnvironmentOverrides(env: NodeJS.ProcessEnv): ConfigOverrides {
  const branch = nonemptyEnvironmentValue(env, 'SKILL_SYNC_BRANCH');
  const defaultTargets = parseTargetsEnvironment(
    nonemptyEnvironmentValue(env, 'SKILL_SYNC_TARGETS'),
  );
  const transportValue = nonemptyEnvironmentValue(env, 'SKILL_SYNC_TRANSPORT');
  const gitignoreValue = nonemptyEnvironmentValue(env, 'SKILL_SYNC_GITIGNORE');
  const libraryUrl = nonemptyEnvironmentValue(env, 'SKILL_SYNC_LIBRARY');
  if (libraryUrl !== undefined) {
    assertCredentialFreeRepositoryUrl(libraryUrl);
  }

  return {
    ...(branch === undefined ? {} : { branch }),
    ...(defaultTargets === undefined ? {} : { defaultTargets }),
    ...(gitignoreValue === undefined
      ? {}
      : { gitignore: gitignorePolicySchema.parse(gitignoreValue) }),
    ...(libraryUrl === undefined
      ? {}
      : { libraryUrl: credentialFreeRepositoryUrlSchema.parse(libraryUrl) }),
    ...(transportValue === undefined ? {} : { transport: transportSchema.parse(transportValue) }),
  };
}

/** Resolve CLI > environment > user > built-in values without mutating lower layers. */
export function resolveConfiguration(options: {
  readonly cli?: ConfigOverrides;
  readonly env?: NodeJS.ProcessEnv;
  readonly user?: UserConfig;
}): ResolvedConfig {
  const cli = options.cli ?? {};
  const environment = parseEnvironmentOverrides(options.env ?? process.env);
  const user = options.user;

  if (cli.libraryUrl !== undefined) {
    credentialFreeRepositoryUrlSchema.parse(cli.libraryUrl);
  }

  const [branch, branchSource] = selectValue(
    cli.branch,
    environment.branch,
    user?.library?.branch,
    'main',
  );
  const [defaultTargets, targetsSource] = selectValue(
    canonicalizeTargets(cli.defaultTargets),
    environment.defaultTargets,
    canonicalizeTargets(user?.defaults?.targets),
    [],
  );
  const [gitignore, gitignoreSource] = selectValue<GitignorePolicy>(
    cli.gitignore,
    environment.gitignore,
    user?.defaults?.gitignore,
    'leave',
  );
  const [libraryUrl, librarySource] = selectValue(
    cli.libraryUrl,
    environment.libraryUrl,
    user?.library?.remote,
    undefined,
  );
  const [transport, transportSource] = selectValue<GitTransport>(
    cli.transport,
    environment.transport,
    user?.library?.transport,
    'https',
  );

  return {
    sources: {
      branch: branchSource,
      defaultTargets: targetsSource,
      gitignore: gitignoreSource,
      libraryUrl: librarySource,
      transport: transportSource,
    },
    value: {
      branch,
      defaultTargets,
      gitignore,
      ...(libraryUrl === undefined ? {} : { libraryUrl }),
      transport,
    },
  };
}

/** Redact common URL, header, CLI, and provider token forms in dependency diagnostics. */
export function redactCredentials(value: string): string {
  return value
    .replace(/(https?:\/\/)([^/@\s]+)@/giu, `$1${REDACTION_MARKER}@`)
    .replace(
      /([?&](?:access[_-]?token|auth|key|password|secret|token)=)[^&#\s]*/giu,
      `$1${REDACTION_MARKER}`,
    )
    .replace(/\b(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, `$1${REDACTION_MARKER}`)
    .replace(/\b((?:password|secret|token)\s*[=:]\s*)[^\s,;]+/giu, `$1${REDACTION_MARKER}`)
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/gu,
      REDACTION_MARKER,
    );
}
