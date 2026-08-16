import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { ApplicationPaths } from '../infrastructure/config.js';
import {
  acquireAdvisoryLock,
  AdvisoryLockUnavailableError,
  readAdvisoryLock,
  readBackupManifest,
  readOperationJournal,
  transactionRootFingerprint,
  type AdvisoryLock,
  type AdvisoryLockMetadata,
  type BackupManifest,
  type ReadableOperationJournal,
} from '../infrastructure/transactions.js';
import { isPathContained } from '../infrastructure/project-state.js';
import { stableJsonStringify } from '../infrastructure/stable-json.js';
import type { OperationGuard } from '../runtime/operation-guard.js';

export interface RecoveryLockFinding {
  readonly path: string;
  readonly owner?: AdvisoryLockMetadata;
  readonly problem?: string;
}

export interface RecoveryJournalFinding {
  readonly path: string;
  readonly journal: ReadableOperationJournal;
  readonly scopePath: string;
}

export interface RecoveryBackupFinding {
  readonly manifest?: BackupManifest;
  readonly path: string;
  readonly problem?: string;
  readonly scopePath: string;
}

export interface RecoveryProblemFinding {
  readonly blocking: true;
  readonly kind: 'backup' | 'journal' | 'lock' | 'unsafe-entry';
  readonly message: string;
  readonly path: string;
}

export interface RecoveryInspection {
  readonly locks: readonly RecoveryLockFinding[];
  readonly journals: readonly RecoveryJournalFinding[];
  readonly backups: readonly RecoveryBackupFinding[];
  readonly problems: readonly RecoveryProblemFinding[];
  readonly remediation: readonly string[];
}

export type RecoveryRecordKind = 'backup' | 'journal' | 'lock' | 'problem';

export interface RecoveryRecord {
  readonly id: string;
  readonly inspectOnly: boolean;
  readonly kind: RecoveryRecordKind;
  readonly operationId?: string;
  readonly operationKind?: string;
  readonly path: string;
  readonly problem?: string;
  readonly scope: string;
  readonly scopeKind?: string;
  readonly status: string;
}

export interface RecoveryRecordInspection {
  readonly evidence:
    | Omit<AdvisoryLockMetadata, 'ownerToken'>
    | BackupManifest
    | ReadableOperationJournal
    | { readonly message: string };
  readonly record: RecoveryRecord;
}

export interface RecoveryPrunePlanEntry {
  readonly id: string;
  readonly kind: 'backup' | 'journal';
  readonly paths: readonly string[];
}

export interface RecoveryPrunePlan {
  readonly entries: readonly RecoveryPrunePlanEntry[];
  readonly fingerprint: string;
  readonly ids: readonly string[];
  readonly root?: string;
}

export type RecoveryLockProcessState = 'absent' | 'active' | 'unknown';

export interface RecoveryUnlockOptions {
  readonly currentHostname?: string;
  readonly minimumAgeMs?: number;
  readonly now?: Date;
  readonly processState?: (pid: number) => RecoveryLockProcessState;
}

export interface RecoveryUnlockPlan {
  readonly fingerprint: string;
  readonly id: string;
  readonly lastHeartbeatAt: string;
  readonly owner: {
    readonly createdAt: string;
    readonly hostname: string;
    readonly operationId: string;
    readonly pid: number;
    readonly scope: AdvisoryLockMetadata['scope'];
  };
  readonly path: string;
  readonly status: 'abandoned';
}

export class RecoveryPruneValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecoveryPruneValidationError';
  }
}

export class RecoveryUnlockValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RecoveryUnlockValidationError';
  }
}

const RECOVERY_UNLOCK_MINIMUM_AGE_MS = 60_000;

interface DiscoveredRecoveryFile {
  readonly path: string;
  readonly scopePath: string;
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return value === '' ? '.' : value;
}

async function discoverRecoveryFiles(
  root: string,
  ownsFile: (name: string) => boolean,
  kind: RecoveryProblemFinding['kind'],
): Promise<{
  readonly files: readonly DiscoveredRecoveryFile[];
  readonly problems: readonly RecoveryProblemFinding[];
}> {
  const files: DiscoveredRecoveryFile[] = [];
  const problems: RecoveryProblemFinding[] = [];

  async function visit(directory: string): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(directory)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      problems.push({
        blocking: true,
        kind,
        message: error instanceof Error ? error.message : String(error),
        path: directory,
      });
      return;
    }

    for (const name of names) {
      const path = join(directory, name);
      let information;
      try {
        information = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        problems.push({
          blocking: true,
          kind,
          message: error instanceof Error ? error.message : String(error),
          path,
        });
        continue;
      }
      if (information.isSymbolicLink()) {
        problems.push({
          blocking: true,
          kind: 'unsafe-entry',
          message: 'Recovery discovery refuses symbolic links.',
          path,
        });
        continue;
      }
      if (information.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!information.isFile()) {
        problems.push({
          blocking: true,
          kind: 'unsafe-entry',
          message: 'Recovery discovery refuses special filesystem entries.',
          path,
        });
        continue;
      }
      if (ownsFile(name)) {
        files.push({
          path,
          scopePath: portableRelative(root, dirname(path)),
        });
      }
    }
  }

  let rootInformation;
  try {
    rootInformation = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files, problems };
    throw error;
  }
  if (rootInformation.isSymbolicLink() || !rootInformation.isDirectory()) {
    problems.push({
      blocking: true,
      kind: 'unsafe-entry',
      message: 'Recovery root must be a real directory.',
      path: root,
    });
    return { files, problems };
  }
  await visit(root);
  return { files, problems };
}

export async function inspectRecoveryState(
  paths: ApplicationPaths,
  options: { readonly includeTerminalJournals?: boolean } = {},
): Promise<RecoveryInspection> {
  const problems: RecoveryProblemFinding[] = [];
  const locks: RecoveryLockFinding[] = [];
  const lockDiscovery = await discoverRecoveryFiles(
    paths.locksDirectory,
    (name) => name.endsWith('.lock'),
    'lock',
  );
  problems.push(...lockDiscovery.problems);
  for (const { path } of lockDiscovery.files) {
    try {
      const owner = await readAdvisoryLock(path);
      locks.push({ path, ...(owner === undefined ? {} : { owner }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      locks.push({ path, problem: message });
      problems.push({ blocking: true, kind: 'lock', message, path });
    }
  }

  const terminal = new Set<ReadableOperationJournal['status']>(['committed', 'rolled-back']);
  const journals: RecoveryJournalFinding[] = [];
  const journalDiscovery = await discoverRecoveryFiles(
    paths.journalsDirectory,
    (name) => name.endsWith('.json'),
    'journal',
  );
  problems.push(...journalDiscovery.problems);
  for (const file of journalDiscovery.files) {
    try {
      const journal = await readOperationJournal(file.path);
      if (options.includeTerminalJournals === true || !terminal.has(journal.status)) {
        journals.push({
          journal,
          path: file.path,
          scopePath: file.scopePath,
        });
      }
    } catch (error) {
      problems.push({
        blocking: true,
        kind: 'journal',
        message: error instanceof Error ? error.message : String(error),
        path: file.path,
      });
    }
  }
  journals.sort((left, right) => left.path.localeCompare(right.path));

  const backups: RecoveryBackupFinding[] = [];
  const backupDiscovery = await discoverRecoveryFiles(
    paths.backupsDirectory,
    (name) => name === 'backup.json',
    'backup',
  );
  problems.push(...backupDiscovery.problems);
  for (const file of backupDiscovery.files) {
    const path = dirname(file.path);
    try {
      backups.push({
        manifest: await readBackupManifest(file.path),
        path,
        scopePath: portableRelative(paths.backupsDirectory, dirname(path)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backups.push({
        path,
        problem: message,
        scopePath: portableRelative(paths.backupsDirectory, dirname(path)),
      });
      problems.push({ blocking: true, kind: 'backup', message, path: file.path });
    }
  }
  backups.sort((left, right) => left.path.localeCompare(right.path));
  problems.sort((left, right) => left.path.localeCompare(right.path));

  const remediation: string[] = [];
  if (locks.length > 0) {
    remediation.push(
      'Inspect the lock record, then use `skill-sync recovery unlock <id> --dry-run`; never delete a lock by hand.',
    );
  }
  if (journals.length > 0) {
    remediation.push('Inspect incomplete operation journals and restore recorded rollback paths.');
  }
  if (backups.length > 0) {
    remediation.push('Keep recoverable backups until the associated project changes are verified.');
  }
  if (problems.length > 0) {
    remediation.push('Resolve unsafe or malformed recovery evidence before running a mutation.');
  }
  return { locks, journals, backups, problems, remediation };
}

export function recoveryWarningLines(inspection: RecoveryInspection): readonly string[] {
  if (
    inspection.locks.length === 0 &&
    inspection.journals.length === 0 &&
    inspection.backups.length === 0 &&
    inspection.problems.length === 0
  )
    return [];
  return [
    `Recovery state detected: ${String(inspection.locks.length)} lock(s), ${String(inspection.journals.length)} incomplete journal(s), ${String(inspection.backups.length)} backup(s), and ${String(inspection.problems.length)} blocking validation problem(s).`,
    'Next: run `skill-sync recovery list` to get a record ID, then `skill-sync recovery inspect <id>`.',
    ...inspection.remediation,
  ];
}

function recoveryRecordId(kind: RecoveryRecordKind, scope: string, operationId: string): string {
  const fingerprint = createHash('sha256')
    .update('skill-sync-recovery-record-v1\0')
    .update(kind)
    .update('\0')
    .update(scope)
    .update('\0')
    .update(operationId)
    .digest('hex')
    .slice(0, 12);
  const suffix = operationId.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 48) || 'evidence';
  return `${kind}-${fingerprint}-${suffix}`;
}

function recordMatchesScope(record: RecoveryRecord, scope: string | undefined): boolean {
  if (scope === undefined) return true;
  return (
    record.scope === scope ||
    record.scopeKind === scope ||
    record.scope.startsWith(`${scope}:`) ||
    record.scope.includes(scope) ||
    record.path.includes(scope)
  );
}

export async function listRecoveryRecords(
  paths: ApplicationPaths,
  options: { readonly includeTerminalJournals?: boolean; readonly scope?: string } = {},
): Promise<readonly RecoveryRecord[]> {
  const inspection = await inspectRecoveryState(
    paths,
    options.includeTerminalJournals === undefined
      ? {}
      : { includeTerminalJournals: options.includeTerminalJournals },
  );
  const records: RecoveryRecord[] = [];

  for (const finding of inspection.journals) {
    const scope =
      finding.journal.schemaVersion === 2
        ? `${finding.journal.scope.kind}:${finding.journal.scope.id}`
        : finding.scopePath;
    records.push({
      id: recoveryRecordId('journal', scope, finding.journal.operationId),
      inspectOnly:
        finding.journal.schemaVersion === 1 || finding.journal.kind === 'library-initialization',
      kind: 'journal',
      operationId: finding.journal.operationId,
      operationKind: finding.journal.kind,
      path: finding.path,
      scope,
      ...(finding.journal.schemaVersion === 2 ? { scopeKind: finding.journal.scope.kind } : {}),
      status: finding.journal.status,
    });
  }
  for (const finding of inspection.locks) {
    const operationId = finding.owner?.operationId ?? 'unknown-lock';
    const scope =
      finding.owner === undefined
        ? dirname(finding.path)
        : `${finding.owner.scope.kind}:${finding.owner.scope.id}`;
    records.push({
      id: recoveryRecordId('lock', finding.path, operationId),
      inspectOnly: finding.owner === undefined || finding.problem !== undefined,
      kind: 'lock',
      operationId,
      path: finding.path,
      ...(finding.problem === undefined ? {} : { problem: finding.problem }),
      scope,
      ...(finding.owner === undefined ? {} : { scopeKind: finding.owner.scope.kind }),
      status: finding.problem === undefined ? 'locked' : 'invalid',
    });
  }
  for (const finding of inspection.backups) {
    const operationId = finding.manifest?.operationId ?? 'unknown-backup';
    records.push({
      id: recoveryRecordId('backup', finding.scopePath, operationId),
      inspectOnly: true,
      kind: 'backup',
      operationId,
      path: finding.path,
      ...(finding.problem === undefined ? {} : { problem: finding.problem }),
      scope: finding.scopePath,
      status: finding.problem === undefined ? 'available' : 'invalid',
    });
  }
  for (const finding of inspection.problems) {
    if (
      records.some(
        (record) => record.path === dirname(finding.path) || record.path === finding.path,
      )
    )
      continue;
    const scope = dirname(finding.path);
    records.push({
      id: recoveryRecordId('problem', scope, basename(finding.path)),
      inspectOnly: true,
      kind: 'problem',
      path: finding.path,
      problem: finding.message,
      scope,
      status: 'invalid',
    });
  }

  return records
    .filter((record) => recordMatchesScope(record, options.scope))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function inspectRecoveryRecord(
  paths: ApplicationPaths,
  id: string,
): Promise<RecoveryRecordInspection | undefined> {
  const inspection = await inspectRecoveryState(paths, { includeTerminalJournals: true });
  const records = await listRecoveryRecords(paths, { includeTerminalJournals: true });
  const record = records.find((candidate) => candidate.id === id);
  if (record === undefined) return undefined;

  if (record.kind === 'journal') {
    const finding = inspection.journals.find((candidate) => candidate.path === record.path);
    if (finding !== undefined) return { evidence: finding.journal, record };
  }
  if (record.kind === 'lock') {
    const finding = inspection.locks.find((candidate) => candidate.path === record.path);
    if (finding?.owner !== undefined) {
      const evidence = {
        createdAt: finding.owner.createdAt,
        hostname: finding.owner.hostname,
        operationId: finding.owner.operationId,
        pid: finding.owner.pid,
        schemaVersion: finding.owner.schemaVersion,
        scope: finding.owner.scope,
      };
      return { evidence, record };
    }
  }
  if (record.kind === 'backup') {
    const finding = inspection.backups.find((candidate) => candidate.path === record.path);
    if (finding?.manifest !== undefined) return { evidence: finding.manifest, record };
  }
  return { evidence: { message: record.problem ?? 'Recovery evidence is invalid.' }, record };
}

function defaultRecoveryLockProcessState(pid: number): RecoveryLockProcessState {
  try {
    process.kill(pid, 0);
    return 'active';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

function assertRecoveryLockOwnerIsAbsent(
  owner: AdvisoryLockMetadata,
  lastHeartbeatMs: number,
  options: RecoveryUnlockOptions,
): void {
  const localHostname = options.currentHostname ?? hostname();
  if (owner.hostname !== localHostname) {
    throw new RecoveryUnlockValidationError(
      `Lock owner ${owner.operationId} was recorded on host ${owner.hostname}; host ${localHostname} cannot prove that process is gone. The lock was preserved.`,
    );
  }
  const state = (options.processState ?? defaultRecoveryLockProcessState)(owner.pid);
  if (state === 'active') {
    throw new RecoveryUnlockValidationError(
      `Lock owner ${owner.operationId} (PID ${String(owner.pid)}) is still active on this host. Wait for that operation to finish, then inspect the lock again.`,
    );
  }
  if (state !== 'absent') {
    throw new RecoveryUnlockValidationError(
      `The CLI could not prove that lock owner ${owner.operationId} (PID ${String(owner.pid)}) is gone. The lock was preserved.`,
    );
  }
  const minimumAgeMs = options.minimumAgeMs ?? RECOVERY_UNLOCK_MINIMUM_AGE_MS;
  if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) {
    throw new RecoveryUnlockValidationError(
      'Recovery unlock requires a non-negative grace period.',
    );
  }
  const ageMs = (options.now ?? new Date()).getTime() - lastHeartbeatMs;
  if (ageMs < minimumAgeMs) {
    const remainingSeconds = Math.max(1, Math.ceil((minimumAgeMs - ageMs) / 1_000));
    throw new RecoveryUnlockValidationError(
      `Lock owner ${owner.operationId} is gone, but the crash grace period after its last heartbeat has not elapsed. Wait ${String(remainingSeconds)} second(s) so any orphaned child process can exit, then preview unlock again. The lock was preserved.`,
    );
  }
}

async function assertOwnedUnlockPath(locksDirectory: string, path: string): Promise<number> {
  try {
    const lexicalRoot = resolve(locksDirectory);
    const lexicalPath = resolve(path);
    if (lexicalPath === lexicalRoot || !isPathContained(lexicalRoot, lexicalPath)) {
      throw new RecoveryUnlockValidationError(
        `Recovery unlock path is not a bounded child of the lock directory: ${path}`,
      );
    }
    const information = await lstat(lexicalPath);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new RecoveryUnlockValidationError(
        `Recovery unlock requires one regular non-symbolic-link lock file: ${path}`,
      );
    }
    const canonicalRoot = await realpath(lexicalRoot);
    const canonicalPath = await realpath(lexicalPath);
    if (canonicalPath === canonicalRoot || !isPathContained(canonicalRoot, canonicalPath)) {
      throw new RecoveryUnlockValidationError(
        `Recovery unlock path resolves outside the lock directory: ${path}`,
      );
    }
    return information.mtimeMs;
  } catch (error) {
    if (error instanceof RecoveryUnlockValidationError) throw error;
    throw new RecoveryUnlockValidationError(
      `Recovery unlock could not safely revalidate its bounded lock path. The lock was preserved.`,
    );
  }
}

async function readRecoveryUnlockOwner(
  path: string,
  changedMessage: string,
): Promise<AdvisoryLockMetadata | undefined> {
  try {
    return await readAdvisoryLock(path);
  } catch {
    throw new RecoveryUnlockValidationError(`${changedMessage} The lock was preserved.`);
  }
}

export function recoveryUnlockActionLockPath(paths: ApplicationPaths, id: string): string {
  const key = createHash('sha256')
    .update('skill-sync-recovery-unlock-action-v1\0')
    .update(id)
    .digest('hex');
  return join(paths.locksDirectory, 'recovery-actions', `${key}.lock`);
}

async function acquireRecoveryUnlockActionLock(
  paths: ApplicationPaths,
  id: string,
): Promise<AdvisoryLock> {
  try {
    return await acquireAdvisoryLock(recoveryUnlockActionLockPath(paths, id), {
      heartbeatIntervalMs: 0,
      operationId: `recovery-unlock-${String(process.pid)}`,
      scope: { id, kind: 'recovery' },
    });
  } catch (error) {
    if (error instanceof AdvisoryLockUnavailableError) {
      throw new RecoveryUnlockValidationError(
        `Another recovery unlock is already coordinating record "${id}". The selected lock was preserved; run \`skill-sync recovery list\` if that unlock process is no longer active.`,
      );
    }
    throw error;
  }
}

function recoveryLockLastHeartbeatMs(owner: AdvisoryLockMetadata, pathMtimeMs: number): number {
  return Math.max(new Date(owner.createdAt).getTime(), pathMtimeMs);
}

function recoveryUnlockFingerprint(
  id: string,
  path: string,
  owner: AdvisoryLockMetadata,
  lastHeartbeatMs: number,
): string {
  return createHash('sha256')
    .update('skill-sync-recovery-unlock-plan-v1\0')
    .update(stableJsonStringify({ id, lastHeartbeatMs, owner, path }))
    .digest('hex');
}

function recoveryUnlockPlan(
  id: string,
  path: string,
  owner: AdvisoryLockMetadata,
  lastHeartbeatMs: number,
): RecoveryUnlockPlan {
  return {
    fingerprint: recoveryUnlockFingerprint(id, path, owner, lastHeartbeatMs),
    id,
    lastHeartbeatAt: new Date(lastHeartbeatMs).toISOString(),
    owner: {
      createdAt: owner.createdAt,
      hostname: owner.hostname,
      operationId: owner.operationId,
      pid: owner.pid,
      scope: owner.scope,
    },
    path,
    status: 'abandoned',
  };
}

export async function planRecoveryUnlock(
  paths: ApplicationPaths,
  id: string,
  options: RecoveryUnlockOptions = {},
): Promise<RecoveryUnlockPlan> {
  const inspection = await inspectRecoveryRecord(paths, id);
  if (inspection?.record.kind !== 'lock' || inspection.record.problem !== undefined) {
    throw new RecoveryUnlockValidationError(
      `Valid advisory lock record "${id}" was not found. Run \`skill-sync recovery list\` to refresh available IDs.`,
    );
  }
  const pathMtimeMs = await assertOwnedUnlockPath(paths.locksDirectory, inspection.record.path);
  const owner = await readRecoveryUnlockOwner(
    inspection.record.path,
    `Advisory lock record "${id}" became malformed before it could be reviewed.`,
  );
  if (owner === undefined) {
    throw new RecoveryUnlockValidationError(
      `Advisory lock record "${id}" changed or disappeared before it could be reviewed.`,
    );
  }
  const currentId = recoveryRecordId('lock', inspection.record.path, owner.operationId);
  if (currentId !== id) {
    throw new RecoveryUnlockValidationError(
      `Advisory lock record "${id}" changed before it could be reviewed. Run \`skill-sync recovery list\` again.`,
    );
  }
  const lastHeartbeatMs = recoveryLockLastHeartbeatMs(owner, pathMtimeMs);
  assertRecoveryLockOwnerIsAbsent(owner, lastHeartbeatMs, options);
  return recoveryUnlockPlan(id, inspection.record.path, owner, lastHeartbeatMs);
}

export async function applyRecoveryUnlock(
  paths: ApplicationPaths,
  id: string,
  options: RecoveryUnlockOptions & {
    readonly expectedFingerprint: string;
    readonly operationGuard?: OperationGuard;
    readonly syncParent?: (path: string) => Promise<void>;
  },
): Promise<RecoveryUnlockPlan> {
  const actionLock = await acquireRecoveryUnlockActionLock(paths, id);
  let releaseActionLock = async (): Promise<void> => await actionLock.release();
  try {
    const plan = await planRecoveryUnlock(paths, id, options);
    if (plan.fingerprint !== options.expectedFingerprint) {
      throw new RecoveryUnlockValidationError(
        'Recovery lock evidence changed after review; generate and confirm a fresh unlock plan.',
      );
    }
    const pathMtimeMs = await assertOwnedUnlockPath(paths.locksDirectory, plan.path);
    const owner = await readRecoveryUnlockOwner(
      plan.path,
      'Recovery lock evidence became malformed immediately before removal.',
    );
    if (
      owner === undefined ||
      recoveryUnlockFingerprint(
        id,
        plan.path,
        owner,
        recoveryLockLastHeartbeatMs(owner, pathMtimeMs),
      ) !== options.expectedFingerprint
    ) {
      throw new RecoveryUnlockValidationError(
        'Recovery lock evidence changed immediately before removal; the lock was preserved.',
      );
    }
    assertRecoveryLockOwnerIsAbsent(
      owner,
      recoveryLockLastHeartbeatMs(owner, pathMtimeMs),
      options,
    );
    options.operationGuard?.beginCommit();
    try {
      await unlink(plan.path);
    } catch (error) {
      options.operationGuard?.markRolledBack();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RecoveryUnlockValidationError(
          'Recovery lock evidence disappeared immediately before removal; inspect recovery state again.',
        );
      }
      throw error;
    }
    try {
      await (options.syncParent ?? syncPrunedParent)(plan.path);
    } catch (error) {
      releaseActionLock = () => Promise.resolve();
      throw error;
    }
    options.operationGuard?.markCommitted();
    return plan;
  } finally {
    await releaseActionLock();
  }
}

async function assertOwnedPrunePath(ownedRoot: string, path: string): Promise<void> {
  const lexicalRoot = resolve(ownedRoot);
  const lexicalPath = resolve(path);
  if (lexicalPath === lexicalRoot || !isPathContained(lexicalRoot, lexicalPath)) {
    throw new RecoveryPruneValidationError(
      `Recovery prune path is not a bounded child of its owned root: ${path}`,
    );
  }
  const information = await lstat(lexicalPath);
  if (information.isSymbolicLink()) {
    throw new RecoveryPruneValidationError(`Recovery prune refuses symbolic links: ${path}`);
  }
  const canonicalRoot = await realpath(lexicalRoot);
  const canonicalPath = await realpath(lexicalPath);
  if (!isPathContained(canonicalRoot, canonicalPath) || canonicalPath === canonicalRoot) {
    throw new RecoveryPruneValidationError(
      `Recovery prune path resolves outside its owned root: ${path}`,
    );
  }
}

function prunePlanFingerprint(plan: Omit<RecoveryPrunePlan, 'fingerprint'>): string {
  return createHash('sha256')
    .update('skill-sync-recovery-prune-plan-v1\0')
    .update(stableJsonStringify(plan))
    .digest('hex');
}

export async function planRecoveryPrune(
  paths: ApplicationPaths,
  ids: readonly string[],
  options: { readonly root?: string } = {},
): Promise<RecoveryPrunePlan> {
  const selectedIds = [...new Set(ids)].sort();
  if (selectedIds.length === 0 || selectedIds.length !== ids.length) {
    throw new RecoveryPruneValidationError(
      'Recovery prune requires one or more unique record IDs.',
    );
  }
  const inspection = await inspectRecoveryState(paths, { includeTerminalJournals: true });
  const records = await listRecoveryRecords(paths, { includeTerminalJournals: true });
  const entries: RecoveryPrunePlanEntry[] = [];

  for (const id of selectedIds) {
    const record = records.find((candidate) => candidate.id === id);
    if (record === undefined) {
      throw new RecoveryPruneValidationError(`Recovery record "${id}" was not found.`);
    }
    if (record.kind === 'backup') {
      const finding = inspection.backups.find((candidate) => candidate.path === record.path);
      if (
        finding?.manifest === undefined ||
        finding.problem !== undefined ||
        inspection.problems.some((problem) => problem.path.startsWith(`${finding.path}${sep}`))
      ) {
        throw new RecoveryPruneValidationError(
          `Backup recovery record "${id}" is not verified and cannot be pruned.`,
        );
      }
      await assertOwnedPrunePath(paths.backupsDirectory, finding.path);
      entries.push({ id, kind: 'backup', paths: [finding.path] });
      continue;
    }
    if (record.kind !== 'journal') {
      throw new RecoveryPruneValidationError(
        `Recovery record "${id}" is ${record.kind} evidence and cannot be pruned.`,
      );
    }
    const finding = inspection.journals.find((candidate) => candidate.path === record.path);
    if (
      finding?.journal.schemaVersion !== 2 ||
      !['committed', 'rolled-back'].includes(finding.journal.status)
    ) {
      throw new RecoveryPruneValidationError(
        `Journal recovery record "${id}" is unresolved or inspect-only and cannot be pruned.`,
      );
    }
    if (options.root === undefined) {
      throw new RecoveryPruneValidationError(
        `Journal recovery record "${id}" requires its selected managed root.`,
      );
    }
    const selectedRoot = await realpath(options.root);
    if (transactionRootFingerprint(selectedRoot) !== finding.journal.rootFingerprint) {
      throw new RecoveryPruneValidationError(
        `The selected managed root does not match journal "${id}".`,
      );
    }
    const ownedPaths: string[] = [];
    for (const entry of finding.journal.entries) {
      for (const relativePath of [entry.candidate, entry.rollback]) {
        if (relativePath === undefined) continue;
        const artifact = resolve(selectedRoot, ...relativePath.split('/'));
        try {
          await lstat(artifact);
          await assertOwnedPrunePath(selectedRoot, artifact);
          ownedPaths.push(artifact);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
    await assertOwnedPrunePath(paths.journalsDirectory, finding.path);
    entries.push({
      id,
      kind: 'journal',
      paths: [...new Set(ownedPaths)].sort().concat(finding.path),
    });
  }

  const planWithoutFingerprint = {
    entries,
    ids: selectedIds,
    ...(options.root === undefined ? {} : { root: await realpath(options.root) }),
  };
  return { ...planWithoutFingerprint, fingerprint: prunePlanFingerprint(planWithoutFingerprint) };
}

async function syncPrunedParent(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(dirname(path), 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'ENOTSUP' && code !== 'EPERM') {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function applyRecoveryPrune(
  paths: ApplicationPaths,
  ids: readonly string[],
  options: {
    readonly expectedFingerprint: string;
    readonly operationGuard?: OperationGuard;
    readonly root?: string;
  },
): Promise<RecoveryPrunePlan> {
  const plan = await planRecoveryPrune(
    paths,
    ids,
    options.root === undefined ? {} : { root: options.root },
  );
  if (plan.fingerprint !== options.expectedFingerprint) {
    throw new RecoveryPruneValidationError(
      'Recovery prune evidence changed after review; generate and confirm a fresh plan.',
    );
  }
  options.operationGuard?.beginCommit();
  for (const entry of plan.entries) {
    for (const path of entry.paths) {
      await rm(path, { force: true, recursive: true });
      await syncPrunedParent(path);
    }
  }
  options.operationGuard?.markCommitted();
  return plan;
}
