import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { ZodError } from 'zod';

import type { CatalogInstallationState, CatalogScanResult } from '../application/catalog.js';
import { catalogFromValidatedLibrary } from '../application/catalog.js';
import type { ConfigService } from '../application/config-service.js';
import {
  LibraryLifecycleError,
  type LibraryGroupResult,
  type LibraryInitPlan,
  type LibraryInitializationRequest,
  type LibraryRemoveResult,
  type ValidatedLibrarySnapshot,
} from '../application/library-lifecycle.js';
import type { LibraryLifecycleService } from '../application/library-lifecycle.js';
import {
  adoptProjectSkill,
  installProjectSkills,
  uninstallProjectSkills,
} from '../application/project-installation.js';
import {
  adoptGlobalSkill,
  formatGlobalDiffHuman,
  formatGlobalReconciliationHuman,
  formatGlobalStatusHuman,
  installGlobalSkills,
  inspectGlobalDiff,
  inspectGlobalStatus,
  syncGlobalSkills,
  uninstallGlobalSkills,
  updateGlobalSkills,
  type GlobalReconciliationReport,
} from '../application/global-skill-management.js';
import {
  CachedLibraryRevisionProvider,
  formatProjectDiffHuman,
  formatProjectReconciliationHuman,
  formatProjectStatusHuman,
  inspectProjectDiff,
  inspectProjectStatus,
  syncProjectSkills,
  updateProjectSkills,
  type LibraryRevisionProvider,
  type ProjectHumanFormatOptions,
  type ProjectReconciliationReport,
  type ResolvedLibraryRevision,
} from '../application/project-reconciliation.js';
import { globalMutationStorage } from '../application/managed-scope.js';
import { projectMutationStorage } from '../application/project-storage.js';
import {
  formatCatalogListHuman,
  formatCatalogSkillInfoHuman,
  formatReadOnlyValidationHuman,
  getCatalogSkillInfo,
  listCatalog,
  validateReadOnlySource,
  type CatalogQueryIssue,
  type ReadOnlyValidationFormatOptions,
  type ReadOnlyValidationResult,
} from '../application/read-only.js';
import { resolveSkillSelectors, selectAllSkills } from '../application/selectors.js';
import { comparePortableStrings, IdentifierValidationError } from '../domain/identifiers.js';
import {
  EXIT_CODES,
  failure,
  resultFromUnknown,
  SkillSyncError,
  success,
  type CommandResult,
  type ExitCode,
} from '../domain/result.js';
import type { ProjectManifest } from '../domain/project-state.js';
import type { ApplicationPaths } from '../infrastructure/config.js';
import { readGlobalLock, readGlobalManifest } from '../infrastructure/global-state.js';
import { GitExecutionError, GitRemoteUrlError, normalizeGitRemote } from '../infrastructure/git.js';
import type { GitClient } from '../infrastructure/git.js';
import { LibraryCacheError } from '../infrastructure/library-cache.js';
import type { LibraryCache } from '../infrastructure/library-cache.js';
import {
  ProjectStateVersionError,
  readProjectLock,
  readProjectManifest,
  resolveProjectRoot,
} from '../infrastructure/project-state.js';
import {
  AdvisoryLockUnavailableError,
  transactionRootFingerprint,
} from '../infrastructure/transactions.js';
import type { RuntimeIo } from '../ports/index.js';
import type { RuntimeBoundaryContext } from '../runtime/boundary.js';
import type { OperationGuard } from '../runtime/operation-guard.js';
import { TargetRegistry, type TargetName } from '../targets/index.js';
import { formatAdoptHuman } from '../ui/adopt-output.js';
import {
  formatEmptyGlobalStatusHuman,
  formatEmptyProjectStatusHuman,
  type EmptyGlobalStatusReport,
  type EmptyProjectStatusReport,
} from '../ui/empty-status-output.js';
import {
  formatInstallApplyCommand,
  formatInstallHuman,
  installPlanHasNoChanges,
} from '../ui/install-output.js';
import {
  formatInitHuman,
  formatInitPlanHuman,
  formatInitPreviewCommand,
} from '../ui/init-output.js';
import { PromptAdapter, terminalIsInteractive } from '../ui/prompt.js';
import { scopedHumanCommand, type ScopedHumanOutputOptions } from '../ui/scope-output.js';
import { formatUninstallHuman } from '../ui/uninstall-output.js';
import type { CommandInvocation } from './program.js';

export interface WorkflowRuntimeContext {
  readonly operationGuard: OperationGuard;
  readonly registerRecovery: RuntimeBoundaryContext['registerRecovery'];
  readonly signal: AbortSignal;
  throwIfCancelled(): void;
}

export interface WorkflowCommandHandlerDependencies {
  readonly cache: LibraryCache;
  readonly config: ConfigService;
  readonly environment?: NodeJS.ProcessEnv;
  readonly git: GitClient;
  readonly io: RuntimeIo;
  readonly lifecycle: LibraryLifecycleService;
  readonly paths: ApplicationPaths;
  readonly reconciliationStagingRoot: string;
  readonly targets?: TargetRegistry;
}

export type WorkflowCommandHandler = (
  invocation: CommandInvocation,
  context?: WorkflowRuntimeContext,
) => Promise<CommandResult<unknown>>;

interface LibraryConnection {
  readonly branch: string;
  readonly identity: string;
  readonly remote: ReturnType<typeof normalizeGitRemote>;
  readonly url: string;
}

interface CatalogContext {
  readonly catalog: CatalogScanResult;
  readonly projectRoot: string;
  readonly scope: 'global' | 'project';
  readonly snapshot: ValidatedLibrarySnapshot;
}

const LIFECYCLE_REPOSITORY_ERRORS = new Set([
  'GITHUB_CREATE_FAILED',
  'REMOTE_ACCESS_FAILED',
  'CONFIG_PERSIST_FAILED',
]);
const LIFECYCLE_CONFLICT_ERRORS = new Set([
  'INIT_PLAN_CHANGED',
  'LIBRARY_DIVERGED',
  'REMOTE_BASE_DIVERGED',
  'DIVERGENT_TARGETS',
  'REMOTE_NOT_EMPTY',
  'GITHUB_REPOSITORY_EXISTS',
  'GROUP_NOT_EMPTY',
]);
const LIFECYCLE_USAGE_ERRORS = new Set([
  'REMOTE_EMPTY_CONFIRMATION_REQUIRED',
  'DESTRUCTIVE_CONFIRMATION_REQUIRED',
]);
const HUMAN_CATALOG_LIMIT = 20;

function optionString(invocation: CommandInvocation, key: string): string | undefined {
  const value = invocation.options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionStrings(invocation: CommandInvocation, key: string): readonly string[] {
  const value = invocation.options[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function argumentString(invocation: CommandInvocation, index: number, description: string): string {
  const value = invocation.arguments[index];
  if (typeof value !== 'string' || value.length === 0) {
    throw new SkillSyncError('MISSING_ARGUMENT', `${description} is required.`, EXIT_CODES.usage);
  }
  return value;
}

function variadicArguments(invocation: CommandInvocation): readonly string[] {
  const value = invocation.arguments[0];
  if (value === undefined) return [];
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === 'string');
  return typeof value === 'string' ? [value] : [];
}

function jsonRequested(invocation: CommandInvocation): boolean {
  return invocation.options.json === true;
}

function humanScopeOptions(invocation: CommandInvocation): { readonly explicitProject: boolean } {
  return { explicitProject: optionString(invocation, 'project') !== undefined };
}

interface HumanAddResult {
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly id: string;
  readonly revision: string;
}

interface HumanPublishResult {
  readonly changed: boolean;
  readonly dryRun: boolean;
  readonly projectStateUpdated: boolean;
  readonly revision: string;
  readonly skills: readonly {
    readonly changed: boolean;
    readonly diff: {
      readonly added: readonly string[];
      readonly modified: readonly string[];
      readonly removed: readonly string[];
    };
    readonly id: string;
  }[];
}

interface HumanLibraryGroup {
  readonly description: string | null;
  readonly path: string;
}

type HumanGroupOperation =
  | { readonly kind: 'create'; readonly group: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'remove'; readonly group: string };

interface HumanLibraryGroupResult extends LibraryGroupResult {
  readonly message?: string;
}

interface HumanLibraryRemoveResult extends LibraryRemoveResult {
  readonly message?: string;
}

function formatGroupListHuman(groups: readonly HumanLibraryGroup[]): string {
  const ordered = [...groups].sort((left, right) => comparePortableStrings(left.path, right.path));
  if (ordered.length === 0) {
    return [
      'No library groups found.',
      'Read-only: no changes made.',
      'Next: Create one with skill-sync group create <group>.',
    ].join('\n');
  }
  return [
    `Library groups (${String(ordered.length)}):`,
    ...ordered.map(
      (group) => `  ${group.path}${group.description === null ? '' : ` — ${group.description}`}`,
    ),
    'Read-only: no changes made.',
    'Next: Run skill-sync list --group <group> to browse a group.',
  ].join('\n');
}

function groupOperationSummary(
  operation: HumanGroupOperation,
  result: HumanLibraryGroupResult,
): string {
  if (result.message !== undefined) return result.message;
  if (result.dryRun) {
    switch (operation.kind) {
      case 'create':
        return `Group creation preview for ${operation.group} (no changes made).`;
      case 'rename':
        return `Group rename preview from ${operation.from} to ${operation.to} (no changes made).`;
      case 'remove':
        return `Group removal preview for ${operation.group} (no changes made).`;
    }
  }
  if (!result.changed) return 'The library group was unchanged.';
  switch (operation.kind) {
    case 'create':
      return `Created library group ${operation.group}.`;
    case 'rename':
      return `Renamed library group ${operation.from} to ${operation.to}.`;
    case 'remove':
      return `Removed library group ${operation.group}.`;
  }
}

function groupOperationNextAction(
  operation: HumanGroupOperation,
  result: HumanLibraryGroupResult,
  requiresYes: boolean,
): string {
  if (result.message !== undefined && !result.changed) {
    return 'Next: Re-run the command when you are ready to change the library.';
  }
  if (result.dryRun) {
    switch (operation.kind) {
      case 'create':
        return `Next: Re-run skill-sync group create ${operation.group} without --dry-run to apply this preview.`;
      case 'rename':
        return `Next: Re-run skill-sync group rename ${operation.from} ${operation.to} without --dry-run to apply this preview.`;
      case 'remove':
        return `Next: Re-run skill-sync group remove ${operation.group}${result.affectedIds.length === 0 ? '' : ' --recursive'}${requiresYes ? ' --yes' : ''} without --dry-run to apply this preview.`;
    }
  }
  switch (operation.kind) {
    case 'create':
      return `Next: Add a skill with skill-sync add <path> --group ${operation.group}.`;
    case 'rename':
      return 'Next: Run skill-sync status in managed projects to review renamed skill IDs.';
    case 'remove':
      return 'Next: Run skill-sync list to verify the remaining library groups.';
  }
}

function formatGroupMutationHuman(
  operation: HumanGroupOperation,
  result: HumanLibraryGroupResult,
  options: { readonly requiresYes?: boolean } = {},
): string {
  const affectedIds = [...new Set(result.affectedIds)].sort(comparePortableStrings);
  return [
    groupOperationSummary(operation, result),
    `Changed: ${result.changed ? 'yes' : 'no'}${result.dryRun && result.changed ? ' (preview only)' : ''}`,
    `Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    `Revision: ${result.revision}`,
    `Affected skill IDs (${String(affectedIds.length)}): ${affectedIds.length === 0 ? 'none' : affectedIds.join(', ')}`,
    ...(result.requiresRecursive === true
      ? ['Required option: --recursive (this group contains skills).']
      : []),
    ...(result.warning === undefined ? [] : [`Warning: ${result.warning}`]),
    groupOperationNextAction(operation, result, options.requiresYes === true),
  ].join('\n');
}

function formatLibraryRemoveHuman(
  result: HumanLibraryRemoveResult,
  options: { readonly requiresYes?: boolean } = {},
): string {
  const summary =
    result.message ??
    (result.dryRun
      ? `Library skill removal preview for ${result.id} (no changes made).`
      : result.changed
        ? `Removed ${result.id} from the canonical library.`
        : `Canonical library skill ${result.id} was unchanged.`);
  const next =
    result.message !== undefined && !result.changed
      ? 'Next: Re-run the command when you are ready to remove the canonical skill.'
      : result.dryRun
        ? `Next: Re-run skill-sync library remove ${result.id}${options.requiresYes === true ? ' --yes' : ''} without --dry-run to apply this preview.`
        : 'Next: Run skill-sync list to verify the remaining canonical skills.';
  return [
    summary,
    `Changed: ${result.changed ? 'yes' : 'no'}${result.dryRun && result.changed ? ' (preview only)' : ''}`,
    `Dry run: ${result.dryRun ? 'yes' : 'no'}`,
    `Revision: ${result.revision}`,
    'Affected installed copies: none (existing project and global copies remain in place).',
    `Warning: ${result.warning}`,
    next,
  ].join('\n');
}

function catalogInstallPreviewCommand(
  skill: { readonly compatibleAgents: readonly string[]; readonly id: string },
  scope: 'global' | 'project',
  options: ScopedHumanOutputOptions = {},
): string | undefined {
  const target = skill.compatibleAgents.includes('codex')
    ? 'codex'
    : skill.compatibleAgents.includes('claude')
      ? 'claude'
      : undefined;
  if (target === undefined) return undefined;
  const command = scopedHumanCommand(scope, `install ${skill.id}`, options);
  return `${command} --target ${target}${scope === 'project' ? ' --gitignore' : ''} --dry-run`;
}

function formatInfoFailureHuman(
  errors: readonly CatalogQueryIssue[],
  scope: 'global' | 'project',
  options: ScopedHumanOutputOptions,
): string {
  const messages = errors.map((error) => error.message);
  const selectorErrors = errors.filter((error) =>
    ['ambiguous-selector', 'invalid-selector', 'unknown-selector'].includes(error.code),
  );
  if (selectorErrors.length === 0) return messages.join('\n');

  const candidates = [...new Set(selectorErrors.flatMap((error) => error.candidates))].sort(
    comparePortableStrings,
  );
  if (candidates.length === 0) {
    return [
      ...messages,
      `Next: Run ${scopedHumanCommand(scope, 'list', options)} to copy an exact skill ID.`,
    ].join('\n');
  }
  if (candidates.length === 1) {
    return [
      ...messages,
      `Next: Run ${scopedHumanCommand(scope, `info ${candidates[0] ?? ''}`, options)}.`,
    ].join('\n');
  }
  return [
    ...messages,
    'Next: Retry with one exact skill ID:',
    ...candidates.map((id) => `  ${scopedHumanCommand(scope, `info ${id}`, options)}`),
  ].join('\n');
}

function formatAddHuman(result: HumanAddResult): string {
  const summary = result.dryRun
    ? result.changed
      ? `Would add ${result.id} to the skill library (no changes made).`
      : `The skill library already matches ${result.id} (no changes made).`
    : result.changed
      ? `Added ${result.id} to the skill library.`
      : `The skill library already matches ${result.id}.`;
  const next = result.dryRun
    ? 'Next: Re-run the skill-sync add command without --dry-run to apply this preview.'
    : `Next: Run skill-sync info ${result.id} to inspect the canonical skill.`;
  return [
    summary,
    `Canonical path: skills/${result.id}`,
    `Revision: ${result.revision}`,
    next,
  ].join('\n');
}

function formatPublishHuman(
  result: HumanPublishResult,
  options: ScopedHumanOutputOptions = {},
): string {
  const summary = result.dryRun
    ? 'Publish preview (no changes made).'
    : result.changed
      ? 'Publish complete.'
      : 'Publish complete; the canonical skills were already current.';
  const skillLines = result.skills.map((skill) => {
    const action = skill.changed ? (result.dryRun ? 'would publish' : 'published') : 'unchanged';
    return `  ${skill.id} -> skills/${skill.id}: ${action} (added ${String(skill.diff.added.length)}, modified ${String(skill.diff.modified.length)}, removed ${String(skill.diff.removed.length)})`;
  });
  const next =
    result.dryRun && result.changed
      ? 'Next: Re-run the skill-sync publish command without --dry-run to apply this preview.'
      : `Next: Run ${scopedHumanCommand('project', 'status', options)} to verify the canonical revision.`;
  return [
    summary,
    'Skills:',
    ...skillLines,
    `Project tracking: ${result.projectStateUpdated ? 'updated' : 'unchanged'}`,
    `Revision: ${result.revision}`,
    next,
  ].join('\n');
}

function emptyProjectStatusReport(
  projectRoot: string,
  libraryConfigured: boolean,
): EmptyProjectStatusReport {
  return {
    managed: false,
    nextAction: libraryConfigured
      ? 'skill-sync list'
      : 'skill-sync init <repository-url> --dry-run',
    operation: 'status',
    projectRoot,
    skills: [],
  };
}

function emptyGlobalStatusReport(
  stateDirectory: string,
  libraryConfigured: boolean,
): EmptyGlobalStatusReport {
  return {
    managed: false,
    nextAction: libraryConfigured
      ? 'skill-sync list --global'
      : 'skill-sync init <repository-url> --dry-run',
    operation: 'status',
    scope: 'global',
    skills: [],
    stateDirectory,
  };
}

function noSelectionResult(command: string, json: boolean): CommandResult<unknown> {
  const result = { applied: false, command, selectedIds: [], message: 'No skills selected.' };
  return success(json ? result : `No skills selected; ${command} made no changes.`);
}

function reportFailure(
  code: string,
  message: string,
  report: unknown,
  exitCode: ExitCode,
  json: boolean,
): CommandResult<never> {
  return failure(
    {
      code,
      message,
      ...(json ? { details: { report } } : {}),
    },
    exitCode,
  );
}

function mappedOperationalFailure(error: unknown): CommandResult<never> {
  if (error instanceof SkillSyncError) return resultFromUnknown(error);
  if (error instanceof GitRemoteUrlError) {
    return failure({ code: error.code, message: error.message }, EXIT_CODES.validation);
  }
  if (error instanceof ProjectStateVersionError) {
    return failure(
      {
        code: 'PROJECT_STATE_VERSION_UNSUPPORTED',
        message: error.message,
        details: {
          fileKind: error.fileKind,
          expectedVersion: error.expectedVersion,
          ...(error.actualVersion === undefined ? {} : { actualVersion: error.actualVersion }),
        },
      },
      EXIT_CODES.validation,
    );
  }
  if (error instanceof AdvisoryLockUnavailableError) {
    return failure(
      {
        code: 'ADVISORY_LOCK_UNAVAILABLE',
        message: `${error.message} Wait for the active operation to finish. If none is active, run skill-sync recovery list before retrying.`,
        details: { lockPath: error.lockPath, stale: error.stale },
      },
      EXIT_CODES.conflict,
    );
  }
  if (error instanceof SyntaxError) {
    return failure(
      { code: 'MALFORMED_JSON', message: 'A JSON state file could not be parsed.' },
      EXIT_CODES.validation,
    );
  }
  if (error instanceof LibraryLifecycleError) {
    const exitCode = LIFECYCLE_REPOSITORY_ERRORS.has(error.code)
      ? EXIT_CODES.repository
      : LIFECYCLE_CONFLICT_ERRORS.has(error.code)
        ? EXIT_CODES.conflict
        : LIFECYCLE_USAGE_ERRORS.has(error.code)
          ? EXIT_CODES.usage
          : EXIT_CODES.validation;
    const currentPlan = error.details.currentPlan;
    const initPlan =
      error.code === 'INIT_PLAN_CHANGED' &&
      typeof currentPlan === 'object' &&
      currentPlan !== null &&
      Reflect.get(currentPlan, 'operation') === 'init' &&
      typeof Reflect.get(currentPlan, 'fingerprint') === 'string'
        ? (currentPlan as LibraryInitPlan)
        : undefined;
    const previewCommand = initPlan === undefined ? undefined : formatInitPreviewCommand(initPlan);
    return failure(
      {
        code: error.code,
        message:
          previewCommand === undefined ? error.message : `${error.message} Next: ${previewCommand}`,
        details: {
          ...error.details,
          ...(previewCommand === undefined ? {} : { previewCommand }),
        },
      },
      exitCode,
    );
  }
  if (error instanceof LibraryCacheError) {
    const exitCode = ['INVALID_BRANCH', 'INVALID_CACHE'].includes(error.code)
      ? EXIT_CODES.validation
      : EXIT_CODES.repository;
    return failure({ code: error.code, message: error.message }, exitCode);
  }
  if (error instanceof GitExecutionError) {
    return failure(
      { code: error.code, message: error.message, details: error.toJSON() },
      error.code === 'GIT_ARGUMENT_REJECTED' ? EXIT_CODES.validation : EXIT_CODES.repository,
    );
  }
  if (error instanceof IdentifierValidationError || error instanceof ZodError) {
    return failure(
      {
        code: 'VALIDATION_FAILED',
        message: error instanceof Error ? error.message : 'Validation failed.',
      },
      EXIT_CODES.validation,
    );
  }
  if (typeof error === 'object' && error !== null) {
    const code = (error as { readonly code?: unknown }).code;
    if (['EACCES', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EPERM'].includes(String(code))) {
      return failure(
        {
          code: 'FILESYSTEM_ERROR',
          message: error instanceof Error ? error.message : 'A filesystem operation failed.',
        },
        EXIT_CODES.validation,
      );
    }
  }
  return resultFromUnknown(error);
}

function selectionFailure(errors: readonly { readonly message: string }[]): never {
  throw new SkillSyncError(
    'INVALID_SKILL_SELECTION',
    errors.map((error) => error.message).join('\n'),
    EXIT_CODES.validation,
    { errors },
  );
}

async function selectCandidates<T extends { readonly id: string; readonly description?: string }>(
  candidates: readonly T[],
  selectors: readonly string[],
  all: boolean,
  prompt: PromptAdapter,
  command: string,
): Promise<readonly T[]> {
  if (all && selectors.length > 0) {
    throw new SkillSyncError(
      'CONFLICTING_SELECTION',
      `${command} --all cannot be combined with explicit selectors.`,
      EXIT_CODES.usage,
    );
  }
  if (all) {
    const selected = selectAllSkills(candidates);
    if (!selected.success) return selectionFailure(selected.errors);
    return selected.values;
  }
  if (selectors.length > 0) {
    const selected = resolveSkillSelectors(candidates, selectors);
    if (!selected.success) return selectionFailure(selected.errors);
    return selected.values;
  }
  const selectedIds = await prompt.selectMany(
    `Select skills to ${command}`,
    candidates.map((candidate) => ({
      name: candidate.id,
      value: candidate.id,
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
    })),
    { searchable: true },
  );
  if (selectedIds.length === 0) return [];
  const selected = resolveSkillSelectors(candidates, selectedIds);
  if (!selected.success) return selectionFailure(selected.errors);
  return selected.values;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function validationResult(
  result: ReadOnlyValidationResult,
  json: boolean,
  options: ReadOnlyValidationFormatOptions = {},
): CommandResult<unknown> {
  if (result.valid) return success(json ? result : formatReadOnlyValidationHuman(result, options));
  const message = json
    ? result.errors.map((error) => `${error.source}: ${error.message}`).join('\n')
    : formatReadOnlyValidationHuman(result, options);
  return reportFailure('VALIDATION_FAILED', message, result, EXIT_CODES.validation, json);
}

export function reconciliationResult(
  report: ProjectReconciliationReport | GlobalReconciliationReport,
  json: boolean,
  options: ProjectHumanFormatOptions = {},
): CommandResult<unknown> {
  const human =
    'scope' in report
      ? formatGlobalReconciliationHuman(report)
      : formatProjectReconciliationHuman(report, options);
  if (report.exitCode === EXIT_CODES.success) return success(json ? report : human);
  const code =
    report.exitCode === EXIT_CODES.partial
      ? 'PARTIAL_RECONCILIATION'
      : report.check
        ? 'RECONCILIATION_CHECK_FAILED'
        : report.exitCode === EXIT_CODES.conflict
          ? 'RECONCILIATION_CONFLICT'
          : 'RECONCILIATION_FAILED';
  return reportFailure(
    code,
    json ? `${report.operation} did not complete cleanly.` : human,
    report,
    report.exitCode,
    json,
  );
}

export function createWorkflowCommandHandler(
  dependencies: WorkflowCommandHandlerDependencies,
): WorkflowCommandHandler {
  const environment = dependencies.environment ?? process.env;
  const registry = dependencies.targets ?? new TargetRegistry();

  function promptFor(invocation: CommandInvocation): PromptAdapter {
    const interactive =
      invocation.options.json !== true &&
      terminalIsInteractive(dependencies.io.stdinIsTty, dependencies.io.stdoutIsTty, environment);
    return new PromptAdapter({
      interactive,
      noInput: invocation.options.noInput === true || invocation.options.json === true,
      yes: invocation.options.yes === true,
    });
  }

  function promptingIsDisabled(invocation: CommandInvocation): boolean {
    return (
      invocation.options.noInput === true ||
      invocation.options.json === true ||
      !terminalIsInteractive(dependencies.io.stdinIsTty, dependencies.io.stdoutIsTty, environment)
    );
  }

  function requireSelectionBeforeResolution(
    invocation: CommandInvocation,
    selectors: readonly string[],
    all: boolean,
  ): void {
    if (all && selectors.length > 0) {
      throw new SkillSyncError(
        'CONFLICTING_SELECTION',
        `${invocation.command} --all cannot be combined with explicit selectors.`,
        EXIT_CODES.usage,
      );
    }
    if (selectors.length === 0 && !all && promptingIsDisabled(invocation)) {
      throw new SkillSyncError(
        'MISSING_INPUT',
        'Skill selectors or --all must be supplied when prompting is disabled.',
        EXIT_CODES.usage,
      );
    }
  }

  function requireNonInteractiveConfirmation(invocation: CommandInvocation, message: string): void {
    if (promptingIsDisabled(invocation) && invocation.options.yes !== true) {
      throw new SkillSyncError('DESTRUCTIVE_CONFIRMATION_REQUIRED', message, EXIT_CODES.usage);
    }
  }

  async function connection(): Promise<LibraryConnection> {
    const listing = await dependencies.config.list();
    const url = listing.effective.value.libraryUrl;
    if (url === undefined) {
      throw new SkillSyncError(
        'LIBRARY_NOT_CONFIGURED',
        'No default skill library is configured. Preview setup with skill-sync init <repository-url> --dry-run or skill-sync init --create <owner/name> --dry-run, then run the exact --expect-plan command printed by the preview.',
        EXIT_CODES.validation,
      );
    }
    const remote = normalizeGitRemote(url);
    return {
      branch: listing.effective.value.branch ?? 'main',
      identity: remote.identity,
      remote,
      url,
    };
  }

  function globalRequested(invocation: CommandInvocation): boolean {
    if (invocation.options.global === true && optionString(invocation, 'project') !== undefined) {
      throw new SkillSyncError(
        'CONFLICTING_SCOPE_OPTIONS',
        'Pass either --global or --project, not both.',
        EXIT_CODES.usage,
      );
    }
    return invocation.options.global === true;
  }

  async function projectRoot(invocation: CommandInvocation): Promise<string> {
    if (globalRequested(invocation)) {
      throw new SkillSyncError(
        'GLOBAL_SCOPE_UNSUPPORTED',
        `Global scope is not supported by ${invocation.command}. Use --global with install, adopt, sync, update, status, diff, uninstall, list, info, or doctor.`,
        EXIT_CODES.usage,
      );
    }
    const explicitPath = optionString(invocation, 'project');
    return await resolveProjectRoot({
      ...(explicitPath === undefined ? {} : { explicitPath }),
    });
  }

  async function projectInstallationStates(
    root: string,
    snapshot: ValidatedLibrarySnapshot,
  ): Promise<Readonly<Partial<Record<string, CatalogInstallationState>>>> {
    const [manifest, lock] = await Promise.all([readProjectManifest(root), readProjectLock(root)]);
    if (manifest === undefined && lock === undefined) return {};
    const provider: LibraryRevisionProvider = {
      resolve: () =>
        Promise.resolve({
          branch: snapshot.branch,
          freshness: snapshot.freshness,
          identity: snapshot.identity,
          libraryRoot: snapshot.rootPath,
          refreshedAt: '1970-01-01T00:00:00.000Z',
          revision: snapshot.revision,
          stale: snapshot.stale,
          usableForMutation: !snapshot.stale,
        }),
    };
    const report = await inspectProjectStatus({ library: provider, projectRoot: root });
    return Object.fromEntries(report.skills.map((skill) => [skill.id, skill.state]));
  }

  async function globalInstallationStates(
    snapshot: ValidatedLibrarySnapshot,
  ): Promise<Readonly<Partial<Record<string, CatalogInstallationState>>>> {
    const [manifest, lock] = await Promise.all([
      readGlobalManifest(dependencies.paths),
      readGlobalLock(dependencies.paths),
    ]);
    if (manifest === undefined && lock === undefined) return {};
    const provider: LibraryRevisionProvider = {
      resolve: () =>
        Promise.resolve({
          branch: snapshot.branch,
          freshness: snapshot.freshness,
          identity: snapshot.identity,
          libraryRoot: snapshot.rootPath,
          refreshedAt: '1970-01-01T00:00:00.000Z',
          revision: snapshot.revision,
          stale: snapshot.stale,
          usableForMutation: !snapshot.stale,
        }),
    };
    const report = await inspectGlobalStatus({
      library: provider,
      paths: dependencies.paths,
      registry,
    });
    return Object.fromEntries(report.skills.map((skill) => [skill.id, skill.state]));
  }

  async function withCatalog<T>(
    invocation: CommandInvocation,
    options: { readonly allowStale?: boolean; readonly cacheOnly?: boolean },
    consume: (context: CatalogContext) => Promise<T> | T,
  ): Promise<T> {
    const global = globalRequested(invocation);
    const selectedProjectRoot = global
      ? dependencies.paths.globalStateDirectory
      : await projectRoot(invocation);
    if (selectedProjectRoot === undefined) {
      throw new SkillSyncError(
        'GLOBAL_STATE_UNAVAILABLE',
        'Global skill state paths are unavailable.',
        EXIT_CODES.validation,
      );
    }
    const selectedConnection = await connection();
    return await dependencies.lifecycle.withValidatedLibrary(
      {
        remoteUrl: selectedConnection.url,
        branch: selectedConnection.branch,
        ...(options.allowStale === undefined ? {} : { allowStale: options.allowStale }),
        ...(options.cacheOnly === undefined ? {} : { cacheOnly: options.cacheOnly }),
      },
      async (snapshot) => {
        const installationStates = global
          ? await globalInstallationStates(snapshot)
          : await projectInstallationStates(selectedProjectRoot, snapshot);
        return await consume({
          catalog: catalogFromValidatedLibrary(snapshot.library, {
            installationStates,
            sourceRevision: snapshot.revision,
          }),
          projectRoot: selectedProjectRoot,
          scope: global ? 'global' : 'project',
          snapshot,
        });
      },
    );
  }

  async function selectedTargets(
    invocation: CommandInvocation,
    root: string,
    prompt: PromptAdapter,
  ): Promise<readonly TargetName[]> {
    const explicit = [...new Set(optionStrings(invocation, 'target'))];
    if (explicit.some((target) => !['codex', 'claude'].includes(target))) {
      throw new SkillSyncError(
        'INVALID_TARGET',
        'Targets must be codex or claude.',
        EXIT_CODES.validation,
      );
    }
    if (explicit.length > 0) return explicit.sort() as TargetName[];

    const listing = await dependencies.config.list();
    if (
      listing.effective.sources.defaultTargets !== 'default' &&
      listing.effective.value.defaultTargets.length > 0
    ) {
      return [...listing.effective.value.defaultTargets].sort();
    }
    if (promptingIsDisabled(invocation)) {
      throw new SkillSyncError(
        'MISSING_TARGET_SELECTION',
        'No installation target was provided. Pass --target codex or --target claude, or configure defaults.targets.',
        EXIT_CODES.usage,
      );
    }

    const global = globalRequested(invocation);
    const detected = global ? new Set<string>() : new Set(await registry.detect(root));
    const choices = registry.list().map((target) => ({
      name: global
        ? `${target.name} (global)`
        : detected.has(target.name)
          ? `${target.name} (detected)`
          : target.name,
      value: target.name,
    }));
    const values = await prompt.selectMany('Select installation targets', choices);
    if (values.length === 0) {
      throw new SkillSyncError(
        'MISSING_TARGET_SELECTION',
        'At least one target is required.',
        EXIT_CODES.usage,
      );
    }
    return [...new Set(values)].sort() as TargetName[];
  }

  async function gitignorePolicy(
    invocation: CommandInvocation,
    prompt: PromptAdapter,
  ): Promise<ProjectManifest['gitignore']> {
    const explicit = invocation.options.gitignore;
    if (typeof explicit === 'boolean') return explicit ? 'managed' : 'unmanaged';
    const listing = await dependencies.config.list();
    if (listing.effective.sources.gitignore !== 'default') {
      return listing.effective.value.gitignore === 'manage' ? 'managed' : 'unmanaged';
    }
    const manage = await prompt.confirm('Add exact managed skill paths to .gitignore?', true);
    if (
      invocation.options.noInput === true ||
      invocation.options.json === true ||
      !terminalIsInteractive(dependencies.io.stdinIsTty, dependencies.io.stdoutIsTty, environment)
    ) {
      throw new SkillSyncError(
        'MISSING_GITIGNORE_POLICY',
        'Pass --gitignore or --no-gitignore in automation, or configure defaults.gitignore.',
        EXIT_CODES.usage,
      );
    }
    return manage ? 'managed' : 'unmanaged';
  }

  function revisionProvider(selectedConnection: LibraryConnection): CachedLibraryRevisionProvider {
    return new CachedLibraryRevisionProvider({
      branch: selectedConnection.branch,
      cache: dependencies.cache,
      git: dependencies.git,
      remote: selectedConnection.remote,
      stagingRoot: dependencies.reconciliationStagingRoot,
    });
  }

  async function withSharedRevision<T>(
    selectedConnection: LibraryConnection,
    offlineRevision: string | undefined,
    consume: (provider: LibraryRevisionProvider) => Promise<T>,
  ): Promise<T> {
    const resolved = await revisionProvider(selectedConnection).resolve({
      ...(offlineRevision === undefined ? {} : { offlineRevision }),
      purpose: 'application',
    });
    const sharedRevision: ResolvedLibraryRevision = {
      branch: resolved.branch,
      freshness: resolved.freshness,
      identity: resolved.identity,
      libraryRoot: resolved.libraryRoot,
      refreshedAt: resolved.refreshedAt,
      revision: resolved.revision,
      stale: resolved.stale,
      usableForMutation: resolved.usableForMutation,
      ...(resolved.warning === undefined ? {} : { warning: resolved.warning }),
    };
    const shared: LibraryRevisionProvider = {
      resolve: () => Promise.resolve(sharedRevision),
    };
    try {
      return await consume(shared);
    } finally {
      await resolved.release?.();
    }
  }

  async function confirmation(
    prompt: PromptAdapter,
    message: string,
    explicitlyEnabled: boolean,
  ): Promise<boolean> {
    return await prompt.confirm(message, explicitlyEnabled);
  }

  async function handleList(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    return await withCatalog(
      invocation,
      { allowStale: true },
      ({ catalog, projectRoot: root, scope, snapshot }) => {
        const result = listCatalog(catalog, {
          groups: optionStrings(invocation, 'group'),
          queries: optionStrings(invocation, 'query'),
          agents: optionStrings(invocation, 'agent'),
          states: optionStrings(invocation, 'state'),
        });
        if (!result.ok) {
          return reportFailure(
            'CATALOG_QUERY_FAILED',
            result.errors.map((error) => error.message).join('\n'),
            result,
            EXIT_CODES.validation,
            jsonRequested(invocation),
          );
        }
        if (jsonRequested(invocation)) {
          return success({
            branch: snapshot.branch,
            freshness: snapshot.freshness,
            revision: snapshot.revision,
            scope,
            stale: snapshot.stale,
            skills: result.items,
          });
        }
        const shown = result.items.slice(0, HUMAN_CATALOG_LIMIT);
        const first = shown[0];
        const scopeOptions = humanScopeOptions(invocation);
        const listCommand = scopedHumanCommand(scope, 'list', scopeOptions);
        const firstInstallPreview =
          first === undefined
            ? undefined
            : catalogInstallPreviewCommand(first, scope, scopeOptions);
        const next = snapshot.stale
          ? `Next: Re-run ${listCommand} when remote access is available before choosing changes.`
          : catalog.records.length === 0
            ? 'Next: Add the first skill with skill-sync add <path> --group <group>.'
            : first === undefined
              ? `Next: Adjust the filters or run ${listCommand} without filters.`
              : firstInstallPreview === undefined
                ? `Next: Inspect it with ${scopedHumanCommand(scope, `info ${first.id}`, scopeOptions)}; it does not declare a supported install target.`
                : `Next: Inspect it with ${scopedHumanCommand(scope, `info ${first.id}`, scopeOptions)}, then preview installation with ${firstInstallPreview}.`;
        return success(
          [
            `Scope: ${scope} (${root})`,
            `Library: ${snapshot.identity} @ ${snapshot.revision} (${snapshot.freshness}${snapshot.stale ? ', not current' : ''})`,
            ...(snapshot.stale
              ? [
                  'Warning: This catalog is from cached data and may differ from the remote library.',
                ]
              : []),
            `Matches: ${String(result.items.length)}${result.items.length > shown.length ? ` (showing first ${String(shown.length)})` : ''}`,
            formatCatalogListHuman(shown),
            ...(result.items.length > shown.length
              ? [`… ${String(result.items.length - shown.length)} more matching skills omitted`]
              : []),
            next,
          ].join('\n'),
        );
      },
    );
  }

  async function handleInfo(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selector = argumentString(invocation, 0, 'skill ID');
    return await withCatalog(
      invocation,
      { allowStale: true },
      ({ catalog, projectRoot: root, scope, snapshot }) => {
        const result = getCatalogSkillInfo(catalog, selector);
        if (!result.ok) {
          const json = jsonRequested(invocation);
          return reportFailure(
            'SKILL_INFO_FAILED',
            json
              ? result.errors.map((error) => error.message).join('\n')
              : formatInfoFailureHuman(result.errors, scope, humanScopeOptions(invocation)),
            result,
            EXIT_CODES.validation,
            json,
          );
        }
        if (jsonRequested(invocation)) {
          return success({
            ...result.info,
            freshness: snapshot.freshness,
            scope,
            stale: snapshot.stale,
          });
        }
        const scopeOptions = humanScopeOptions(invocation);
        const infoCommand = scopedHumanCommand(scope, `info ${result.info.id}`, scopeOptions);
        const diffCommand = scopedHumanCommand(scope, `diff ${result.info.id}`, scopeOptions);
        const syncCommand = scopedHumanCommand(scope, 'sync', scopeOptions);
        const installPreview = catalogInstallPreviewCommand(result.info, scope, scopeOptions);
        const next = snapshot.stale
          ? `Next: Re-run ${infoCommand} when remote access is available before making changes.`
          : result.info.installationState === 'not-installed'
            ? installPreview === undefined
              ? 'Next: This skill does not declare a supported install target; choose another skill or fix its metadata.'
              : `Next: Preview installation with ${installPreview}.`
            : result.info.installationState === 'current'
              ? `Next: Inspect its managed copy with ${diffCommand}.`
              : `Next: Review its managed copy with ${diffCommand}, then run ${syncCommand} when ready.`;
        return success(
          [
            `Scope: ${scope} (${root})`,
            `Library: ${snapshot.identity} @ ${snapshot.revision} (${snapshot.freshness}${snapshot.stale ? ', not current' : ''})`,
            ...(snapshot.stale
              ? [
                  'Warning: This skill information is from cached data and may differ from the remote library.',
                ]
              : []),
            formatCatalogSkillInfoHuman(result.info),
            next,
          ].join('\n'),
        );
      },
    );
  }

  async function handleValidate(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const raw = invocation.arguments[0];
    const selector = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    const formatOptions: ReadOnlyValidationFormatOptions = {
      ...humanScopeOptions(invocation),
      scope: invocation.options.global === true ? 'global' : 'project',
      selectorProvided: selector !== undefined,
    };
    if (selector !== undefined) {
      const candidate = isAbsolute(selector) ? selector : resolve(process.cwd(), selector);
      const pathLike = isAbsolute(selector) || selector.startsWith('.') || selector.includes('\\');
      if (pathLike || (await pathExists(candidate))) {
        const libraryMarker = join(candidate, '.skill-sync', 'library.json');
        if (await pathExists(libraryMarker)) {
          return validationResult(
            await validateReadOnlySource({ kind: 'library', rootPath: candidate }),
            jsonRequested(invocation),
            formatOptions,
          );
        }
        return validationResult(
          await validateReadOnlySource({ kind: 'local-path', path: candidate }),
          jsonRequested(invocation),
          formatOptions,
        );
      }
    }

    return await withCatalog(
      invocation,
      { allowStale: true },
      async ({ catalog, projectRoot: root, scope }) => {
        const scopedFormatOptions = { ...formatOptions, scope };
        if (selector === undefined) {
          return validationResult(
            await validateReadOnlySource({ kind: 'catalog', catalog }),
            jsonRequested(invocation),
            scopedFormatOptions,
          );
        }

        const manifest = await readProjectManifest(root);
        if (manifest !== undefined) {
          const tracked = resolveSkillSelectors(manifest.skills, [selector]);
          if (tracked.success && tracked.values[0] !== undefined) {
            const desired = tracked.values[0];
            return validationResult(
              await validateReadOnlySource({
                kind: 'installed-skill',
                id: desired.id,
                copies: desired.projections.map((projection) => ({
                  target: projection.target,
                  path: join(root, ...projection.destination.split('/')),
                })),
              }),
              jsonRequested(invocation),
              scopedFormatOptions,
            );
          }
        }
        return validationResult(
          await validateReadOnlySource({ kind: 'skill-id', catalog, selector }),
          jsonRequested(invocation),
          scopedFormatOptions,
        );
      },
    );
  }

  async function handleInstall(
    invocation: CommandInvocation,
    context?: WorkflowRuntimeContext,
  ): Promise<CommandResult<unknown>> {
    const dryRun = invocation.options.dryRun === true;
    const prompt = promptFor(invocation);
    const selectors = variadicArguments(invocation);
    const all = invocation.options.all === true;
    const expectedPlanFingerprint = optionString(invocation, 'expectPlan');
    const implicitPreview =
      !dryRun &&
      expectedPlanFingerprint === undefined &&
      promptingIsDisabled(invocation) &&
      invocation.options.yes !== true;
    requireSelectionBeforeResolution(invocation, selectors, all);

    return await withCatalog(
      invocation,
      dryRun || implicitPreview ? { cacheOnly: true } : {},
      async ({ catalog, projectRoot: root, scope, snapshot }) => {
        const selected = await selectCandidates(catalog.records, selectors, all, prompt, 'install');
        if (selected.length === 0) return noSelectionResult('install', jsonRequested(invocation));
        const targets = await selectedTargets(invocation, root, prompt);
        const incompatible = selected.flatMap((skill) =>
          targets
            .filter((target) => !skill.compatibleAgents.includes(target))
            .map((target) => `${skill.id} does not declare compatibility with ${target}`),
        );
        if (incompatible.length > 0) {
          throw new SkillSyncError(
            'INCOMPATIBLE_TARGET',
            incompatible.join('\n'),
            EXIT_CODES.validation,
          );
        }
        const gitignore =
          scope === 'project' ? await gitignorePolicy(invocation, prompt) : undefined;
        const installHumanOptions = (
          fingerprint: string,
          continuation?: 'external-apply' | 'inline-confirmation',
        ) => ({
          ...humanScopeOptions(invocation),
          applyCommand: formatInstallApplyCommand({
            all,
            fingerprint,
            ...(gitignore === undefined ? {} : { gitignore }),
            scope,
            selectors: all ? [] : selected.map((skill) => skill.id),
            targets,
            ...humanScopeOptions(invocation),
          }),
          ...(continuation === undefined ? {} : { continuation }),
        });
        const runInstall = async (preview: boolean, expectedFingerprint?: string) =>
          scope === 'global'
            ? await installGlobalSkills({
                dryRun: preview,
                ...(expectedFingerprint === undefined
                  ? {}
                  : { expectedPlanFingerprint: expectedFingerprint }),
                libraryIdentity: snapshot.identity,
                libraryRevision: snapshot.revision,
                paths: dependencies.paths,
                registry,
                skills: selected,
                ...(preview || context === undefined
                  ? {}
                  : { operationGuard: context.operationGuard }),
                ...(preview ? {} : { storage: globalMutationStorage(dependencies.paths) }),
                targets,
              })
            : await installProjectSkills({
                dryRun: preview,
                ...(expectedFingerprint === undefined
                  ? {}
                  : { expectedPlanFingerprint: expectedFingerprint }),
                ...(gitignore === undefined ? {} : { gitignore }),
                libraryIdentity: snapshot.identity,
                libraryRevision: snapshot.revision,
                projectRoot: root,
                registry,
                skills: selected,
                ...(preview || context === undefined
                  ? {}
                  : { operationGuard: context.operationGuard }),
                ...(preview ? {} : { storage: projectMutationStorage(dependencies.paths, root) }),
                targets,
              });

        let applyFingerprint = expectedPlanFingerprint;
        if (implicitPreview) {
          const preview = await runInstall(true);
          const result = {
            ...preview,
            freshness: snapshot.freshness,
            scope,
            stale: snapshot.stale,
          };
          return success(
            jsonRequested(invocation)
              ? result
              : formatInstallHuman(result, installHumanOptions(result.fingerprint)),
          );
        }
        if (!dryRun && applyFingerprint === undefined && !promptingIsDisabled(invocation)) {
          const preview = await runInstall(true);
          const humanPreview = formatInstallHuman(
            {
              ...preview,
              freshness: snapshot.freshness,
              scope,
              stale: snapshot.stale,
            },
            installHumanOptions(preview.fingerprint, 'inline-confirmation'),
          );
          if (installPlanHasNoChanges(preview)) return success(humanPreview);
          dependencies.io.writeStdout(`${humanPreview}\n`);
          const confirmed = await confirmation(
            prompt,
            'Apply exactly this reviewed install plan?',
            true,
          );
          if (!confirmed) return success('Install cancelled; no changes were made.');
          applyFingerprint = preview.fingerprint;
        }

        const plan = await runInstall(dryRun, applyFingerprint);
        const result = {
          ...plan,
          freshness: snapshot.freshness,
          scope,
          stale: snapshot.stale,
        };
        return success(
          jsonRequested(invocation)
            ? result
            : formatInstallHuman(result, installHumanOptions(result.fingerprint)),
        );
      },
    );
  }

  async function handleAdopt(
    invocation: CommandInvocation,
    context?: WorkflowRuntimeContext,
  ): Promise<CommandResult<unknown>> {
    const id = argumentString(invocation, 0, 'exact qualified skill ID');
    const rawTarget = optionString(invocation, 'target');
    if (rawTarget === undefined) {
      throw new SkillSyncError(
        'MISSING_TARGET_SELECTION',
        'Pass --target codex or --target claude for the existing unmanaged copy.',
        EXIT_CODES.usage,
      );
    }
    if (rawTarget !== 'codex' && rawTarget !== 'claude') {
      throw new SkillSyncError(
        'INVALID_TARGET',
        'Targets must be codex or claude.',
        EXIT_CODES.validation,
      );
    }
    const dryRun = invocation.options.dryRun === true;
    return await withCatalog(
      invocation,
      dryRun ? { cacheOnly: true } : {},
      async ({ catalog, projectRoot: root, scope, snapshot }) => {
        const skill = catalog.records.find((candidate) => candidate.id === id);
        if (skill === undefined) {
          throw new SkillSyncError(
            'UNKNOWN_SKILL_ID',
            `Adoption requires an exact qualified library skill ID; no skill matches ${id}.`,
            EXIT_CODES.validation,
            { id },
          );
        }
        const plan =
          scope === 'global'
            ? await adoptGlobalSkill({
                dryRun,
                libraryIdentity: snapshot.identity,
                libraryRevision: snapshot.revision,
                paths: dependencies.paths,
                registry,
                skill,
                ...(dryRun || context === undefined
                  ? {}
                  : { operationGuard: context.operationGuard }),
                ...(dryRun ? {} : { storage: globalMutationStorage(dependencies.paths) }),
                target: rawTarget,
              })
            : await adoptProjectSkill({
                dryRun,
                libraryIdentity: snapshot.identity,
                libraryRevision: snapshot.revision,
                projectRoot: root,
                registry,
                skill,
                ...(dryRun || context === undefined
                  ? {}
                  : { operationGuard: context.operationGuard }),
                ...(dryRun ? {} : { storage: projectMutationStorage(dependencies.paths, root) }),
                target: rawTarget,
              });
        const result = { ...plan, freshness: snapshot.freshness, scope, stale: snapshot.stale };
        return success(
          jsonRequested(invocation)
            ? result
            : formatAdoptHuman(result, humanScopeOptions(invocation)),
        );
      },
    );
  }

  async function handleUninstall(
    invocation: CommandInvocation,
    context?: WorkflowRuntimeContext,
  ): Promise<CommandResult<unknown>> {
    const selectors = variadicArguments(invocation);
    const all = invocation.options.all === true;
    const discardLocal = invocation.options.discardLocal === true;
    requireSelectionBeforeResolution(invocation, selectors, all);
    if (discardLocal && invocation.options.dryRun !== true) {
      requireNonInteractiveConfirmation(
        invocation,
        'Discarding local edits in automation requires --discard-local together with --yes.',
      );
    }
    const global = globalRequested(invocation);
    const root = global ? dependencies.paths.globalStateDirectory : await projectRoot(invocation);
    if (root === undefined) {
      throw new SkillSyncError(
        'GLOBAL_STATE_UNAVAILABLE',
        'Global skill state paths are unavailable.',
        EXIT_CODES.validation,
      );
    }
    const manifest = global
      ? await readGlobalManifest(dependencies.paths)
      : await readProjectManifest(root);
    if (manifest === undefined) {
      throw new SkillSyncError(
        global ? 'GLOBAL_STATE_REQUIRED' : 'PROJECT_STATE_REQUIRED',
        global
          ? 'No global skill-sync manifest is present.'
          : 'This project has no skill-sync manifest.',
        EXIT_CODES.validation,
      );
    }
    const prompt = promptFor(invocation);
    const selected = await selectCandidates(manifest.skills, selectors, all, prompt, 'uninstall');
    if (selected.length === 0) return noSelectionResult('uninstall', jsonRequested(invocation));
    const preview = global
      ? await uninstallGlobalSkills({
          discardLocal,
          dryRun: true,
          paths: dependencies.paths,
          ...(context === undefined ? {} : { operationGuard: context.operationGuard }),
          registry,
          skillIds: selected.map((skill) => skill.id),
        })
      : await uninstallProjectSkills({
          discardLocal,
          dryRun: true,
          projectRoot: root,
          skillIds: selected.map((skill) => skill.id),
        });
    if (invocation.options.dryRun === true) {
      return success(
        jsonRequested(invocation)
          ? preview
          : formatUninstallHuman(preview, {
              ...humanScopeOptions(invocation),
              requiresYes: promptingIsDisabled(invocation),
            }),
      );
    }

    let confirmed = false;
    if (preview.backup.required) {
      confirmed = await confirmation(
        prompt,
        `Discard local changes and uninstall ${preview.skills.map((skill) => skill.id).join(', ')}?`,
        discardLocal,
      );
      if (!confirmed) {
        requireNonInteractiveConfirmation(
          invocation,
          'Discarding local edits in automation requires --discard-local together with --yes.',
        );
        const cancelled = { ...preview, message: 'Uninstall cancelled before mutation.' };
        return success(
          jsonRequested(invocation)
            ? cancelled
            : formatUninstallHuman(cancelled, humanScopeOptions(invocation)),
        );
      }
    }
    const result = global
      ? await uninstallGlobalSkills({
          confirmed,
          discardLocal,
          ...(context === undefined ? {} : { operationGuard: context.operationGuard }),
          paths: dependencies.paths,
          registry,
          skillIds: selected.map((skill) => skill.id),
          storage: globalMutationStorage(dependencies.paths),
        })
      : await uninstallProjectSkills({
          confirmed,
          discardLocal,
          ...(context === undefined ? {} : { operationGuard: context.operationGuard }),
          projectRoot: root,
          skillIds: selected.map((skill) => skill.id),
          storage: projectMutationStorage(dependencies.paths, root),
        });
    const scopedResult = { ...result, scope: global ? ('global' as const) : ('project' as const) };
    return success(
      jsonRequested(invocation)
        ? scopedResult
        : formatUninstallHuman(scopedResult, humanScopeOptions(invocation)),
    );
  }

  async function handleInit(
    invocation: CommandInvocation,
    context?: WorkflowRuntimeContext,
  ): Promise<CommandResult<unknown>> {
    if (invocation.options.global === true || optionString(invocation, 'project') !== undefined) {
      throw new SkillSyncError(
        'SCOPE_OPTION_UNSUPPORTED',
        'init configures the user library and does not accept --global or --project.',
        EXIT_CODES.usage,
      );
    }
    const prompt = promptFor(invocation);
    const create = optionString(invocation, 'create');
    const transport = optionString(invocation, 'transport');
    const visibility = optionString(invocation, 'visibility');
    let url =
      typeof invocation.arguments[0] === 'string' && invocation.arguments[0].length > 0
        ? invocation.arguments[0]
        : undefined;
    if (create !== undefined && url !== undefined) {
      throw new SkillSyncError(
        'CONFLICTING_INIT_INPUT',
        'Pass either a repository URL or --create, not both.',
        EXIT_CODES.usage,
      );
    }
    if (create === undefined && (transport !== undefined || visibility !== undefined)) {
      throw new SkillSyncError(
        'INIT_OPTION_REQUIRES_CREATE',
        '--transport and --visibility apply only when --create is supplied.',
        EXIT_CODES.usage,
      );
    }
    const branch = optionString(invocation, 'branch');
    if (create === undefined) {
      url ??= await prompt.text(
        'Skill library repository URL',
        'a repository URL or --create <owner/name>',
      );
    }
    const request: LibraryInitializationRequest =
      create === undefined
        ? {
            kind: 'connect',
            url: url ?? '',
            ...(branch === undefined ? {} : { branch }),
          }
        : {
            kind: 'create',
            repository: create,
            ...(branch === undefined ? {} : { branch }),
            ...(transport === undefined ? {} : { transport: transport as 'https' | 'ssh' }),
            ...(visibility === undefined
              ? {}
              : { visibility: visibility as 'private' | 'public' | 'internal' }),
          };
    const expectedPlanFingerprint = optionString(invocation, 'expectPlan');
    const applyOptions =
      context === undefined
        ? {}
        : {
            recovery: {
              journalDirectory: join(dependencies.paths.journalsDirectory, 'library'),
              operationGuard: context.operationGuard,
              registerRecovery: context.registerRecovery,
              rootFingerprint: transactionRootFingerprint(dependencies.paths.configDirectory),
            },
            signal: context.signal,
          };
    if (expectedPlanFingerprint !== undefined) {
      context?.throwIfCancelled();
      const result = await dependencies.lifecycle.applyInitialization(
        request,
        expectedPlanFingerprint,
        applyOptions,
      );
      return success(jsonRequested(invocation) ? result : formatInitHuman(result));
    }
    const plan = await dependencies.lifecycle.planInitialization(
      request,
      context === undefined ? {} : { signal: context.signal },
    );
    if (invocation.options.dryRun === true) {
      return success(jsonRequested(invocation) ? plan : formatInitPlanHuman(plan));
    }
    const preview = formatInitPlanHuman(plan);
    if (promptingIsDisabled(invocation) && invocation.options.yes !== true) {
      return success(jsonRequested(invocation) ? plan : preview);
    }
    if (!jsonRequested(invocation)) {
      dependencies.io.writeStdout(`${preview}\n`);
    }
    const confirmed = await confirmation(prompt, 'Apply exactly this reviewed setup plan?', true);
    if (!confirmed) {
      return success(
        jsonRequested(invocation)
          ? plan
          : 'Setup cancelled; no repository or saved configuration changes were made.',
      );
    }
    context?.throwIfCancelled();
    const result = await dependencies.lifecycle.applyInitialization(
      request,
      plan.fingerprint,
      applyOptions,
    );
    return success(jsonRequested(invocation) ? result : formatInitHuman(result));
  }

  async function handleAdd(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selectedConnection = await connection();
    const group = optionString(invocation, 'group');
    const result = await dependencies.lifecycle.add({
      sourcePath: argumentString(invocation, 0, 'local skill path'),
      remoteUrl: selectedConnection.url,
      branch: selectedConnection.branch,
      dryRun: invocation.options.dryRun === true,
      ...(group === undefined ? {} : { group }),
    });
    return success(jsonRequested(invocation) ? result : formatAddHuman(result));
  }

  async function trackedSelection(
    invocation: CommandInvocation,
    command: string,
  ): Promise<{
    readonly projectRoot: string;
    readonly ids: readonly string[];
  }> {
    const root = await projectRoot(invocation);
    const manifest = await readProjectManifest(root);
    if (manifest === undefined) {
      throw new SkillSyncError(
        'PROJECT_STATE_REQUIRED',
        `${command} requires a managed project manifest.`,
        EXIT_CODES.validation,
      );
    }
    const selected = await selectCandidates(
      manifest.skills,
      variadicArguments(invocation),
      invocation.options.all === true,
      promptFor(invocation),
      command,
    );
    return { projectRoot: root, ids: selected.map((skill) => skill.id) };
  }

  async function handlePublish(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selectedConnection = await connection();
    const selected = await trackedSelection(invocation, 'publish');
    if (selected.ids.length === 0) return noSelectionResult('publish', jsonRequested(invocation));

    const fromTarget = optionString(invocation, 'from');
    const baseRequest = {
      ids: selected.ids,
      projectRoot: selected.projectRoot,
      remoteUrl: selectedConnection.url,
      branch: selectedConnection.branch,
      ...(fromTarget === undefined ? {} : { fromTarget }),
    };
    if (invocation.options.dryRun === true) {
      const result = await dependencies.lifecycle.publish({ ...baseRequest, dryRun: true });
      return success(
        jsonRequested(invocation)
          ? result
          : formatPublishHuman(result, humanScopeOptions(invocation)),
      );
    }
    if (invocation.options.all === true) {
      const preview = await dependencies.lifecycle.publish({ ...baseRequest, dryRun: true });
      const changedIds = preview.skills.filter((skill) => skill.changed).map((skill) => skill.id);
      if (changedIds.length === 0) {
        return success(
          jsonRequested(invocation)
            ? preview
            : formatPublishHuman({ ...preview, dryRun: false }, humanScopeOptions(invocation)),
        );
      }
      const result = await dependencies.lifecycle.publish({ ...baseRequest, ids: changedIds });
      return success(
        jsonRequested(invocation)
          ? result
          : formatPublishHuman(result, humanScopeOptions(invocation)),
      );
    }
    const result = await dependencies.lifecycle.publish(baseRequest);
    return success(
      jsonRequested(invocation)
        ? result
        : formatPublishHuman(result, humanScopeOptions(invocation)),
    );
  }

  async function handleGroup(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selectedConnection = await connection();
    switch (invocation.command) {
      case 'group:list': {
        const result = await dependencies.lifecycle.groupList({
          remoteUrl: selectedConnection.url,
          branch: selectedConnection.branch,
        });
        return success(jsonRequested(invocation) ? result : formatGroupListHuman(result));
      }
      case 'group:create': {
        const group = argumentString(invocation, 0, 'group path');
        const result = await dependencies.lifecycle.groupCreate({
          group,
          remoteUrl: selectedConnection.url,
          branch: selectedConnection.branch,
        });
        return success(
          jsonRequested(invocation)
            ? result
            : formatGroupMutationHuman({ kind: 'create', group }, result),
        );
      }
      case 'group:rename': {
        const from = argumentString(invocation, 0, 'source group');
        const to = argumentString(invocation, 1, 'destination group');
        const result = await dependencies.lifecycle.groupRename({
          from,
          to,
          remoteUrl: selectedConnection.url,
          branch: selectedConnection.branch,
        });
        return success(
          jsonRequested(invocation)
            ? result
            : formatGroupMutationHuman({ kind: 'rename', from, to }, result),
        );
      }
      case 'group:remove': {
        const group = argumentString(invocation, 0, 'group path');
        const recursive = invocation.options.recursive === true;
        if (invocation.options.dryRun !== true) {
          requireNonInteractiveConfirmation(
            invocation,
            'Removing a library group in automation requires --yes and --recursive when nonempty.',
          );
        }
        const preview = await dependencies.lifecycle.groupRemove({
          group,
          recursive,
          confirmed: false,
          dryRun: true,
          remoteUrl: selectedConnection.url,
          branch: selectedConnection.branch,
        });
        if (invocation.options.dryRun === true) {
          return success(
            jsonRequested(invocation)
              ? preview
              : formatGroupMutationHuman({ kind: 'remove', group }, preview, {
                  requiresYes: promptingIsDisabled(invocation),
                }),
          );
        }
        if (preview.requiresRecursive === true) {
          return reportFailure(
            'GROUP_NOT_EMPTY',
            `Group ${group} is not empty; review affected IDs and pass --recursive.`,
            preview,
            EXIT_CODES.conflict,
            jsonRequested(invocation),
          );
        }
        const confirmed = await confirmation(
          promptFor(invocation),
          `Remove group ${group}${preview.affectedIds.length === 0 ? '' : ` and orphan ${String(preview.affectedIds.length)} skill(s)`}?`,
          recursive || preview.affectedIds.length === 0,
        );
        if (!confirmed) {
          requireNonInteractiveConfirmation(
            invocation,
            'Removing a library group in automation requires --yes and --recursive when nonempty.',
          );
          const cancelled = { ...preview, changed: false, message: 'Removal cancelled.' };
          return success(
            jsonRequested(invocation)
              ? cancelled
              : formatGroupMutationHuman({ kind: 'remove', group }, cancelled),
          );
        }
        const result = await dependencies.lifecycle.groupRemove({
          group,
          recursive,
          confirmed: true,
          remoteUrl: selectedConnection.url,
          branch: selectedConnection.branch,
        });
        return success(
          jsonRequested(invocation)
            ? result
            : formatGroupMutationHuman({ kind: 'remove', group }, result),
        );
      }
      default:
        throw new SkillSyncError('UNKNOWN_COMMAND', invocation.command, EXIT_CODES.usage);
    }
  }

  async function handleLibraryRemove(
    invocation: CommandInvocation,
  ): Promise<CommandResult<unknown>> {
    const id = argumentString(invocation, 0, 'skill ID');
    if (invocation.options.dryRun !== true) {
      requireNonInteractiveConfirmation(
        invocation,
        'Removing a canonical library skill in automation requires --yes.',
      );
    }
    const selectedConnection = await connection();
    const preview = await dependencies.lifecycle.libraryRemove({
      id,
      confirmed: false,
      dryRun: true,
      remoteUrl: selectedConnection.url,
      branch: selectedConnection.branch,
    });
    if (invocation.options.dryRun === true) {
      return success(
        jsonRequested(invocation)
          ? preview
          : formatLibraryRemoveHuman(preview, {
              requiresYes: promptingIsDisabled(invocation),
            }),
      );
    }
    const confirmed = await confirmation(
      promptFor(invocation),
      `Delete canonical skill ${id}? Project copies will remain installed.`,
      true,
    );
    if (!confirmed) {
      requireNonInteractiveConfirmation(
        invocation,
        'Removing a canonical library skill in automation requires --yes.',
      );
      const cancelled = { ...preview, changed: false, message: 'Removal cancelled.' };
      return success(jsonRequested(invocation) ? cancelled : formatLibraryRemoveHuman(cancelled));
    }
    const result = await dependencies.lifecycle.libraryRemove({
      id,
      confirmed: true,
      remoteUrl: selectedConnection.url,
      branch: selectedConnection.branch,
    });
    return success(jsonRequested(invocation) ? result : formatLibraryRemoveHuman(result));
  }

  async function handleStatus(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const global = globalRequested(invocation);
    if (global) {
      const { globalLockFile, globalManifestFile, globalStateDirectory } = dependencies.paths;
      if (
        globalLockFile !== undefined &&
        globalManifestFile !== undefined &&
        globalStateDirectory !== undefined
      ) {
        const [manifestExists, lockExists] = await Promise.all([
          pathExists(globalManifestFile),
          pathExists(globalLockFile),
        ]);
        if (!manifestExists && !lockExists) {
          const libraryConfigured =
            (await dependencies.config.list()).effective.value.libraryUrl !== undefined;
          const report = emptyGlobalStatusReport(globalStateDirectory, libraryConfigured);
          return success(jsonRequested(invocation) ? report : formatEmptyGlobalStatusHuman(report));
        }
      }
      const selectedConnection = await connection();
      const report = await inspectGlobalStatus({
        allowStale: true,
        library: revisionProvider(selectedConnection),
        offline: invocation.options.offline === true,
        paths: dependencies.paths,
        registry,
      });
      return success(jsonRequested(invocation) ? report : formatGlobalStatusHuman(report));
    }

    const root = await projectRoot(invocation);
    const [manifest, lock] = await Promise.all([readProjectManifest(root), readProjectLock(root)]);
    if ((manifest === undefined) !== (lock === undefined)) {
      throw new SkillSyncError(
        'INCOMPLETE_PROJECT_STATE',
        'The project manifest and lock must be present together.',
        EXIT_CODES.validation,
      );
    }
    if (manifest === undefined && lock === undefined) {
      const libraryConfigured =
        (await dependencies.config.list()).effective.value.libraryUrl !== undefined;
      const report = emptyProjectStatusReport(root, libraryConfigured);
      return success(
        jsonRequested(invocation)
          ? report
          : formatEmptyProjectStatusHuman(report, {
              explicitProject: optionString(invocation, 'project') !== undefined,
            }),
      );
    }

    const selectedConnection = await connection();
    const report = await inspectProjectStatus({
      allowStale: true,
      library: revisionProvider(selectedConnection),
      offline: invocation.options.offline === true,
      projectRoot: root,
    });
    return success(
      jsonRequested(invocation)
        ? report
        : formatProjectStatusHuman(report, humanScopeOptions(invocation)),
    );
  }

  async function handleDiff(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selectedConnection = await connection();
    const global = globalRequested(invocation);
    const selector = argumentString(invocation, 0, 'tracked skill ID');
    if (global) {
      const report = await inspectGlobalDiff({
        allowStale: true,
        library: revisionProvider(selectedConnection),
        paths: dependencies.paths,
        registry,
        selector,
      });
      return success(jsonRequested(invocation) ? report : formatGlobalDiffHuman(report));
    }
    const report = await inspectProjectDiff({
      allowStale: true,
      library: revisionProvider(selectedConnection),
      projectRoot: await projectRoot(invocation),
      selector,
    });
    return success(
      jsonRequested(invocation)
        ? report
        : formatProjectDiffHuman(report, humanScopeOptions(invocation)),
    );
  }

  async function runReconciliation(
    invocation: CommandInvocation,
    context: WorkflowRuntimeContext | undefined,
  ): Promise<CommandResult<unknown>> {
    const operation = invocation.command as 'sync' | 'update';
    const discardLocal = invocation.options.discardLocal === true;
    const check = operation === 'sync' && invocation.options.check === true;
    const dryRun = invocation.options.dryRun === true;
    const offlineRevision = optionString(invocation, 'offline');
    const explicitSelectors = operation === 'update' ? variadicArguments(invocation) : [];
    const all = operation === 'sync' || invocation.options.all === true;
    if (operation === 'update') {
      requireSelectionBeforeResolution(invocation, explicitSelectors, all);
    }
    if (discardLocal && !dryRun && !check) {
      requireNonInteractiveConfirmation(
        invocation,
        'Discarding local edits in automation requires --discard-local together with --yes.',
      );
    }
    const global = globalRequested(invocation);
    const root = global ? dependencies.paths.globalStateDirectory : await projectRoot(invocation);
    if (root === undefined) {
      throw new SkillSyncError(
        'GLOBAL_STATE_UNAVAILABLE',
        'Global skill state paths are unavailable.',
        EXIT_CODES.validation,
      );
    }
    let resolvedExplicitSelectors = explicitSelectors;
    if (operation === 'update' && explicitSelectors.length > 0) {
      const manifest = global
        ? await readGlobalManifest(dependencies.paths)
        : await readProjectManifest(root);
      if (manifest === undefined) {
        throw new SkillSyncError(
          global ? 'GLOBAL_STATE_REQUIRED' : 'PROJECT_STATE_REQUIRED',
          global
            ? 'update requires a managed global manifest.'
            : 'update requires a managed project manifest.',
          EXIT_CODES.validation,
        );
      }
      const selected = resolveSkillSelectors(manifest.skills, explicitSelectors);
      if (!selected.success) return selectionFailure(selected.errors);
      resolvedExplicitSelectors = selected.values.map((skill) => skill.id);
    }
    const selectedConnection = await connection();
    const prompt = promptFor(invocation);

    return await withSharedRevision(selectedConnection, offlineRevision, async (sharedProvider) => {
      let selectors = resolvedExplicitSelectors;
      if (operation === 'update' && !all && selectors.length === 0) {
        const status = global
          ? await inspectGlobalStatus({
              library: sharedProvider,
              paths: dependencies.paths,
              registry,
            })
          : await inspectProjectStatus({ library: sharedProvider, projectRoot: root });
        const eligible = status.skills.filter((skill) =>
          ['outdated', 'missing', 'locally-modified', 'conflicted'].includes(skill.state),
        );
        selectors = await prompt.selectMany(
          'Select tracked skills to update',
          eligible.map((skill) => ({
            name: `${skill.id} (${skill.state})`,
            value: skill.id,
          })),
          { searchable: true },
        );
        if (selectors.length === 0) return noSelectionResult('update', jsonRequested(invocation));
      }

      const invoke = async (
        preview: boolean,
        confirmed: boolean,
      ): Promise<ProjectReconciliationReport | GlobalReconciliationReport> => {
        context?.throwIfCancelled();
        const common = {
          check,
          confirmed,
          discardLocal,
          dryRun: preview || dryRun,
          library: sharedProvider,
          ...(context === undefined ? {} : { operationGuard: context.operationGuard }),
          ...(offlineRevision === undefined ? {} : { offlineRevision }),
        };
        const report = global
          ? operation === 'sync'
            ? await syncGlobalSkills({
                ...common,
                paths: dependencies.paths,
                registry,
                ...(preview || dryRun || check
                  ? {}
                  : { storage: globalMutationStorage(dependencies.paths) }),
              })
            : await updateGlobalSkills({
                ...common,
                all,
                paths: dependencies.paths,
                registry,
                selectors,
                ...(preview || dryRun || check
                  ? {}
                  : { storage: globalMutationStorage(dependencies.paths) }),
              })
          : operation === 'sync'
            ? await syncProjectSkills({
                ...common,
                projectRoot: root,
                ...(preview || dryRun || check
                  ? {}
                  : { storage: projectMutationStorage(dependencies.paths, root) }),
              })
            : await updateProjectSkills({
                ...common,
                all,
                projectRoot: root,
                selectors,
                ...(preview || dryRun || check
                  ? {}
                  : { storage: projectMutationStorage(dependencies.paths, root) }),
              });
        context?.throwIfCancelled();
        return report;
      };

      if (dryRun || check || !discardLocal) {
        return reconciliationResult(
          await invoke(false, false),
          jsonRequested(invocation),
          humanScopeOptions(invocation),
        );
      }

      const preview = await invoke(true, false);
      const destructiveIds = preview.skills
        .filter((skill) => skill.action === 'discard-local')
        .map((skill) => skill.id);
      if (destructiveIds.length === 0) {
        return reconciliationResult(
          await invoke(false, false),
          jsonRequested(invocation),
          humanScopeOptions(invocation),
        );
      }
      const confirmed = await confirmation(
        prompt,
        `Discard local changes for ${destructiveIds.join(', ')} after creating a backup?`,
        true,
      );
      if (!confirmed) {
        requireNonInteractiveConfirmation(
          invocation,
          'Discarding local edits in automation requires --discard-local together with --yes.',
        );
        return success(
          jsonRequested(invocation)
            ? { ...preview, message: 'Reconciliation cancelled before mutation.' }
            : `${
                'scope' in preview
                  ? formatGlobalReconciliationHuman(preview)
                  : formatProjectReconciliationHuman(preview, humanScopeOptions(invocation))
              }\nReconciliation cancelled before mutation.`,
        );
      }
      return reconciliationResult(
        await invoke(false, true),
        jsonRequested(invocation),
        humanScopeOptions(invocation),
      );
    });
  }

  return async (invocation, context) => {
    try {
      context?.throwIfCancelled();
      switch (invocation.command) {
        case 'init':
          return await handleInit(invocation, context);
        case 'install':
          return await handleInstall(invocation, context);
        case 'adopt':
          return await handleAdopt(invocation, context);
        case 'sync':
        case 'update':
          return await runReconciliation(invocation, context);
        case 'add':
          return await handleAdd(invocation);
        case 'publish':
          return await handlePublish(invocation);
        case 'list':
          return await handleList(invocation);
        case 'info':
          return await handleInfo(invocation);
        case 'diff':
          return await handleDiff(invocation);
        case 'status':
          return await handleStatus(invocation);
        case 'uninstall':
          return await handleUninstall(invocation, context);
        case 'validate':
          return await handleValidate(invocation);
        case 'library:remove':
          return await handleLibraryRemove(invocation);
        case 'group:list':
        case 'group:create':
        case 'group:rename':
        case 'group:remove':
          return await handleGroup(invocation);
        default:
          throw new SkillSyncError(
            'UNKNOWN_COMMAND',
            `Unknown command ${invocation.command}.`,
            EXIT_CODES.usage,
          );
      }
    } catch (error) {
      return mappedOperationalFailure(error);
    }
  };
}
