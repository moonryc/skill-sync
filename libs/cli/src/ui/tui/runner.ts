import { createElement } from 'react';
import { render } from 'ink';

import {
  inspectGlobalUnmanagedSkills,
  inspectProjectUnmanagedSkills,
} from '../../application/unmanaged-skill-inventory.js';
import { INIT_PLAN_FINGERPRINT_PATTERN } from '../../application/init-plan.js';
import { INSTALL_PLAN_FINGERPRINT_PATTERN } from '../../application/install-plan.js';
import { resolveApplicationPaths } from '../../infrastructure/config.js';
import { readProjectManifest } from '../../infrastructure/project-state.js';
import {
  EXIT_CODES,
  failure,
  SkillSyncError,
  success,
  type CommandResult,
} from '../../domain/result.js';
import type { RuntimeIo } from '../../ports/index.js';
import type { CommandExecutor, CommandInvocation } from '../../commands/program.js';
import { TuiApp } from './app.js';
import { terminalSafe } from './sanitize.js';
import type {
  TuiActionPort,
  TuiDashboard,
  TuiDoctorCheckStatus,
  TuiDoctorIssue,
  TuiDoctorSummary,
  TuiInventorySkill,
  TuiInstallGitignorePreview,
  TuiInstallPreview,
  TuiInstallProjection,
  TuiInstallSkillPreview,
  TuiLibraryInitPlan,
  TuiLibrarySetupIntent,
  TuiLauncher,
  TuiLaunchRequest,
  TuiManagedSkill,
  TuiReleaseUpdate,
  TuiSkill,
  TuiTarget,
} from './types.js';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback = ''): string {
  return terminalSafe(typeof value === 'string' ? value : fallback);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function hasErrorCode(result: CommandResult<unknown>, code: string): boolean {
  return !result.ok && result.errors.some((error) => error.code === code);
}

function errorMessages(
  result: CommandResult<unknown>,
  excludedCodes: ReadonlySet<string> = new Set(),
): readonly string[] {
  return result.ok
    ? []
    : result.errors
        .filter((error) => !excludedCodes.has(error.code))
        .map((error) => terminalSafe(`${error.code}: ${error.message}`));
}

function asSkills(result: CommandResult<unknown>): readonly TuiSkill[] {
  if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.skills)) return [];
  return result.data.skills.flatMap((entry): readonly TuiSkill[] => {
    if (!isRecord(entry)) return [];
    const id = asString(entry.id);
    if (id === '') return [];
    return [
      {
        compatibleAgents: strings(entry.compatibleAgents),
        description: asString(entry.description, 'No description provided.'),
        group: typeof entry.group === 'string' ? entry.group : null,
        id,
        installationState: asString(entry.installationState, 'not-installed'),
        name: asString(entry.name, id.split('/').at(-1) ?? id),
      },
    ];
  });
}

function asManaged(result: CommandResult<unknown>): readonly TuiManagedSkill[] {
  if (!result.ok || !isRecord(result.data) || !Array.isArray(result.data.skills)) return [];
  return result.data.skills.flatMap((entry): readonly TuiManagedSkill[] => {
    if (!isRecord(entry)) return [];
    const id = asString(entry.id);
    if (id === '') return [];
    return [{ id, state: asString(entry.state, 'unknown') }];
  });
}

function asProjectRoot(result: CommandResult<unknown>): string | undefined {
  if (!result.ok || !isRecord(result.data)) return undefined;
  const root = result.data.projectRoot;
  return typeof root === 'string' && root.length > 0 ? root : undefined;
}

function asEffectiveGitignoreManaged(result: CommandResult<unknown> | undefined): boolean {
  if (!result?.ok || !isRecord(result.data)) return false;
  const effective = result.data.effective;
  if (!isRecord(effective) || !isRecord(effective.value)) return false;
  return effective.value.gitignore === 'manage';
}

function asEffectiveDefaultTargets(
  result: CommandResult<unknown> | undefined,
): readonly TuiTarget[] {
  if (!result?.ok || !isRecord(result.data)) return [];
  const effective = result.data.effective;
  if (!isRecord(effective) || !isRecord(effective.value)) return [];
  const targets = effective.value.defaultTargets;
  if (
    !Array.isArray(targets) ||
    targets.length > 2 ||
    targets.some((target) => target !== 'claude' && target !== 'codex') ||
    new Set(targets).size !== targets.length
  ) {
    return [];
  }
  return targets
    .map((target): TuiTarget => (target === 'claude' ? 'claude' : 'codex'))
    .sort(compareText);
}

async function projectGitignoreManaged(
  root: string | undefined,
  configuration: CommandResult<unknown> | undefined,
): Promise<boolean> {
  if (root !== undefined) {
    const manifest = await readProjectManifest(root);
    if (manifest !== undefined) return manifest.gitignore === 'managed';
  }
  return asEffectiveGitignoreManaged(configuration);
}

function asReleaseUpdate(result: CommandResult<unknown>): TuiReleaseUpdate | undefined {
  if (!result.ok || !isRecord(result.data)) return undefined;
  const availableVersion = result.data.availableVersion;
  const installedVersion = result.data.installedVersion;
  if (
    typeof availableVersion !== 'string' ||
    availableVersion.length === 0 ||
    typeof installedVersion !== 'string' ||
    installedVersion.length === 0
  ) {
    return undefined;
  }
  return { availableVersion, installedVersion };
}

const DOCTOR_STATUS_ORDER: Readonly<Record<Exclude<TuiDoctorCheckStatus, 'pass'>, number>> = {
  fail: 0,
  warning: 1,
  skipped: 2,
};

function isDoctorStatus(value: unknown): value is TuiDoctorCheckStatus {
  return value === 'pass' || value === 'warning' || value === 'fail' || value === 'skipped';
}

function parseDoctorIssue(value: unknown):
  | {
      readonly id: string;
      readonly message: string;
      readonly remediation?: string;
      readonly scope: 'local' | 'remote';
      readonly status: TuiDoctorCheckStatus;
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const id = asString(value.id);
  const message = asString(value.message);
  const remediation = value.remediation === undefined ? undefined : asString(value.remediation);
  if (
    id === '' ||
    message === '' ||
    !isDoctorStatus(value.status) ||
    (value.scope !== 'local' && value.scope !== 'remote') ||
    (value.status !== 'pass' && (remediation === undefined || remediation === ''))
  ) {
    return undefined;
  }
  return {
    id,
    message,
    ...(remediation === undefined ? {} : { remediation }),
    scope: value.scope,
    status: value.status,
  };
}

function invalidDoctorSummary(reason: string): CommandResult<TuiDoctorSummary> {
  return failure(
    {
      code: 'INVALID_DOCTOR_REPORT',
      message: `The doctor command returned an invalid diagnostic report: ${reason}`,
    },
    EXIT_CODES.internal,
  );
}

function doctorReportValue(result: CommandResult<unknown>): unknown {
  if (result.ok) return result.data;
  for (const error of result.errors) {
    const report = error.details?.report;
    if (report !== undefined) return report;
  }
  return undefined;
}

/** Normalize both successful doctor data and the structured report attached to doctor failures. */
export function parseTuiDoctorSummaryResult(
  result: CommandResult<unknown>,
): CommandResult<TuiDoctorSummary> {
  const report = doctorReportValue(result);
  if (report === undefined) {
    return result.ok ? invalidDoctorSummary('the report was missing.') : result;
  }
  if (
    !isRecord(report) ||
    typeof report.offline !== 'boolean' ||
    (report.scope !== 'global' && report.scope !== 'project') ||
    !Array.isArray(report.checks)
  ) {
    return invalidDoctorSummary('scope, offline mode, or checks were missing.');
  }

  const checks = report.checks.map(parseDoctorIssue);
  if (checks.some((check) => check === undefined)) {
    return invalidDoctorSummary('one or more checks were malformed or lacked remediation.');
  }
  const normalized = checks as Exclude<(typeof checks)[number], undefined>[];
  const counts: Record<TuiDoctorCheckStatus, number> = {
    fail: 0,
    pass: 0,
    skipped: 0,
    warning: 0,
  };
  for (const check of normalized) counts[check.status] += 1;
  const issues = normalized
    .filter(
      (check): check is typeof check & { readonly status: Exclude<TuiDoctorCheckStatus, 'pass'> } =>
        check.status !== 'pass',
    )
    .map((check): TuiDoctorIssue => ({
      id: check.id,
      message: check.message,
      remediation: check.remediation ?? 'Rerun skill-sync doctor for remediation guidance.',
      scope: check.scope,
      status: check.status,
    }))
    .sort(
      (left, right) =>
        DOCTOR_STATUS_ORDER[left.status] - DOCTOR_STATUS_ORDER[right.status] ||
        compareText(left.id, right.id),
    );
  const locationValue =
    report.scope === 'global' ? report.globalStateDirectory : report.projectRoot;
  const location = typeof locationValue === 'string' ? asString(locationValue) : undefined;
  return success({
    counts,
    issues,
    ...(location === undefined || location === '' ? {} : { location }),
    offline: report.offline,
    scope: report.scope,
  });
}

function invalidInitPreview(reason: string): CommandResult<TuiLibraryInitPlan> {
  return failure(
    {
      code: 'INVALID_INIT_PREVIEW',
      message: `The init dry-run returned an invalid review plan: ${reason}`,
    },
    EXIT_CODES.internal,
  );
}

/** Validate and normalize the JSON contract returned by `init --dry-run`. */
export function parseTuiLibraryInitPlanResult(
  result: CommandResult<unknown>,
): CommandResult<TuiLibraryInitPlan> {
  if (!result.ok) return result;
  const data = result.data;
  if (
    !isRecord(data) ||
    data.applied !== false ||
    data.dryRun !== true ||
    data.operation !== 'init' ||
    (data.action !== 'connect' && data.action !== 'create' && data.action !== 'initialize-empty') ||
    (data.remoteState !== 'available' &&
      data.remoteState !== 'compatible' &&
      data.remoteState !== 'empty') ||
    !isRecord(data.remote) ||
    !isRecord(data.configuration) ||
    !isRecord(data.effects)
  ) {
    return invalidInitPreview('expected an unapplied init plan with a recognized action.');
  }
  const fingerprint = requiredString(data, 'fingerprint');
  const branch = requiredString(data, 'branch');
  const cloneUrl = requiredString(data.remote, 'cloneUrl');
  const identity = requiredString(data.remote, 'identity');
  const transport = data.remote.transport;
  const revision = data.revision;
  const repository = data.repository;
  const visibility = data.visibility;
  if (
    fingerprint === undefined ||
    !INIT_PLAN_FINGERPRINT_PATTERN.test(fingerprint) ||
    branch === undefined ||
    cloneUrl === undefined ||
    identity === undefined ||
    (transport !== 'https' && transport !== 'ssh') ||
    typeof data.configuration.changed !== 'boolean' ||
    data.effects.cache !== 'refresh' ||
    (data.effects.configuration !== 'none' && data.effects.configuration !== 'write') ||
    (data.effects.githubRepository !== 'none' && data.effects.githubRepository !== 'create') ||
    (data.effects.remoteLibrary !== 'none' && data.effects.remoteLibrary !== 'initialize') ||
    (revision !== null && typeof revision !== 'string') ||
    (repository !== null && typeof repository !== 'string') ||
    (visibility !== null &&
      visibility !== 'private' &&
      visibility !== 'public' &&
      visibility !== 'internal')
  ) {
    return invalidInitPreview('required remote, configuration, or effect fields were missing.');
  }
  let validation: TuiLibraryInitPlan['validation'] = null;
  if (data.validation !== null) {
    if (
      !isRecord(data.validation) ||
      !Number.isInteger(data.validation.groups) ||
      !Number.isInteger(data.validation.skills) ||
      Number(data.validation.groups) < 0 ||
      Number(data.validation.skills) < 0
    ) {
      return invalidInitPreview('library validation counts were malformed.');
    }
    validation = {
      groups: Number(data.validation.groups),
      skills: Number(data.validation.skills),
    };
  }
  const expectedShape =
    (data.action === 'connect' &&
      data.remoteState === 'compatible' &&
      typeof revision === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision) &&
      validation !== null &&
      repository === null &&
      visibility === null &&
      data.effects.githubRepository === 'none' &&
      data.effects.remoteLibrary === 'none') ||
    (data.action === 'initialize-empty' &&
      data.remoteState === 'empty' &&
      revision === null &&
      validation === null &&
      repository === null &&
      visibility === null &&
      data.effects.githubRepository === 'none' &&
      data.effects.remoteLibrary === 'initialize') ||
    (data.action === 'create' &&
      data.remoteState === 'available' &&
      revision === null &&
      validation === null &&
      typeof repository === 'string' &&
      repository.length > 0 &&
      visibility !== null &&
      data.effects.githubRepository === 'create' &&
      data.effects.remoteLibrary === 'initialize');
  if (!expectedShape) {
    return invalidInitPreview('the action, remote state, and effects did not agree.');
  }
  if (data.effects.configuration !== (data.configuration.changed ? 'write' : 'none')) {
    return invalidInitPreview('the configuration change and effect did not agree.');
  }
  return success({
    action: data.action,
    branch,
    configurationChanged: data.configuration.changed,
    effects: {
      cache: 'refresh',
      configuration: data.effects.configuration,
      githubRepository: data.effects.githubRepository,
      remoteLibrary: data.effects.remoteLibrary,
    },
    fingerprint,
    remote: {
      cloneUrl: terminalSafe(cloneUrl),
      identity: terminalSafe(identity),
      transport,
    },
    remoteState: data.remoteState,
    repository: repository === null ? null : terminalSafe(repository),
    revision,
    validation,
    visibility,
  });
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    return undefined;
  }
  return value as readonly string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidInstallPreview(reason: string): CommandResult<TuiInstallPreview> {
  return failure(
    {
      code: 'INVALID_INSTALL_PREVIEW',
      message: `The install dry-run returned an invalid review plan: ${reason}`,
    },
    EXIT_CODES.internal,
  );
}

function parseInstallProjection(value: unknown): TuiInstallProjection | undefined {
  if (!isRecord(value)) return undefined;
  const destination = requiredString(value, 'destination');
  const target = requiredString(value, 'target');
  if (destination === undefined || target === undefined || typeof value.write !== 'boolean') {
    return undefined;
  }
  return { destination, target, write: value.write };
}

function parseInstallSkill(value: unknown): TuiInstallSkillPreview | undefined {
  if (!isRecord(value) || !Array.isArray(value.projections)) return undefined;
  const digest = requiredString(value, 'digest');
  const id = requiredString(value, 'id');
  const status = requiredString(value, 'status');
  const projections = value.projections.map(parseInstallProjection);
  if (
    digest === undefined ||
    id === undefined ||
    status === undefined ||
    projections.some((projection) => projection === undefined)
  ) {
    return undefined;
  }
  return {
    digest,
    id,
    projections: (projections as TuiInstallProjection[]).sort(
      (left, right) =>
        compareText(left.target, right.target) || compareText(left.destination, right.destination),
    ),
    status,
  };
}

function parseGitignorePreview(
  scope: 'global' | 'project',
  value: unknown,
): TuiInstallGitignorePreview | undefined {
  if (scope === 'global') return { applicable: false, changed: false };
  if (!isRecord(value)) return undefined;
  const path = requiredString(value, 'path');
  if (
    path === undefined ||
    typeof value.before !== 'string' ||
    typeof value.after !== 'string' ||
    typeof value.changed !== 'boolean' ||
    value.changed !== (value.before !== value.after)
  ) {
    return undefined;
  }
  return {
    after: value.after,
    applicable: true,
    before: value.before,
    changed: value.changed,
    path,
  };
}

/** Validate and normalize the JSON contract returned by `install --dry-run`. */
export function parseTuiInstallPreviewResult(
  result: CommandResult<unknown>,
): CommandResult<TuiInstallPreview> {
  if (!result.ok) return result;
  const data = result.data;
  if (
    !isRecord(data) ||
    data.applied !== false ||
    data.dryRun !== true ||
    data.operation !== 'install' ||
    (data.scope !== 'global' && data.scope !== 'project')
  ) {
    return invalidInstallPreview('expected an unapplied install plan with a recognized scope.');
  }
  const scope = data.scope;
  const fingerprint = requiredString(data, 'fingerprint');
  const freshness = requiredString(data, 'freshness');
  const libraryRevision = requiredString(data, 'libraryRevision');
  const location = requiredString(data, scope === 'global' ? 'stateDirectory' : 'projectRoot');
  const writes = stringArray(data.writes);
  const gitignore = parseGitignorePreview(scope, data.gitignore);
  if (
    fingerprint === undefined ||
    !INSTALL_PLAN_FINGERPRINT_PATTERN.test(fingerprint) ||
    freshness === undefined ||
    libraryRevision === undefined ||
    location === undefined ||
    writes === undefined ||
    gitignore === undefined ||
    typeof data.stale !== 'boolean' ||
    !isRecord(data.state) ||
    typeof data.state.lockChanged !== 'boolean' ||
    typeof data.state.manifestChanged !== 'boolean' ||
    !Array.isArray(data.skills)
  ) {
    return invalidInstallPreview('required revision, path, state, or write fields were missing.');
  }
  const skills = data.skills.map(parseInstallSkill);
  if (skills.some((skill) => skill === undefined)) {
    return invalidInstallPreview('a selected skill or destination was malformed.');
  }
  const normalizedSkills = skills as TuiInstallSkillPreview[];
  if (new Set(normalizedSkills.map((skill) => skill.id)).size !== normalizedSkills.length) {
    return invalidInstallPreview('a selected skill appeared more than once.');
  }

  return success({
    fingerprint,
    freshness,
    gitignore,
    libraryRevision,
    location,
    scope,
    skills: normalizedSkills.sort((left, right) => compareText(left.id, right.id)),
    stale: data.stale,
    state: {
      lockChanged: data.state.lockChanged,
      manifestChanged: data.state.manifestChanged,
    },
    writes: [...new Set(writes)].sort(compareText),
  });
}

function invocation(
  command: string,
  arguments_: readonly unknown[],
  options: Readonly<Record<string, unknown>>,
): CommandInvocation {
  return { command, arguments: arguments_, options };
}

export class DefaultTuiActionPort implements TuiActionPort {
  public constructor(
    private readonly execute: CommandExecutor,
    private readonly options: Readonly<Record<string, unknown>>,
  ) {}

  private optionsFor(
    extra: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> {
    return {
      ...this.options,
      ...extra,
      color: this.options.color !== false,
      json: true,
      noInput: true,
      yes: true,
    };
  }

  /** Library setup is user-wide, even when the dashboard is scoped to a project or global state. */
  private setupOptions(
    extra: Readonly<Record<string, unknown>> = {},
  ): Readonly<Record<string, unknown>> {
    return {
      color: this.options.color !== false,
      json: true,
      noInput: true,
      yes: false,
      ...extra,
    };
  }

  /** User configuration is scope-free even when the surrounding dashboard is not. */
  private configurationOptions(): Readonly<Record<string, unknown>> {
    return {
      color: this.options.color !== false,
      json: true,
    };
  }

  public async load(): Promise<TuiDashboard> {
    const [catalog, status, configuration] = await Promise.all([
      this.execute(invocation('list', [], this.optionsFor())),
      this.execute(invocation('status', [], this.optionsFor())),
      this.execute(invocation('config:list', [], this.configurationOptions())),
    ]);
    const firstRun =
      hasErrorCode(catalog, 'LIBRARY_NOT_CONFIGURED') ||
      hasErrorCode(status, 'LIBRARY_NOT_CONFIGURED');
    const setupErrors = new Set(firstRun ? ['LIBRARY_NOT_CONFIGURED'] : []);
    const errors = [
      ...errorMessages(catalog, setupErrors),
      ...errorMessages(status, setupErrors),
      ...errorMessages(configuration, setupErrors),
    ];
    const root = asProjectRoot(status);
    const manageGitignore =
      this.options.global === true ? false : await projectGitignoreManaged(root, configuration);
    let inventory: readonly TuiInventorySkill[] = [];
    let inventoryIssues: readonly string[];
    if (this.options.global === true) {
      const report = await inspectGlobalUnmanagedSkills({ paths: resolveApplicationPaths() });
      inventory = report.entries.map((entry) => ({
        adoptable: entry.adoptable,
        issues: entry.issues.map(terminalSafe),
        name: terminalSafe(entry.name),
        path: terminalSafe(entry.path),
        status: terminalSafe(entry.status),
        target: terminalSafe(entry.target),
      }));
      inventoryIssues = report.issues.map((issue) =>
        terminalSafe(`${issue.code}: ${issue.message}`),
      );
    } else if (root !== undefined) {
      const report = await inspectProjectUnmanagedSkills({ projectRoot: root });
      inventory = report.entries.map((entry) => ({
        adoptable: entry.adoptable,
        issues: entry.issues.map(terminalSafe),
        name: terminalSafe(entry.name),
        path: terminalSafe(entry.path),
        status: terminalSafe(entry.status),
        target: terminalSafe(entry.target),
      }));
      inventoryIssues = report.issues.map((issue) =>
        terminalSafe(`${issue.code}: ${issue.message}`),
      );
    } else {
      inventoryIssues = ['Project inventory is unavailable until project status can be inspected.'];
    }
    return {
      defaultTargets: asEffectiveDefaultTargets(configuration),
      errors,
      firstRun,
      inventory,
      inventoryIssues,
      manageGitignore,
      managed: asManaged(status),
      scope: this.options.global === true ? 'global' : 'project',
      skills: asSkills(catalog),
    };
  }

  public async checkForUpdate(): Promise<TuiReleaseUpdate | undefined> {
    return asReleaseUpdate(await this.execute(invocation('release:check', [], this.optionsFor())));
  }

  public async previewLibrarySetup(
    intent: TuiLibrarySetupIntent,
  ): Promise<CommandResult<TuiLibraryInitPlan>> {
    const arguments_ = intent.kind === 'connect' ? [intent.value] : [];
    const extra =
      intent.kind === 'create' ? { create: intent.value, dryRun: true } : { dryRun: true };
    return parseTuiLibraryInitPlanResult(
      await this.execute(invocation('init', arguments_, this.setupOptions(extra))),
    );
  }

  public async applyLibrarySetup(
    intent: TuiLibrarySetupIntent,
    expectedPlanFingerprint: string,
  ): Promise<CommandResult<unknown>> {
    const arguments_ = intent.kind === 'connect' ? [intent.value] : [];
    const extra = {
      ...(intent.kind === 'create' ? { create: intent.value } : {}),
      expectPlan: expectedPlanFingerprint,
      yes: true,
    };
    return await this.execute(invocation('init', arguments_, this.setupOptions(extra)));
  }

  public async diagnose(): Promise<CommandResult<TuiDoctorSummary>> {
    return parseTuiDoctorSummaryResult(
      await this.execute(
        invocation('doctor', [], {
          ...this.options,
          color: this.options.color !== false,
          json: true,
          noInput: true,
          yes: false,
        }),
      ),
    );
  }

  public async install(
    ids: readonly string[],
    targets: readonly string[],
    manageGitignore: boolean,
    expectedPlanFingerprint: string,
  ): Promise<CommandResult<unknown>> {
    const installOptions = {
      ...(this.options.global === true ? {} : { gitignore: manageGitignore }),
      expectPlan: expectedPlanFingerprint,
      target: [...targets],
    };
    return await this.execute(invocation('install', [ids], this.optionsFor(installOptions)));
  }

  public async previewInstall(
    ids: readonly string[],
    targets: readonly string[],
    manageGitignore: boolean,
  ): Promise<CommandResult<TuiInstallPreview>> {
    const installOptions = {
      dryRun: true,
      ...(this.options.global === true ? {} : { gitignore: manageGitignore }),
      target: [...targets],
    };
    return parseTuiInstallPreviewResult(
      await this.execute(invocation('install', [ids], this.optionsFor(installOptions))),
    );
  }

  public async adopt(id: string, target: string): Promise<CommandResult<unknown>> {
    return await this.execute(invocation('adopt', [id], this.optionsFor({ target })));
  }

  public async sync(discardLocal: boolean): Promise<CommandResult<unknown>> {
    return await this.execute(invocation('sync', [], this.optionsFor({ discardLocal })));
  }
}

export function createTuiLauncher(options: {
  readonly execute: CommandExecutor;
  readonly io: RuntimeIo;
}): TuiLauncher {
  return {
    launch: async (request: TuiLaunchRequest): Promise<void> => {
      if (request.options.global === true && typeof request.options.project === 'string') {
        throw new SkillSyncError(
          'CONFLICTING_SCOPE_OPTIONS',
          'Pass either --global or --project, not both.',
          EXIT_CODES.usage,
        );
      }
      if (request.options.json === true || request.options.noInput === true) {
        throw new SkillSyncError(
          'INTERACTIVE_TERMINAL_REQUIRED',
          'The terminal UI cannot be used with --json or --no-input. Run an argument-driven command instead.',
          EXIT_CODES.usage,
        );
      }
      if (!options.io.stdinIsTty || !options.io.stdoutIsTty) {
        throw new SkillSyncError(
          'INTERACTIVE_TERMINAL_REQUIRED',
          'The terminal UI requires interactive standard input and output. Run a command such as skill-sync list instead.',
          EXIT_CODES.usage,
        );
      }
      const app = render(
        createElement(TuiApp, {
          actions: new DefaultTuiActionPort(options.execute, request.options),
          color: request.options.color !== false,
          implicit: request.implicit,
        }),
        { alternateScreen: true, exitOnCtrlC: true, interactive: true },
      );
      await app.waitUntilExit();
    },
  };
}
