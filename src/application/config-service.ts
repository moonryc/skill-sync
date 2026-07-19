import {
  USER_CONFIG_SCHEMA_VERSION,
  readUserConfig,
  resolveApplicationPaths,
  resolveConfiguration,
  writeUserConfig,
  type ApplicationPaths,
  type UserConfig,
} from '../infrastructure/config.js';
import { normalizeGitRemote } from '../infrastructure/git.js';

export const CONFIG_KEYS = [
  'library.remote',
  'library.branch',
  'library.transport',
  'defaults.targets',
  'defaults.gitignore',
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

function emptyConfig(): UserConfig {
  return { schemaVersion: USER_CONFIG_SCHEMA_VERSION };
}

function requireKey(value: string): ConfigKey {
  if (!isConfigKey(value)) {
    throw new Error(
      `Unsupported configuration key ${value}. Valid keys: ${CONFIG_KEYS.join(', ')}`,
    );
  }
  return value;
}

function cloneUrlForTransport(
  remote: ReturnType<typeof normalizeGitRemote>,
  transport: 'https' | 'ssh',
) {
  return transport === 'https'
    ? `https://${remote.host}/${remote.owner}/${remote.repository}.git`
    : `git@${remote.host}:${remote.owner}/${remote.repository}.git`;
}

function parseTargets(value: string): ('codex' | 'claude')[] {
  const targets = [...new Set(value.split(',').map((target) => target.trim()))].filter(
    (target) => target.length > 0,
  );
  if (targets.length === 0 || targets.some((target) => !['codex', 'claude'].includes(target))) {
    throw new Error('defaults.targets must be a comma-separated list containing codex or claude.');
  }
  return targets.sort() as ('codex' | 'claude')[];
}

export interface ConfigurationListing {
  readonly path: string;
  readonly configured: Readonly<Record<ConfigKey, string | readonly string[] | undefined>>;
  readonly effective: ReturnType<typeof resolveConfiguration>;
}

export class ConfigService {
  readonly paths: ApplicationPaths;

  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    paths: ApplicationPaths = resolveApplicationPaths({ env: environment }),
  ) {
    this.paths = paths;
  }

  path(): string {
    return this.paths.configFile;
  }

  async read(): Promise<UserConfig> {
    return (await readUserConfig(this.paths.configFile)) ?? emptyConfig();
  }

  async list(): Promise<ConfigurationListing> {
    const user = await this.read();
    return {
      path: this.path(),
      configured: {
        'library.remote': user.library?.remote,
        'library.branch': user.library?.branch,
        'library.transport': user.library?.transport,
        'defaults.targets': user.defaults?.targets,
        'defaults.gitignore': user.defaults?.gitignore,
      },
      effective: resolveConfiguration({ env: this.environment, user }),
    };
  }

  async get(keyValue: string): Promise<string | readonly string[] | undefined> {
    const key = requireKey(keyValue);
    return (await this.list()).configured[key];
  }

  async set(keyValue: string, rawValue: string): Promise<UserConfig> {
    const key = requireKey(keyValue);
    const current = await this.read();
    let next: UserConfig;

    switch (key) {
      case 'library.remote': {
        const remote = normalizeGitRemote(rawValue);
        next = {
          ...current,
          library: {
            ...(current.library?.branch === undefined ? {} : { branch: current.library.branch }),
            identity: remote.identity,
            remote: remote.cloneUrl,
            transport: remote.transport,
          },
        };
        break;
      }
      case 'library.branch': {
        if (current.library === undefined) throw new Error('Configure library.remote first.');
        const branch = rawValue.trim();
        if (branch.length === 0 || branch.length > 255 || /[\0\r\n]/u.test(branch)) {
          throw new Error('library.branch must be a nonempty portable Git branch name.');
        }
        next = { ...current, library: { ...current.library, branch } };
        break;
      }
      case 'library.transport': {
        if (current.library === undefined) throw new Error('Configure library.remote first.');
        if (rawValue !== 'https' && rawValue !== 'ssh') {
          throw new Error('library.transport must be https or ssh.');
        }
        const remote = normalizeGitRemote(current.library.remote);
        next = {
          ...current,
          library: {
            ...current.library,
            remote: cloneUrlForTransport(remote, rawValue),
            transport: rawValue,
          },
        };
        break;
      }
      case 'defaults.targets': {
        next = {
          ...current,
          defaults: { ...current.defaults, targets: parseTargets(rawValue) },
        };
        break;
      }
      case 'defaults.gitignore': {
        if (rawValue !== 'manage' && rawValue !== 'leave') {
          throw new Error('defaults.gitignore must be manage or leave.');
        }
        next = { ...current, defaults: { ...current.defaults, gitignore: rawValue } };
        break;
      }
    }

    return await writeUserConfig(this.paths.configFile, next);
  }

  async unset(keyValue: string): Promise<UserConfig> {
    const key = requireKey(keyValue);
    const current = await this.read();
    let next: UserConfig = current;

    if (key === 'library.remote') {
      next = {
        schemaVersion: current.schemaVersion,
        ...(current.defaults === undefined ? {} : { defaults: current.defaults }),
      };
    } else if (key === 'library.branch' && current.library !== undefined) {
      next = {
        ...current,
        library: {
          identity: current.library.identity,
          remote: current.library.remote,
          transport: current.library.transport,
        },
      };
    } else if (key === 'library.transport' && current.library !== undefined) {
      const remote = normalizeGitRemote(current.library.remote);
      next = {
        ...current,
        library: {
          ...current.library,
          remote: cloneUrlForTransport(remote, 'https'),
          transport: 'https',
        },
      };
    } else if (key.startsWith('defaults.') && current.defaults !== undefined) {
      const defaults = { ...current.defaults };
      if (key === 'defaults.targets') delete defaults.targets;
      if (key === 'defaults.gitignore') delete defaults.gitignore;
      next =
        Object.keys(defaults).length === 0
          ? {
              schemaVersion: current.schemaVersion,
              ...(current.library === undefined ? {} : { library: current.library }),
            }
          : { ...current, defaults };
    }

    return await writeUserConfig(this.paths.configFile, next);
  }
}
