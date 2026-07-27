import {
  CONFIG_KEYS,
  ConfigService,
  type ConfigKey,
  type ConfigurationListing,
} from '../application/config-service.js';
import {
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
  type DoctorRequest,
} from '../application/doctor.js';
import {
  EXIT_CODES,
  type CommandResult,
  failure,
  redactSecrets,
  resultFromUnknown,
  SkillSyncError,
  success,
} from '../domain/result.js';

export interface ExtensibleCommandInvocation {
  readonly command: string;
  readonly arguments: readonly unknown[];
  readonly options: Readonly<Record<string, unknown>>;
}

export type OptionalCommandHandler = (
  invocation: ExtensibleCommandInvocation,
) => Promise<CommandResult<unknown> | undefined>;

type ConfigValue = string | readonly string[];

export interface ConfigCommandService {
  path(): string;
  list(): Promise<ConfigurationListing>;
  get(key: string): Promise<ConfigValue | undefined>;
  set(key: string, value: string): Promise<unknown>;
  unset(key: string): Promise<unknown>;
}

export interface ConfigListingData {
  readonly path: string;
  readonly configured: Readonly<Record<ConfigKey, ConfigValue | null>>;
  readonly effective: ConfigurationListing['effective'];
}

export interface ConfigDoctorHandlerDependencies {
  readonly config?: ConfigCommandService;
  readonly doctorRequest?: (invocation: ExtensibleCommandInvocation) => DoctorRequest;
  readonly formatDoctor?: (report: DoctorReport) => string;
  readonly runDoctor?: (request: DoctorRequest) => Promise<DoctorReport>;
}

const HANDLED_COMMANDS = new Set([
  'config:path',
  'config:list',
  'config:get',
  'config:set',
  'config:unset',
  'doctor',
]);

function jsonRequested(invocation: ExtensibleCommandInvocation): boolean {
  return invocation.options.json === true;
}

function argument(
  invocation: ExtensibleCommandInvocation,
  index: number,
  description: string,
): string | CommandResult<never> {
  const value = invocation.arguments[index];
  if (typeof value !== 'string' || value.length === 0) {
    return failure(
      { code: 'MISSING_ARGUMENT', message: `${description} is required.` },
      EXIT_CODES.usage,
    );
  }
  return value;
}

function valueText(value: ConfigValue | null): string {
  if (value === null) return '<unset>';
  return typeof value === 'string' ? value : value.join(', ');
}

function listingData(listing: ConfigurationListing): ConfigListingData {
  return {
    path: listing.path,
    configured: {
      'library.remote': listing.configured['library.remote'] ?? null,
      'library.branch': listing.configured['library.branch'] ?? null,
      'library.transport': listing.configured['library.transport'] ?? null,
      'defaults.targets': listing.configured['defaults.targets'] ?? null,
      'defaults.gitignore': listing.configured['defaults.gitignore'] ?? null,
    },
    effective: listing.effective,
  };
}

export function formatConfigurationListing(listing: ConfigListingData): string {
  const effectiveKeys: Readonly<Record<ConfigKey, keyof ConfigListingData['effective']['value']>> =
    {
      'library.remote': 'libraryUrl',
      'library.branch': 'branch',
      'library.transport': 'transport',
      'defaults.targets': 'defaultTargets',
      'defaults.gitignore': 'gitignore',
    };
  const lines = [`Configuration: ${listing.path}`, 'Configured:'];
  for (const key of CONFIG_KEYS) {
    lines.push(`  ${key} = ${valueText(listing.configured[key])}`);
  }
  lines.push('Effective:');
  for (const key of CONFIG_KEYS) {
    const effectiveKey = effectiveKeys[key];
    const value = listing.effective.value[effectiveKey];
    const source = listing.effective.sources[effectiveKey];
    lines.push(`  ${key} = ${valueText(value ?? null)} (${source})`);
  }
  return lines.join('\n');
}

function configFailure(error: unknown): CommandResult<never> {
  if (error instanceof SkillSyncError) return resultFromUnknown(error);
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  return failure(
    {
      code: 'CONFIG_VALIDATION_FAILED',
      message: message.length === 0 ? 'The configuration value is invalid.' : message,
    },
    EXIT_CODES.validation,
  );
}

function defaultDoctorRequest(invocation: ExtensibleCommandInvocation): DoctorRequest {
  const project = invocation.options.project;
  return {
    offline: invocation.options.offline === true,
    ...(typeof project === 'string' ? { project } : {}),
  };
}

function normalizedDoctorReport(report: DoctorReport): DoctorReport {
  const checks = report.checks.map((check) => ({
    ...check,
    message: redactSecrets(check.message),
    ...(check.remediation === undefined ? {} : { remediation: redactSecrets(check.remediation) }),
  }));
  const hasLocalFailure = checks.some(
    (check) => check.status === 'fail' && check.scope === 'local',
  );
  const hasRemoteFailure = checks.some(
    (check) => check.status === 'fail' && check.scope === 'remote',
  );
  return {
    offline: report.offline,
    ...(report.projectRoot === undefined ? {} : { projectRoot: redactSecrets(report.projectRoot) }),
    checks,
    exitCode: hasLocalFailure
      ? EXIT_CODES.validation
      : hasRemoteFailure
        ? EXIT_CODES.repository
        : EXIT_CODES.success,
  };
}

function doctorResult(
  report: DoctorReport,
  humanReport: string,
  json: boolean,
): CommandResult<unknown> {
  if (report.exitCode === EXIT_CODES.success) {
    return success(json ? report : humanReport);
  }
  const localFailure = report.exitCode === EXIT_CODES.validation;
  return failure(
    {
      code: localFailure ? 'DOCTOR_LOCAL_FAILURE' : 'DOCTOR_REMOTE_FAILURE',
      message: json
        ? localFailure
          ? 'Doctor found one or more local validation failures.'
          : 'Doctor found one or more repository-access failures.'
        : humanReport,
      ...(json ? { details: { report } } : {}),
    },
    report.exitCode,
  );
}

export function createConfigDoctorCommandHandler(
  dependencies: ConfigDoctorHandlerDependencies = {},
): OptionalCommandHandler {
  const config = dependencies.config ?? new ConfigService();
  const diagnose = dependencies.runDoctor ?? runDoctor;
  const formatDoctor = dependencies.formatDoctor ?? formatDoctorReport;
  const requestDoctor = dependencies.doctorRequest ?? defaultDoctorRequest;

  return async (invocation) => {
    if (!HANDLED_COMMANDS.has(invocation.command)) return undefined;
    const json = jsonRequested(invocation);

    if (invocation.command === 'doctor') {
      try {
        const report = normalizedDoctorReport(await diagnose(requestDoctor(invocation)));
        return doctorResult(report, redactSecrets(formatDoctor(report)), json);
      } catch (error) {
        return resultFromUnknown(error);
      }
    }

    try {
      switch (invocation.command) {
        case 'config:path': {
          const path = config.path();
          return success(json ? { path } : path);
        }
        case 'config:list': {
          const listing = listingData(await config.list());
          return success(json ? listing : formatConfigurationListing(listing));
        }
        case 'config:get': {
          const key = argument(invocation, 0, 'configuration key');
          if (typeof key !== 'string') return key;
          const value = (await config.get(key)) ?? null;
          return success(json ? { key, configured: value !== null, value } : valueText(value));
        }
        case 'config:set': {
          const key = argument(invocation, 0, 'configuration key');
          if (typeof key !== 'string') return key;
          const rawValue = argument(invocation, 1, 'configuration value');
          if (typeof rawValue !== 'string') return rawValue;
          await config.set(key, rawValue);
          const value = (await config.get(key)) ?? null;
          return success(json ? { key, value } : `Set ${key} = ${valueText(value)}.`);
        }
        case 'config:unset': {
          const key = argument(invocation, 0, 'configuration key');
          if (typeof key !== 'string') return key;
          await config.unset(key);
          return success(json ? { key, unset: true } : `Unset ${key}.`);
        }
      }
    } catch (error) {
      return configFailure(error);
    }
  };
}
