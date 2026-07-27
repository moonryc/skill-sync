import { lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { ZodError } from 'zod';

import type { CatalogInstallationState, CatalogScanResult } from '../application/catalog.js';
import { catalogFromValidatedLibrary } from '../application/catalog.js';
import type { ConfigService } from '../application/config-service.js';
import {
  LibraryLifecycleError,
  type ValidatedLibrarySnapshot,
} from '../application/library-lifecycle.js';
import type { LibraryLifecycleService } from '../application/library-lifecycle.js';
import {
  installProjectSkills,
  uninstallProjectSkills,
} from '../application/project-installation.js';
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
  type ProjectReconciliationReport,
  type ResolvedLibraryRevision,
} from '../application/project-reconciliation.js';
import { projectMutationStorage } from '../application/project-storage.js';
import {
  formatCatalogListHuman,
  formatCatalogSkillInfoHuman,
  getCatalogSkillInfo,
  listCatalog,
  validateReadOnlySource,
  type ReadOnlyValidationResult,
} from '../application/read-only.js';
import { resolveSkillSelectors, selectAllSkills } from '../application/selectors.js';
import { IdentifierValidationError } from '../domain/identifiers.js';
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
import { AdvisoryLockUnavailableError } from '../infrastructure/transactions.js';
import type { RuntimeIo } from '../ports/index.js';
import { TargetRegistry, type TargetName } from '../targets/index.js';
import { PromptAdapter, terminalIsInteractive } from '../ui/prompt.js';
import type { CommandInvocation } from './program.js';

export interface WorkflowRuntimeContext {
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
  readonly snapshot: ValidatedLibrarySnapshot;
}

const LIFECYCLE_REPOSITORY_ERRORS = new Set([
  'GITHUB_CREATE_FAILED',
  'REMOTE_ACCESS_FAILED',
  'CONFIG_PERSIST_FAILED',
]);
const LIFECYCLE_CONFLICT_ERRORS = new Set([
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

function noSelectionResult(command: string): CommandResult<unknown> {
  return success({ applied: false, command, selectedIds: [], message: 'No skills selected.' });
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
        message: error.message,
        details: { lockPath: error.lockPath },
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
    return failure({ code: error.code, message: error.message, details: error.details }, exitCode);
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

function validationResult(result: ReadOnlyValidationResult, json: boolean): CommandResult<unknown> {
  if (result.valid) return success(result);
  const message = result.errors.map((error) => `${error.source}: ${error.message}`).join('\n');
  return reportFailure('VALIDATION_FAILED', message, result, EXIT_CODES.validation, json);
}

export function reconciliationResult(
  report: ProjectReconciliationReport,
  json: boolean,
): CommandResult<unknown> {
  const human = formatProjectReconciliationHuman(report);
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
        'No default skill library is configured. Run skill-sync init first.',
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

  async function projectRoot(invocation: CommandInvocation): Promise<string> {
    if (invocation.options.global === true && optionString(invocation, 'project') !== undefined) {
      throw new SkillSyncError(
        'CONFLICTING_SCOPE_OPTIONS',
        'Pass either --global or --project, not both.',
        EXIT_CODES.usage,
      );
    }
    if (invocation.options.global === true) {
      throw new SkillSyncError(
        'GLOBAL_SCOPE_NOT_IMPLEMENTED',
        'Global scope is not yet available for this command.',
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

  async function withCatalog<T>(
    invocation: CommandInvocation,
    options: { readonly allowStale?: boolean; readonly cacheOnly?: boolean },
    consume: (context: CatalogContext) => Promise<T> | T,
  ): Promise<T> {
    const selectedProjectRoot = await projectRoot(invocation);
    const selectedConnection = await connection();
    return await dependencies.lifecycle.withValidatedLibrary(
      {
        remoteUrl: selectedConnection.url,
        branch: selectedConnection.branch,
        ...(options.allowStale === undefined ? {} : { allowStale: options.allowStale }),
        ...(options.cacheOnly === undefined ? {} : { cacheOnly: options.cacheOnly }),
      },
      async (snapshot) => {
        const installationStates = await projectInstallationStates(selectedProjectRoot, snapshot);
        return await consume({
          catalog: catalogFromValidatedLibrary(snapshot.library, {
            installationStates,
            sourceRevision: snapshot.revision,
          }),
          projectRoot: selectedProjectRoot,
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

    const detected = new Set(await registry.detect(root));
    const choices = registry.list().map((target) => ({
      name: detected.has(target.name) ? `${target.name} (detected)` : target.name,
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
    return await withCatalog(invocation, { allowStale: true }, ({ catalog, snapshot }) => {
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
          stale: snapshot.stale,
          skills: result.items,
        });
      }
      const warning = snapshot.stale
        ? `Warning: using ${snapshot.freshness}; this catalog is not current with the remote.\n`
        : '';
      return success(`${warning}${formatCatalogListHuman(result.items)}`);
    });
  }

  async function handleInfo(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selector = argumentString(invocation, 0, 'skill ID');
    return await withCatalog(invocation, { allowStale: true }, ({ catalog, snapshot }) => {
      const result = getCatalogSkillInfo(catalog, selector);
      if (!result.ok) {
        return reportFailure(
          'SKILL_INFO_FAILED',
          result.errors.map((error) => error.message).join('\n'),
          result,
          EXIT_CODES.validation,
          jsonRequested(invocation),
        );
      }
      return success(
        jsonRequested(invocation)
          ? { ...result.info, freshness: snapshot.freshness, stale: snapshot.stale }
          : formatCatalogSkillInfoHuman(result.info),
      );
    });
  }

  async function handleValidate(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const raw = invocation.arguments[0];
    const selector = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    if (selector !== undefined) {
      const candidate = isAbsolute(selector) ? selector : resolve(process.cwd(), selector);
      const pathLike = isAbsolute(selector) || selector.startsWith('.') || selector.includes('\\');
      if (pathLike || (await pathExists(candidate))) {
        return validationResult(
          await validateReadOnlySource({ kind: 'local-path', path: candidate }),
          jsonRequested(invocation),
        );
      }
    }

    return await withCatalog(
      invocation,
      { allowStale: true },
      async ({ catalog, projectRoot: root }) => {
        if (selector === undefined) {
          return validationResult(
            await validateReadOnlySource({ kind: 'catalog', catalog }),
            jsonRequested(invocation),
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
            );
          }
        }
        return validationResult(
          await validateReadOnlySource({ kind: 'skill-id', catalog, selector }),
          jsonRequested(invocation),
        );
      },
    );
  }

  async function handleInstall(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const dryRun = invocation.options.dryRun === true;
    const prompt = promptFor(invocation);
    const selectors = variadicArguments(invocation);
    const all = invocation.options.all === true;
    requireSelectionBeforeResolution(invocation, selectors, all);

    return await withCatalog(
      invocation,
      dryRun ? { cacheOnly: true } : {},
      async ({ catalog, projectRoot: root, snapshot }) => {
        const selected = await selectCandidates(catalog.records, selectors, all, prompt, 'install');
        if (selected.length === 0) return noSelectionResult('install');
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
        const gitignore = await gitignorePolicy(invocation, prompt);
        const plan = await installProjectSkills({
          dryRun,
          gitignore,
          libraryIdentity: snapshot.identity,
          libraryRevision: snapshot.revision,
          projectRoot: root,
          registry,
          skills: selected,
          ...(dryRun ? {} : { storage: projectMutationStorage(dependencies.paths, root) }),
          targets,
        });
        return success({
          ...plan,
          freshness: snapshot.freshness,
          stale: snapshot.stale,
        });
      },
    );
  }

  async function handleUninstall(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
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
    const root = await projectRoot(invocation);
    const manifest = await readProjectManifest(root);
    if (manifest === undefined) {
      throw new SkillSyncError(
        'PROJECT_STATE_REQUIRED',
        'This project has no skill-sync manifest.',
        EXIT_CODES.validation,
      );
    }
    const prompt = promptFor(invocation);
    const selected = await selectCandidates(manifest.skills, selectors, all, prompt, 'uninstall');
    if (selected.length === 0) return noSelectionResult('uninstall');
    const preview = await uninstallProjectSkills({
      discardLocal,
      dryRun: true,
      projectRoot: root,
      skillIds: selected.map((skill) => skill.id),
    });
    if (invocation.options.dryRun === true) return success(preview);

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
        return success({ ...preview, message: 'Uninstall cancelled before mutation.' });
      }
    }
    const result = await uninstallProjectSkills({
      confirmed,
      discardLocal,
      projectRoot: root,
      skillIds: selected.map((skill) => skill.id),
      storage: projectMutationStorage(dependencies.paths, root),
    });
    return success(result);
  }

  async function handleInit(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
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
    if (create !== undefined) {
      const branch = optionString(invocation, 'branch');
      const result = await dependencies.lifecycle.create({
        repository: create,
        ...(branch === undefined ? {} : { branch }),
        ...(transport === undefined ? {} : { transport: transport as 'https' | 'ssh' }),
        ...(visibility === undefined
          ? {}
          : {
              visibility: visibility as 'private' | 'public' | 'internal',
            }),
      });
      return success(result);
    }
    url ??= await prompt.text('GitHub skill library URL', 'repository URL or --create');
    const branch = optionString(invocation, 'branch');
    try {
      return success(
        await dependencies.lifecycle.init({
          url,
          ...(branch === undefined ? {} : { branch }),
        }),
      );
    } catch (error) {
      if (
        !(error instanceof LibraryLifecycleError) ||
        error.code !== 'REMOTE_EMPTY_CONFIRMATION_REQUIRED'
      ) {
        throw error;
      }
      const confirmed = await confirmation(
        prompt,
        'The remote is empty. Initialize it as a skill-sync library?',
        true,
      );
      if (!confirmed) {
        throw new SkillSyncError(
          'EMPTY_REMOTE_CONFIRMATION_REQUIRED',
          'Empty remote initialization was not confirmed.',
          EXIT_CODES.usage,
        );
      }
      return success(
        await dependencies.lifecycle.init({
          url,
          initializeEmpty: true,
          ...(branch === undefined ? {} : { branch }),
        }),
      );
    }
  }

  async function handleAdd(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selectedConnection = await connection();
    const group = optionString(invocation, 'group');
    return success(
      await dependencies.lifecycle.add({
        sourcePath: argumentString(invocation, 0, 'local skill path'),
        remoteUrl: selectedConnection.url,
        branch: selectedConnection.branch,
        dryRun: invocation.options.dryRun === true,
        ...(group === undefined ? {} : { group }),
      }),
    );
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
    if (selected.ids.length === 0) return noSelectionResult('publish');

    const fromTarget = optionString(invocation, 'from');
    const baseRequest = {
      ids: selected.ids,
      projectRoot: selected.projectRoot,
      remoteUrl: selectedConnection.url,
      branch: selectedConnection.branch,
      ...(fromTarget === undefined ? {} : { fromTarget }),
    };
    if (invocation.options.dryRun === true) {
      return success(await dependencies.lifecycle.publish({ ...baseRequest, dryRun: true }));
    }
    if (invocation.options.all === true) {
      const preview = await dependencies.lifecycle.publish({ ...baseRequest, dryRun: true });
      const changedIds = preview.skills.filter((skill) => skill.changed).map((skill) => skill.id);
      if (changedIds.length === 0) return success(preview);
      return success(await dependencies.lifecycle.publish({ ...baseRequest, ids: changedIds }));
    }
    return success(await dependencies.lifecycle.publish(baseRequest));
  }

  async function handleGroup(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const selectedConnection = await connection();
    switch (invocation.command) {
      case 'group:list':
        return success(
          await dependencies.lifecycle.groupList({
            remoteUrl: selectedConnection.url,
            branch: selectedConnection.branch,
          }),
        );
      case 'group:create':
        return success(
          await dependencies.lifecycle.groupCreate({
            group: argumentString(invocation, 0, 'group path'),
            remoteUrl: selectedConnection.url,
            branch: selectedConnection.branch,
          }),
        );
      case 'group:rename':
        return success(
          await dependencies.lifecycle.groupRename({
            from: argumentString(invocation, 0, 'source group'),
            to: argumentString(invocation, 1, 'destination group'),
            remoteUrl: selectedConnection.url,
            branch: selectedConnection.branch,
          }),
        );
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
        if (invocation.options.dryRun === true) return success(preview);
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
          return success({ ...preview, changed: false, message: 'Removal cancelled.' });
        }
        return success(
          await dependencies.lifecycle.groupRemove({
            group,
            recursive,
            confirmed: true,
            remoteUrl: selectedConnection.url,
            branch: selectedConnection.branch,
          }),
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
    if (invocation.options.dryRun === true) return success(preview);
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
      return success({ ...preview, changed: false, message: 'Removal cancelled.' });
    }
    return success(
      await dependencies.lifecycle.libraryRemove({
        id,
        confirmed: true,
        remoteUrl: selectedConnection.url,
        branch: selectedConnection.branch,
      }),
    );
  }

  async function handleStatus(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const root = await projectRoot(invocation);
    const selectedConnection = await connection();
    const report = await inspectProjectStatus({
      allowStale: true,
      library: revisionProvider(selectedConnection),
      offline: invocation.options.offline === true,
      projectRoot: root,
    });
    return success(jsonRequested(invocation) ? report : formatProjectStatusHuman(report));
  }

  async function handleDiff(invocation: CommandInvocation): Promise<CommandResult<unknown>> {
    const root = await projectRoot(invocation);
    const selectedConnection = await connection();
    const report = await inspectProjectDiff({
      allowStale: true,
      library: revisionProvider(selectedConnection),
      projectRoot: root,
      selector: argumentString(invocation, 0, 'tracked skill ID'),
    });
    return success(jsonRequested(invocation) ? report : formatProjectDiffHuman(report));
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
    const root = await projectRoot(invocation);
    let resolvedExplicitSelectors = explicitSelectors;
    if (operation === 'update' && explicitSelectors.length > 0) {
      const manifest = await readProjectManifest(root);
      if (manifest === undefined) {
        throw new SkillSyncError(
          'PROJECT_STATE_REQUIRED',
          'update requires a managed project manifest.',
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
        const status = await inspectProjectStatus({ library: sharedProvider, projectRoot: root });
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
        if (selectors.length === 0) return noSelectionResult('update');
      }

      const invoke = async (
        preview: boolean,
        confirmed: boolean,
      ): Promise<ProjectReconciliationReport> => {
        context?.throwIfCancelled();
        const common = {
          check,
          confirmed,
          discardLocal,
          dryRun: preview || dryRun,
          library: sharedProvider,
          ...(offlineRevision === undefined ? {} : { offlineRevision }),
          projectRoot: root,
          ...(preview || dryRun || check
            ? {}
            : { storage: projectMutationStorage(dependencies.paths, root) }),
        };
        const report =
          operation === 'sync'
            ? await syncProjectSkills(common)
            : await updateProjectSkills({ ...common, all, selectors });
        context?.throwIfCancelled();
        return report;
      };

      if (dryRun || check || !discardLocal) {
        return reconciliationResult(await invoke(false, false), jsonRequested(invocation));
      }

      const preview = await invoke(true, false);
      const destructiveIds = preview.skills
        .filter((skill) => skill.action === 'discard-local')
        .map((skill) => skill.id);
      if (destructiveIds.length === 0) {
        return reconciliationResult(await invoke(false, false), jsonRequested(invocation));
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
            : `${formatProjectReconciliationHuman(preview)}\nReconciliation cancelled before mutation.`,
        );
      }
      return reconciliationResult(await invoke(false, true), jsonRequested(invocation));
    });
  }

  return async (invocation, context) => {
    try {
      context?.throwIfCancelled();
      switch (invocation.command) {
        case 'init':
          return await handleInit(invocation);
        case 'install':
          return await handleInstall(invocation);
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
          return await handleUninstall(invocation);
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
