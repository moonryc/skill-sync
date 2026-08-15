import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { ConfigService } from '../application/config-service.js';
import { globalMutationStorage } from '../application/managed-scope.js';
import { projectMutationStorage } from '../application/project-storage.js';
import {
  applyRecoveryUnlock,
  applyRecoveryPrune,
  inspectRecoveryRecord,
  inspectRecoveryState,
  listRecoveryRecords,
  planRecoveryUnlock,
  planRecoveryPrune,
  RecoveryPruneValidationError,
  type RecoveryUnlockOptions,
  RecoveryUnlockValidationError,
} from '../application/recovery.js';
import {
  ReleaseManagementService,
  type CliReleaseManagement,
} from '../application/release-management.js';
import {
  FileLibraryConfigStore,
  LibraryLifecycleService,
} from '../application/library-lifecycle.js';
import { resolveApplicationPaths, type ApplicationPaths } from '../infrastructure/config.js';
import { GitClient } from '../infrastructure/git.js';
import {
  createFilesystemLibraryCacheLock,
  LibraryCache,
  withInProcessLibraryCacheLock,
} from '../infrastructure/library-cache.js';
import { NpmRegistryClient } from '../infrastructure/npm-registry.js';
import { NpmGlobalPackageUpdater } from '../infrastructure/npm-updater.js';
import { readCliPackageMetadata } from '../infrastructure/package-metadata.js';
import { isPathContained, resolveProjectRoot } from '../infrastructure/project-state.js';
import {
  acquireAdvisoryLock,
  type AdvisoryLock,
  AdvisoryLockUnavailableError,
  planOperationJournalRestore,
  planOperationJournalResume,
  restoreOperationJournal,
  resumeOperationJournal,
  TransactionRecoveryValidationError,
} from '../infrastructure/transactions.js';
import { EXIT_CODES, SkillSyncError, success } from '../domain/result.js';
import type { RuntimeIo } from '../ports/index.js';
import { runWithRuntimeBoundary } from '../runtime/boundary.js';
import { PromptAdapter, terminalIsInteractive } from '../ui/prompt.js';
import {
  formatRecoveryPruneHuman,
  formatRecoveryRecordHuman,
  formatRecoveryRecordsHuman,
  formatRecoveryRestoreHuman,
  formatRecoveryResumeHuman,
  formatRecoveryUnlockHuman,
} from '../ui/recovery-output.js';
import { createConfigDoctorCommandHandler } from './config-doctor-handler.js';
import type { CommandExecutor } from './program.js';
import { createWorkflowCommandHandler } from './workflow-handler.js';
import type { CommandInvocation } from './program.js';

export interface DefaultCommandExecutorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly paths?: ApplicationPaths;
  readonly recoveryUnlock?: RecoveryUnlockOptions;
  readonly releaseManagement?: CliReleaseManagement;
}

const ALWAYS_MUTATING_COMMANDS = new Set([
  'adopt',
  'add',
  'config:set',
  'config:unset',
  'group:create',
  'group:rename',
]);

const PREVIEWABLE_MUTATING_COMMANDS = new Set([
  'group:remove',
  'init',
  'install',
  'library:remove',
  'publish',
  'recovery:unlock',
  'uninstall',
  'update',
]);

const MANAGED_SCOPE_MUTATING_COMMANDS = new Set([
  'adopt',
  'install',
  'publish',
  'sync',
  'uninstall',
  'update',
]);

type MutationStorage = ReturnType<typeof projectMutationStorage>;

interface MutationRecoveryScope {
  readonly kind: 'global' | 'project';
  readonly storage: MutationStorage;
}

function recoveryConfirmationRequired(
  invocation: CommandInvocation,
  io: RuntimeIo,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    invocation.options.noInput === true ||
    !terminalIsInteractive(io.stdinIsTty, io.stdoutIsTty, environment)
  );
}

function explicitProjectPath(invocation: CommandInvocation): string | undefined {
  return typeof invocation.options.project === 'string' && invocation.options.project.length > 0
    ? invocation.options.project
    : undefined;
}

async function resolveRecoveryRecordRoot(
  invocation: CommandInvocation,
  scopeKind: string | undefined,
  recordId: string,
): Promise<string> {
  const explicitProject = explicitProjectPath(invocation);
  if (scopeKind === 'global') {
    if (explicitProject !== undefined) {
      throw new SkillSyncError(
        'RECOVERY_SCOPE_MISMATCH',
        `Recovery record "${recordId}" belongs to global scope. Retry without --project.`,
        EXIT_CODES.validation,
        { recordId, scope: 'global' },
      );
    }
    return await realpath(homedir());
  }
  return await resolveProjectRoot(
    explicitProject === undefined ? {} : { explicitPath: explicitProject },
  );
}

async function resolveRecoveryPruneRoot(invocation: CommandInvocation): Promise<string> {
  if (invocation.options.global === true) return await realpath(homedir());
  const explicitProject = explicitProjectPath(invocation);
  return await resolveProjectRoot(
    explicitProject === undefined ? {} : { explicitPath: explicitProject },
  );
}

async function acquireRecoveryLock(path: string, operationId: string) {
  try {
    return await acquireAdvisoryLock(path, { operationId });
  } catch (error) {
    if (error instanceof AdvisoryLockUnavailableError) {
      throw new SkillSyncError(
        'ADVISORY_LOCK_UNAVAILABLE',
        `${error.message} Wait for the active operation to finish, then run recovery inspect again before retrying.`,
        EXIT_CODES.conflict,
        { lockPath: error.lockPath },
      );
    }
    throw error;
  }
}

function invocationMayMutate(
  invocation: CommandInvocation,
  io: RuntimeIo,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (ALWAYS_MUTATING_COMMANDS.has(invocation.command)) {
    return invocation.command === 'adopt' || invocation.command === 'add'
      ? invocation.options.dryRun !== true
      : true;
  }
  if (PREVIEWABLE_MUTATING_COMMANDS.has(invocation.command)) {
    if (
      invocation.command === 'install' &&
      invocation.options.dryRun !== true &&
      typeof invocation.options.expectPlan !== 'string' &&
      invocation.options.yes !== true &&
      (invocation.options.noInput === true ||
        invocation.options.json === true ||
        !terminalIsInteractive(io.stdinIsTty, io.stdoutIsTty, environment))
    ) {
      return false;
    }
    return invocation.options.dryRun !== true;
  }
  if (invocation.command === 'sync') {
    return invocation.options.dryRun !== true && invocation.options.check !== true;
  }
  return false;
}

function invocationMutatesUserConfiguration(
  invocation: CommandInvocation,
  io: RuntimeIo,
  environment: NodeJS.ProcessEnv,
): boolean {
  if (invocation.command === 'config:set' || invocation.command === 'config:unset') return true;
  if (invocation.command !== 'init' || invocation.options.dryRun === true) return false;
  const canPrompt =
    invocation.options.noInput !== true &&
    invocation.options.json !== true &&
    terminalIsInteractive(io.stdinIsTty, io.stdoutIsTty, environment);
  return (
    typeof invocation.options.expectPlan === 'string' ||
    invocation.options.yes === true ||
    canPrompt
  );
}

async function withUserConfigurationLock<T>(
  invocation: CommandInvocation,
  paths: ApplicationPaths,
  io: RuntimeIo,
  environment: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  if (!invocationMutatesUserConfiguration(invocation, io, environment)) return await operation();
  const lockPath = join(paths.locksDirectory, 'user-configuration.lock');
  return await withInProcessLibraryCacheLock(`user-configuration:${paths.configFile}`, async () => {
    let lock: AdvisoryLock;
    try {
      lock = await acquireAdvisoryLock(lockPath, {
        operationId: `user-configuration-${String(process.pid)}`,
        scope: { id: 'user-configuration', kind: 'global' },
      });
    } catch (error) {
      if (error instanceof AdvisoryLockUnavailableError) {
        throw new SkillSyncError(
          'ADVISORY_LOCK_UNAVAILABLE',
          `${error.message} Wait for the active setup or config command to finish. If none is active, run skill-sync recovery list before retrying.`,
          EXIT_CODES.conflict,
          { lockPath: error.lockPath },
        );
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  });
}

async function mutationRecoveryScope(
  invocation: CommandInvocation,
  paths: ApplicationPaths,
  io: RuntimeIo,
  environment: NodeJS.ProcessEnv,
): Promise<MutationRecoveryScope | undefined> {
  if (
    !MANAGED_SCOPE_MUTATING_COMMANDS.has(invocation.command) ||
    !invocationMayMutate(invocation, io, environment)
  ) {
    return undefined;
  }
  const explicitProject = explicitProjectPath(invocation);
  if (invocation.options.global === true) {
    if (invocation.command === 'publish' || explicitProject !== undefined) return undefined;
    return { kind: 'global', storage: globalMutationStorage(paths) };
  }
  const root = await resolveProjectRoot(
    explicitProject === undefined ? {} : { explicitPath: explicitProject },
  );
  return { kind: 'project', storage: projectMutationStorage(paths, root) };
}

function pathsIntersect(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
}

function isKnownManagedScopeComponent(component: string, kind: 'directory' | 'lock'): boolean {
  return kind === 'lock'
    ? /^(?:global|project)-[a-f0-9]{64}\.lock$/u.test(component)
    : component === 'global' || /^[a-f0-9]{64}$/u.test(component);
}

function recoveryPathAffectsScope(options: {
  readonly evidencePath: string;
  readonly recoveryRoot: string;
  readonly selectedPath: string;
  readonly kind: 'directory' | 'lock';
}): boolean {
  if (pathsIntersect(options.selectedPath, options.evidencePath)) return true;
  if (!isPathContained(options.recoveryRoot, options.evidencePath)) return false;
  const component = relative(options.recoveryRoot, options.evidencePath).split(sep)[0];
  return component === undefined || !isKnownManagedScopeComponent(component, options.kind);
}

function recoveryProblemAffectsScope(
  problemPath: string,
  scope: MutationRecoveryScope,
  paths: ApplicationPaths,
): boolean {
  const belongsToKnownRecoveryRoot = [
    paths.journalsDirectory,
    paths.locksDirectory,
    paths.backupsDirectory,
  ].some((root) => isPathContained(root, problemPath));
  return (
    !belongsToKnownRecoveryRoot ||
    recoveryPathAffectsScope({
      evidencePath: problemPath,
      kind: 'directory',
      recoveryRoot: paths.journalsDirectory,
      selectedPath: scope.storage.journalDirectory,
    }) ||
    recoveryPathAffectsScope({
      evidencePath: problemPath,
      kind: 'lock',
      recoveryRoot: paths.locksDirectory,
      selectedPath: scope.storage.lockPath,
    }) ||
    recoveryPathAffectsScope({
      evidencePath: problemPath,
      kind: 'directory',
      recoveryRoot: paths.backupsDirectory,
      selectedPath: scope.storage.backupRoot,
    })
  );
}

async function assertMutationRecoveryIsClean(
  invocation: CommandInvocation,
  paths: ApplicationPaths,
  io: RuntimeIo,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const scope = await mutationRecoveryScope(invocation, paths, io, environment);
  if (scope === undefined) return;
  const inspection = await inspectRecoveryState(paths);
  const journals = inspection.journals.filter((entry) =>
    recoveryPathAffectsScope({
      evidencePath: entry.path,
      kind: 'directory',
      recoveryRoot: paths.journalsDirectory,
      selectedPath: scope.storage.journalDirectory,
    }),
  );
  const locks = inspection.locks.filter((entry) =>
    recoveryPathAffectsScope({
      evidencePath: entry.path,
      kind: 'lock',
      recoveryRoot: paths.locksDirectory,
      selectedPath: scope.storage.lockPath,
    }),
  );
  const problems = inspection.problems.filter((entry) =>
    recoveryProblemAffectsScope(entry.path, scope, paths),
  );
  if (locks.length === 0 && journals.length === 0 && problems.length === 0) return;
  const evidence = [
    ...journals.map((entry) => ({
      kind: 'journal',
      path: entry.path,
      scope: entry.scopePath,
      status: entry.journal.status,
    })),
    ...locks.map((entry) => ({
      kind: 'lock',
      path: entry.path,
      ...(entry.owner === undefined ? {} : { operationId: entry.owner.operationId }),
    })),
    ...problems.map((entry) => ({
      kind: entry.kind,
      path: entry.path,
      problem: entry.message,
    })),
  ].slice(0, 20);
  const firstEvidence = evidence[0];
  const affected = firstEvidence === undefined ? '' : ` Affected evidence: ${firstEvidence.path}.`;
  throw new SkillSyncError(
    'RECOVERY_REQUIRED',
    `This mutation is blocked by unresolved recovery evidence.${affected} Run \`skill-sync recovery list\` to get a record ID, then \`skill-sync recovery inspect <id>\` before retrying.`,
    EXIT_CODES.conflict,
    {
      command: invocation.command,
      evidence,
      inspectCommand: 'skill-sync recovery inspect <id>',
      recoveryCommand: 'skill-sync recovery list',
      truncated: evidence.length < journals.length + locks.length + problems.length,
    },
  );
}

export function createDefaultCommandExecutor(
  io: RuntimeIo,
  options: DefaultCommandExecutorOptions = {},
): CommandExecutor {
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? resolveApplicationPaths({ env: environment });
  const recoveryUnlock = options.recoveryUnlock ?? {};
  const git = new GitClient({
    environment,
    safetyDirectory: join(paths.stateDirectory, 'git-safety'),
  });
  const cache = new LibraryCache({
    rootDirectory: paths.cacheDirectory,
    git,
    withLock: createFilesystemLibraryCacheLock({ locksDirectory: paths.locksDirectory }),
  });
  const config = new ConfigService(environment, paths);
  const lifecycle = new LibraryLifecycleService({
    cache,
    config: new FileLibraryConfigStore(paths.configFile),
    git,
    stagingRoot: join(paths.stateDirectory, 'library-staging'),
  });
  const releaseManagement =
    options.releaseManagement ??
    new ReleaseManagementService(
      readCliPackageMetadata(),
      new NpmRegistryClient(),
      new NpmGlobalPackageUpdater(),
    );
  const system = createConfigDoctorCommandHandler({
    config,
    doctorRequest: (invocation) => ({
      env: environment,
      global: invocation.options.global === true,
      offline: invocation.options.offline === true,
      paths,
      ...(typeof invocation.options.project === 'string'
        ? { project: invocation.options.project }
        : {}),
    }),
  });
  const workflows = createWorkflowCommandHandler({
    cache,
    config,
    environment,
    git,
    io,
    lifecycle,
    paths,
    reconciliationStagingRoot: join(tmpdir(), 'skill-sync-reconciliation'),
  });

  return async (invocation) =>
    await runWithRuntimeBoundary(
      async (context) => {
        context.throwIfCancelled();
        await assertMutationRecoveryIsClean(invocation, paths, io, environment);
        if (invocation.command === 'recovery:list') {
          const scope =
            typeof invocation.options.scope === 'string' ? invocation.options.scope : undefined;
          const records = await listRecoveryRecords(paths, {
            includeTerminalJournals: invocation.options.includeTerminal === true,
            ...(scope === undefined ? {} : { scope }),
          });
          return success(
            invocation.options.json === true
              ? { records }
              : formatRecoveryRecordsHuman(records, scope === undefined ? {} : { scope }),
          );
        }
        if (invocation.command === 'recovery:inspect') {
          const id = invocation.arguments[0];
          if (typeof id !== 'string' || id.length === 0) {
            throw new SkillSyncError(
              'RECOVERY_ID_REQUIRED',
              'Recovery inspection requires a stable record ID from `skill-sync recovery list`.',
              EXIT_CODES.usage,
            );
          }
          const inspection = await inspectRecoveryRecord(paths, id);
          if (inspection === undefined) {
            throw new SkillSyncError(
              'RECOVERY_RECORD_NOT_FOUND',
              `Recovery record "${id}" was not found. Run \`skill-sync recovery list\` to refresh available IDs.`,
              EXIT_CODES.validation,
              { id },
            );
          }
          return success(
            invocation.options.json === true ? inspection : formatRecoveryRecordHuman(inspection),
          );
        }
        if (invocation.command === 'recovery:unlock') {
          const id = invocation.arguments[0];
          if (typeof id !== 'string' || id.length === 0) {
            throw new SkillSyncError(
              'RECOVERY_ID_REQUIRED',
              'Recovery unlock requires a stable lock ID from `skill-sync recovery list`.',
              EXIT_CODES.usage,
            );
          }
          let plan;
          try {
            plan = await planRecoveryUnlock(paths, id, recoveryUnlock);
          } catch (error) {
            if (error instanceof RecoveryUnlockValidationError) {
              throw new SkillSyncError(
                'RECOVERY_UNLOCK_REFUSED',
                error.message,
                EXIT_CODES.conflict,
                { id },
              );
            }
            throw error;
          }
          const result = { ...plan, applied: false };
          const requiresYes = recoveryConfirmationRequired(invocation, io, environment);
          if (
            invocation.options.dryRun === true ||
            (requiresYes && invocation.options.yes !== true)
          ) {
            return success(
              invocation.options.json === true
                ? result
                : formatRecoveryUnlockHuman(result, {
                    dryRun: true,
                    requiresYes,
                  }),
            );
          }
          const prompt = new PromptAdapter({
            interactive: terminalIsInteractive(io.stdinIsTty, io.stdoutIsTty, environment),
            noInput: invocation.options.noInput === true,
            yes: invocation.options.yes === true,
          });
          if (!(await prompt.confirm(`Remove abandoned lock ${plan.path}?`, true))) {
            throw new SkillSyncError(
              'RECOVERY_CONFIRMATION_REQUIRED',
              'Recovery unlock requires explicit confirmation. Review with `--dry-run`, then confirm interactively or pass `--yes`.',
              EXIT_CODES.usage,
              { fingerprint: plan.fingerprint, id },
            );
          }
          try {
            const unlocked = await applyRecoveryUnlock(paths, id, {
              ...recoveryUnlock,
              expectedFingerprint: plan.fingerprint,
              operationGuard: context.operationGuard,
            });
            const applied = { ...unlocked, applied: true };
            return success(
              invocation.options.json === true
                ? applied
                : formatRecoveryUnlockHuman(applied, { dryRun: false }),
            );
          } catch (error) {
            if (error instanceof RecoveryUnlockValidationError) {
              throw new SkillSyncError(
                'RECOVERY_UNLOCK_REFUSED',
                error.message,
                EXIT_CODES.conflict,
                { id },
              );
            }
            throw error;
          }
        }
        if (invocation.command === 'recovery:resume') {
          const id = invocation.arguments[0];
          if (typeof id !== 'string' || id.length === 0) {
            throw new SkillSyncError(
              'RECOVERY_ID_REQUIRED',
              'Recovery resume requires a stable journal ID from `skill-sync recovery list`.',
              EXIT_CODES.usage,
            );
          }
          const inspection = await inspectRecoveryRecord(paths, id);
          if (inspection?.record.kind !== 'journal' || !('schemaVersion' in inspection.evidence)) {
            throw new SkillSyncError(
              'RECOVERY_RECORD_NOT_FOUND',
              `Recoverable journal "${id}" was not found.`,
              EXIT_CODES.validation,
              { id },
            );
          }
          if (inspection.evidence.schemaVersion !== 2) {
            throw new SkillSyncError(
              'RECOVERY_INSPECT_ONLY',
              `Recovery journal "${id}" is legacy inspect-only evidence and cannot be resumed.`,
              EXIT_CODES.conflict,
              { id },
            );
          }
          const root = await resolveRecoveryRecordRoot(invocation, inspection.record.scopeKind, id);
          let plan;
          try {
            plan = await planOperationJournalResume(inspection.record.path, root);
          } catch (error) {
            if (error instanceof TransactionRecoveryValidationError) {
              throw new SkillSyncError(
                'RECOVERY_EVIDENCE_CONFLICT',
                error.message,
                EXIT_CODES.conflict,
                { id, root },
              );
            }
            throw error;
          }
          const result = {
            applied: false,
            entries: plan.entries.map((entry) => ({
              actions: entry.actions,
              destination: entry.destination,
              index: entry.index,
            })),
            fingerprint: plan.fingerprint,
            id,
            operationId: plan.operationId,
            root: plan.root,
            status: plan.status,
          };
          if (invocation.options.dryRun === true || plan.status === 'committed') {
            return success(
              invocation.options.json === true
                ? result
                : plan.status === 'committed'
                  ? formatRecoveryResumeHuman(result, {
                      dryRun: false,
                      scopeKind: inspection.record.scopeKind,
                    })
                  : formatRecoveryResumeHuman(result, {
                      dryRun: true,
                      requiresYes: recoveryConfirmationRequired(invocation, io, environment),
                      scopeKind: inspection.record.scopeKind,
                    }),
            );
          }
          const prompt = new PromptAdapter({
            interactive: terminalIsInteractive(io.stdinIsTty, io.stdoutIsTty, environment),
            noInput: invocation.options.noInput === true,
            yes: invocation.options.yes === true,
          });
          if (!(await prompt.confirm(`Resume recovery operation ${plan.operationId}?`, true))) {
            throw new SkillSyncError(
              'RECOVERY_CONFIRMATION_REQUIRED',
              'Recovery resume requires explicit confirmation. Review with `--dry-run`, then confirm interactively or pass `--yes`.',
              EXIT_CODES.usage,
              { fingerprint: plan.fingerprint, id },
            );
          }
          const storage =
            inspection.record.scopeKind === 'global'
              ? globalMutationStorage(paths)
              : projectMutationStorage(paths, root);
          const lock = await acquireRecoveryLock(
            storage.lockPath,
            `recovery-${inspection.record.id}`.slice(0, 128),
          );
          try {
            const resumed = await resumeOperationJournal({
              expectedFingerprint: plan.fingerprint,
              journalPath: inspection.record.path,
              operationGuard: context.operationGuard,
              root,
            });
            const applied = { ...result, applied: true, status: resumed.value.status };
            return success(
              invocation.options.json === true
                ? applied
                : formatRecoveryResumeHuman(applied, {
                    dryRun: false,
                    scopeKind: inspection.record.scopeKind,
                  }),
            );
          } catch (error) {
            if (error instanceof TransactionRecoveryValidationError) {
              throw new SkillSyncError(
                'RECOVERY_EVIDENCE_CONFLICT',
                error.message,
                EXIT_CODES.conflict,
                { id, root },
              );
            }
            throw error;
          } finally {
            await lock.release();
          }
        }
        if (invocation.command === 'recovery:restore') {
          const id = invocation.arguments[0];
          if (typeof id !== 'string' || id.length === 0) {
            throw new SkillSyncError(
              'RECOVERY_ID_REQUIRED',
              'Recovery restore requires a stable journal ID from `skill-sync recovery list`.',
              EXIT_CODES.usage,
            );
          }
          const inspection = await inspectRecoveryRecord(paths, id);
          if (inspection?.record.kind !== 'journal' || !('schemaVersion' in inspection.evidence)) {
            throw new SkillSyncError(
              'RECOVERY_RECORD_NOT_FOUND',
              `Recoverable journal "${id}" was not found.`,
              EXIT_CODES.validation,
              { id },
            );
          }
          if (inspection.evidence.schemaVersion !== 2) {
            throw new SkillSyncError(
              'RECOVERY_INSPECT_ONLY',
              `Recovery journal "${id}" is legacy inspect-only evidence and cannot be restored.`,
              EXIT_CODES.conflict,
              { id },
            );
          }
          const root = await resolveRecoveryRecordRoot(invocation, inspection.record.scopeKind, id);
          let plan;
          try {
            plan = await planOperationJournalRestore(inspection.record.path, root);
          } catch (error) {
            if (error instanceof TransactionRecoveryValidationError) {
              throw new SkillSyncError(
                'RECOVERY_EVIDENCE_CONFLICT',
                error.message,
                EXIT_CODES.conflict,
                { id, root },
              );
            }
            throw error;
          }
          const result = {
            applied: false,
            entries: plan.entries.map((entry) => ({
              actions: entry.actions,
              destination: entry.destination,
              index: entry.index,
            })),
            fingerprint: plan.fingerprint,
            id,
            operationId: plan.operationId,
            root: plan.root,
            status: plan.status,
          };
          if (invocation.options.dryRun === true || plan.status === 'rolled-back') {
            return success(
              invocation.options.json === true
                ? result
                : plan.status === 'rolled-back'
                  ? formatRecoveryRestoreHuman(result, {
                      dryRun: false,
                      scopeKind: inspection.record.scopeKind,
                    })
                  : formatRecoveryRestoreHuman(result, {
                      dryRun: true,
                      requiresYes: recoveryConfirmationRequired(invocation, io, environment),
                      scopeKind: inspection.record.scopeKind,
                    }),
            );
          }
          const prompt = new PromptAdapter({
            interactive: terminalIsInteractive(io.stdinIsTty, io.stdoutIsTty, environment),
            noInput: invocation.options.noInput === true,
            yes: invocation.options.yes === true,
          });
          if (!(await prompt.confirm(`Restore recovery operation ${plan.operationId}?`, true))) {
            throw new SkillSyncError(
              'RECOVERY_CONFIRMATION_REQUIRED',
              'Recovery restore requires explicit confirmation. Review with `--dry-run`, then confirm interactively or pass `--yes`.',
              EXIT_CODES.usage,
              { fingerprint: plan.fingerprint, id },
            );
          }
          const storage =
            inspection.record.scopeKind === 'global'
              ? globalMutationStorage(paths)
              : projectMutationStorage(paths, root);
          const lock = await acquireRecoveryLock(
            storage.lockPath,
            `recovery-${inspection.record.id}`.slice(0, 128),
          );
          try {
            const restored = await restoreOperationJournal({
              expectedFingerprint: plan.fingerprint,
              journalPath: inspection.record.path,
              operationGuard: context.operationGuard,
              root,
            });
            const applied = { ...result, applied: true, status: restored.value.status };
            return success(
              invocation.options.json === true
                ? applied
                : formatRecoveryRestoreHuman(applied, {
                    dryRun: false,
                    scopeKind: inspection.record.scopeKind,
                  }),
            );
          } catch (error) {
            if (error instanceof TransactionRecoveryValidationError) {
              throw new SkillSyncError(
                'RECOVERY_EVIDENCE_CONFLICT',
                error.message,
                EXIT_CODES.conflict,
                { id, root },
              );
            }
            throw error;
          } finally {
            await lock.release();
          }
        }
        if (invocation.command === 'recovery:prune') {
          const rawIds = invocation.arguments[0];
          const ids = Array.isArray(rawIds)
            ? rawIds.filter((entry): entry is string => typeof entry === 'string')
            : invocation.arguments.filter((entry): entry is string => typeof entry === 'string');
          const root = await resolveRecoveryPruneRoot(invocation);
          let plan;
          try {
            plan = await planRecoveryPrune(paths, ids, { root });
          } catch (error) {
            if (error instanceof RecoveryPruneValidationError) {
              throw new SkillSyncError(
                'RECOVERY_PRUNE_REFUSED',
                error.message,
                EXIT_CODES.conflict,
                { ids },
              );
            }
            throw error;
          }
          const result = {
            applied: false,
            entries: plan.entries,
            fingerprint: plan.fingerprint,
            ids: plan.ids,
          };
          if (invocation.options.dryRun === true) {
            return success(
              invocation.options.json === true
                ? result
                : formatRecoveryPruneHuman(result, {
                    dryRun: true,
                    requiresYes: recoveryConfirmationRequired(invocation, io, environment),
                    root,
                    scopeKind: invocation.options.global === true ? 'global' : 'project',
                  }),
            );
          }
          const prompt = new PromptAdapter({
            interactive: terminalIsInteractive(io.stdinIsTty, io.stdoutIsTty, environment),
            noInput: invocation.options.noInput === true,
            yes: invocation.options.yes === true,
          });
          if (
            !(await prompt.confirm(
              `Prune ${String(plan.entries.length)} recovery record(s)?`,
              true,
            ))
          ) {
            throw new SkillSyncError(
              'RECOVERY_CONFIRMATION_REQUIRED',
              'Recovery prune requires explicit confirmation. Review with `--dry-run`, then confirm interactively or pass `--yes`.',
              EXIT_CODES.usage,
              { fingerprint: plan.fingerprint, ids },
            );
          }
          const lock = await acquireRecoveryLock(
            join(paths.locksDirectory, 'recovery-prune.lock'),
            'recovery-prune',
          );
          try {
            const pruned = await applyRecoveryPrune(paths, ids, {
              expectedFingerprint: plan.fingerprint,
              operationGuard: context.operationGuard,
              root,
            });
            const applied = { ...result, applied: true, entries: pruned.entries };
            return success(
              invocation.options.json === true
                ? applied
                : formatRecoveryPruneHuman(applied, {
                    dryRun: false,
                    root,
                    scopeKind: invocation.options.global === true ? 'global' : 'project',
                  }),
            );
          } catch (error) {
            if (error instanceof RecoveryPruneValidationError) {
              throw new SkillSyncError(
                'RECOVERY_PRUNE_REFUSED',
                error.message,
                EXIT_CODES.conflict,
                { ids },
              );
            }
            throw error;
          } finally {
            await lock.release();
          }
        }
        if (invocation.command === 'release:check') {
          return success(await releaseManagement.availableUpdate());
        }
        if (invocation.command === 'self-update') {
          const result = await releaseManagement.selfUpdate();
          return success(
            invocation.options.json === true
              ? result
              : `CLI update completed for ${result.packageName}@${result.requestedVersion}.`,
          );
        }
        return await withUserConfigurationLock(invocation, paths, io, environment, async () => {
          const systemResult = await system(invocation);
          if (systemResult !== undefined) return systemResult;
          return await workflows(invocation, context);
        });
      },
      {
        diagnostics: (diagnostic) => {
          io.writeStderr(`${diagnostic.code}: ${diagnostic.message}\n`);
        },
      },
    );
}
