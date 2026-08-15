import {
  CONFIG_KEYS,
  ConfigService,
  type ConfigKey,
  type ConfigUnsetResult,
  type ConfigurationListing,
} from '../application/config-service.js';
import { runDoctor, type DoctorReport, type DoctorRequest } from '../application/doctor.js';
import {
  EXIT_CODES,
  type CommandResult,
  failure,
  redactSecrets,
  resultFromUnknown,
  SkillSyncError,
  success,
} from '../domain/result.js';
import { formatDoctorReport } from '../ui/doctor-output.js';

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
  unset(key: string): Promise<ConfigUnsetResult>;
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
  if (typeof value === 'string') return value;
  return value.length === 0 ? '<none>' : value.join(', ');
}

const EFFECTIVE_KEYS: Readonly<
  Record<ConfigKey, keyof ConfigurationListing['effective']['value']>
> = {
  'library.remote': 'libraryUrl',
  'library.branch': 'branch',
  'library.transport': 'transport',
  'defaults.targets': 'defaultTargets',
  'defaults.gitignore': 'gitignore',
};

function configKey(value: string): ConfigKey {
  if (!(CONFIG_KEYS as readonly string[]).includes(value)) {
    throw new Error(
      `Unsupported configuration key ${value}. Valid keys: ${CONFIG_KEYS.join(', ')}`,
    );
  }
  return value as ConfigKey;
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
  const configuredCount = CONFIG_KEYS.filter((key) => listing.configured[key] !== null).length;
  const lines = [
    `Configuration path: ${listing.path}`,
    `Configured values: ${String(configuredCount)} of ${String(CONFIG_KEYS.length)}`,
    'Values:',
  ];
  for (const key of CONFIG_KEYS) {
    const effectiveKey = EFFECTIVE_KEYS[key];
    const value = listing.effective.value[effectiveKey];
    const source = listing.effective.sources[effectiveKey];
    lines.push(
      `  Key: ${key}`,
      `    Configured: ${valueText(listing.configured[key])}`,
      `    Effective: ${valueText(value ?? null)}`,
      `    Effective source: ${source}`,
    );
  }
  lines.push('Next: Change a value with skill-sync config set <key> <value>.');
  return lines.join('\n');
}

function formatConfigurationValue(
  heading: string,
  key: ConfigKey,
  listing: ConfigListingData,
  next: string,
): string {
  const effectiveKey = EFFECTIVE_KEYS[key];
  return [
    heading,
    `Key: ${key}`,
    `Configuration path: ${listing.path}`,
    `Configured value: ${valueText(listing.configured[key])}`,
    `Effective value: ${valueText(listing.effective.value[effectiveKey] ?? null)}`,
    `Effective source: ${listing.effective.sources[effectiveKey]}`,
    next,
  ].join('\n');
}

function formatConfigurationUnset(
  key: ConfigKey,
  listing: ConfigListingData,
  result: ConfigUnsetResult,
): string {
  const effectiveKey = EFFECTIVE_KEYS[key];
  const configuredValue = listing.configured[key];
  const heading = !result.changed
    ? 'No configuration change.'
    : result.changedKeys.length === 1 && configuredValue === null
      ? 'Configured value removed.'
      : 'Configuration updated.';
  const next = !result.changed
    ? configuredValue === null
      ? `Next: Set an override with skill-sync config set ${key} <value>.`
      : 'Next: No action is needed; run skill-sync config list to review all effective values.'
    : result.changedKeys.length > 1
      ? 'Next: Run skill-sync config list to review every effective value changed by this coupled update.'
      : `Next: Run skill-sync config get ${key} to verify the effective value.`;
  return [
    heading,
    `Requested key: ${key}`,
    `Changed keys (${String(result.changedKeys.length)}): ${result.changedKeys.length === 0 ? 'none' : result.changedKeys.join(', ')}`,
    `Configuration path: ${listing.path}`,
    `Configured value now: ${valueText(configuredValue)}`,
    `Effective value now: ${valueText(listing.effective.value[effectiveKey] ?? null)}`,
    `Effective source now: ${listing.effective.sources[effectiveKey]}`,
    next,
  ].join('\n');
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
  if (invocation.options.global === true && typeof project === 'string') {
    throw new SkillSyncError(
      'CONFLICTING_SCOPE_OPTIONS',
      'Pass either --global or --project, not both.',
      EXIT_CODES.usage,
    );
  }
  return {
    ...(invocation.options.global === true ? { global: true } : {}),
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
    ...(report.globalStateDirectory === undefined
      ? {}
      : { globalStateDirectory: redactSecrets(report.globalStateDirectory) }),
    offline: report.offline,
    ...(report.projectRoot === undefined ? {} : { projectRoot: redactSecrets(report.projectRoot) }),
    ...(report.scope === undefined ? {} : { scope: report.scope }),
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
  const requestDoctor = dependencies.doctorRequest ?? defaultDoctorRequest;

  return async (invocation) => {
    if (!HANDLED_COMMANDS.has(invocation.command)) return undefined;
    const json = jsonRequested(invocation);

    if (invocation.command === 'doctor') {
      try {
        const report = normalizedDoctorReport(await diagnose(requestDoctor(invocation)));
        const humanReport =
          dependencies.formatDoctor === undefined
            ? formatDoctorReport(report, {
                color: invocation.options.color === true,
                explicitProject: typeof invocation.options.project === 'string',
              })
            : dependencies.formatDoctor(report);
        return doctorResult(report, redactSecrets(humanReport), json);
      } catch (error) {
        return resultFromUnknown(error);
      }
    }

    try {
      switch (invocation.command) {
        case 'config:path': {
          const path = config.path();
          return success(
            json
              ? { path }
              : [
                  `Configuration path: ${path}`,
                  'Next: Run skill-sync config list to inspect configured and effective values.',
                ].join('\n'),
          );
        }
        case 'config:list': {
          const listing = listingData(await config.list());
          return success(json ? listing : formatConfigurationListing(listing));
        }
        case 'config:get': {
          const key = argument(invocation, 0, 'configuration key');
          if (typeof key !== 'string') return key;
          const value = (await config.get(key)) ?? null;
          if (json) return success({ key, configured: value !== null, value });
          const selectedKey = configKey(key);
          const listing = listingData(await config.list());
          const next =
            value === null
              ? `Next: Set it with skill-sync config set ${selectedKey} <value>.`
              : `Next: Change it with skill-sync config set ${selectedKey} <value>, or remove the override with skill-sync config unset ${selectedKey}.`;
          return success(
            formatConfigurationValue('Configuration value.', selectedKey, listing, next),
          );
        }
        case 'config:set': {
          const key = argument(invocation, 0, 'configuration key');
          if (typeof key !== 'string') return key;
          const rawValue = argument(invocation, 1, 'configuration value');
          if (typeof rawValue !== 'string') return rawValue;
          await config.set(key, rawValue);
          const value = (await config.get(key)) ?? null;
          if (json) return success({ key, value });
          const selectedKey = configKey(key);
          const listing = listingData(await config.list());
          return success(
            formatConfigurationValue(
              'Configuration updated.',
              selectedKey,
              listing,
              `Next: Run skill-sync config get ${selectedKey} to verify the effective value.`,
            ),
          );
        }
        case 'config:unset': {
          const key = argument(invocation, 0, 'configuration key');
          if (typeof key !== 'string') return key;
          const result = await config.unset(key);
          if (json) {
            return success({
              key,
              unset: result.changed,
              changed: result.changed,
              changedKeys: result.changedKeys,
            });
          }
          const selectedKey = configKey(key);
          const listing = listingData(await config.list());
          return success(formatConfigurationUnset(selectedKey, listing, result));
        }
      }
    } catch (error) {
      return configFailure(error);
    }
  };
}
