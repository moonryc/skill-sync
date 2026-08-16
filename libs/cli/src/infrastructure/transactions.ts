import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  utimes,
  chmod,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { sha256TreeDigest } from '../domain/digest.js';
import { portableRelativePathSchema } from '../domain/project-state.js';
import {
  JournalTransitionError,
  RecoveryIntegrityError,
  TransactionRolledBackError,
} from '../domain/recovery-integrity.js';
import { EXIT_CODES, SkillSyncError } from '../domain/result.js';
import type { OperationGuard } from '../runtime/operation-guard.js';
import { redactCredentials } from './config.js';
import { isPathContained, resolveContainedProjectPath } from './project-state.js';
import { stableJsonStringify, writeJsonAtomic } from './stable-json.js';

const TRANSACTION_SCHEMA_VERSION = 1 as const;
const DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS = 15_000;
export const OPERATION_JOURNAL_SCHEMA_VERSION = 2 as const;
const operationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'Invalid operation ID.');

const lockScopeSchema = z.strictObject({
  id: z.string().min(1).max(512),
  kind: z.enum(['custom', 'global', 'library', 'project', 'recovery']),
});

const lockMetadataSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  hostname: z.string().min(1),
  operationId: operationIdSchema,
  ownerToken: z.uuid(),
  pid: z.number().int().positive(),
  schemaVersion: z.literal(TRANSACTION_SCHEMA_VERSION),
  scope: lockScopeSchema.default({ id: 'legacy-unscoped', kind: 'custom' }),
});

export type AdvisoryLockMetadata = z.infer<typeof lockMetadataSchema>;

export class AdvisoryLockUnavailableError extends Error {
  public readonly lockPath: string;
  public readonly owner: AdvisoryLockMetadata | undefined;
  public readonly stale: boolean;

  public constructor(
    lockPath: string,
    owner?: AdvisoryLockMetadata,
    options?: { readonly stale: boolean },
  ) {
    const stale = options?.stale ?? false;
    super(
      owner === undefined
        ? `Another operation holds advisory lock ${lockPath}.`
        : `${stale ? 'A stale lock from' : 'Operation'} ${owner.operationId} (PID ${String(owner.pid)} on ${owner.hostname}, scope ${owner.scope.kind}:${owner.scope.id}) holds advisory lock ${lockPath}.`,
    );
    this.name = 'AdvisoryLockUnavailableError';
    this.lockPath = lockPath;
    this.owner = owner;
    this.stale = stale;
  }
}

export class AdvisoryLockOwnershipError extends RecoveryIntegrityError {
  public constructor(lockPath: string) {
    super('lock-ownership', `Advisory lock ownership changed before release: ${lockPath}.`);
    this.name = 'AdvisoryLockOwnershipError';
  }
}

export interface AdvisoryLock {
  readonly metadata: AdvisoryLockMetadata;
  readonly path: string;
  release(): Promise<void>;
}

export async function readAdvisoryLock(path: string): Promise<AdvisoryLockMetadata | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return lockMetadataSchema.parse(JSON.parse(contents) as unknown);
}

/** Acquire a crash-visible lock with O_EXCL. Stale locks are never removed implicitly. */
export async function acquireAdvisoryLock(
  path: string,
  options: {
    readonly now?: Date;
    readonly operationId: string;
    readonly pid?: number;
    readonly hostname?: string;
    readonly heartbeatIntervalMs?: number;
    readonly scope?: z.input<typeof lockScopeSchema>;
    readonly staleAfterMs?: number;
  },
): Promise<AdvisoryLock> {
  const now = options.now ?? new Date();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_LOCK_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 0) {
    throw new Error('Advisory lock heartbeat interval must be a non-negative finite number.');
  }
  const defaultScopeId = createHash('sha256')
    .update(`skill-sync-lock-scope-v1\0${resolve(path)}`)
    .digest('hex');
  const metadata = lockMetadataSchema.parse({
    createdAt: now.toISOString(),
    hostname: options.hostname ?? hostname(),
    operationId: options.operationId,
    ownerToken: randomUUID(),
    pid: options.pid ?? process.pid,
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    scope: options.scope ?? { id: defaultScopeId, kind: 'custom' },
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(stableJsonStringify(metadata), { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const owner = await readAdvisoryLock(path).catch(() => undefined);
      const modifiedAt = await lstat(path)
        .then((information) => information.mtimeMs)
        .catch(() => Number.NaN);
      const lastHeartbeat =
        owner === undefined
          ? Number.NaN
          : Math.max(new Date(owner.createdAt).getTime(), modifiedAt);
      const stale =
        owner !== undefined &&
        Number.isFinite(lastHeartbeat) &&
        now.getTime() - lastHeartbeat > (options.staleAfterMs ?? 24 * 60 * 60 * 1_000);
      throw new AdvisoryLockUnavailableError(path, owner, { stale });
    }
    await unlink(path).catch(() => undefined);
    throw error;
  }

  let released = false;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatInFlight = Promise.resolve();
  const stopHeartbeat = async (): Promise<void> => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    await heartbeatInFlight;
  };
  if (heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      heartbeatInFlight = heartbeatInFlight.then(async () => {
        try {
          const current = await readAdvisoryLock(path);
          if (current?.ownerToken !== metadata.ownerToken) {
            if (heartbeatTimer !== undefined) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = undefined;
            }
            return;
          }
          const heartbeatAt = new Date();
          await utimes(path, heartbeatAt, heartbeatAt);
        } catch {
          // Liveness checks still refuse an active PID; recovery requires a full grace after
          // the last heartbeat that the filesystem could persist.
        }
      });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();
  }
  return {
    metadata,
    path,
    release: async () => {
      if (released) return;
      await stopHeartbeat();
      const current = await readAdvisoryLock(path);
      if (current?.ownerToken !== metadata.ownerToken) {
        throw new AdvisoryLockOwnershipError(path);
      }
      await unlink(path);
      released = true;
    },
  };
}

export const operationJournalStatusSchema = z.enum([
  'preparing',
  'prepared',
  'committing',
  'rolling-back',
  'committed',
  'rolled-back',
  'failed',
]);

export const operationJournalEntrySchema = z.strictObject({
  action: z.enum(['replace', 'remove']),
  destination: portableRelativePathSchema,
  state: z.enum(['pending', 'prepared', 'original-moved', 'committed', 'restored']),
});

export const operationJournalSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  entries: z.array(operationJournalEntrySchema),
  kind: z.string().min(1).max(128),
  note: z.string().max(4_096).optional(),
  operationId: operationIdSchema,
  schemaVersion: z.literal(TRANSACTION_SCHEMA_VERSION),
  status: operationJournalStatusSchema,
  updatedAt: z.iso.datetime(),
});

export type OperationJournal = z.infer<typeof operationJournalSchema>;
export type OperationJournalEntry = z.infer<typeof operationJournalEntrySchema>;
export type OperationJournalStatus = z.infer<typeof operationJournalStatusSchema>;

const contentDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, 'Expected a lowercase SHA-256 digest.');
const operationScopeSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Invalid operation scope ID.'),
  kind: z.enum(['project', 'global', 'library', 'cache', 'config', 'recovery']),
});
const operationJournalTerminalSchema = z.strictObject({
  completedAt: z.iso.datetime(),
  outcome: z.enum(['committed', 'rolled-back']),
});

export interface DeterministicOperationPaths {
  readonly candidate: string;
  readonly rollback: string;
}

function portableDirectory(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

/** Derive same-directory hidden paths without random or process-local input. */
export function deterministicOperationPaths(
  destination: string,
  operationId: string,
  entryIndex: number,
): DeterministicOperationPaths {
  const portableDestination = portableRelativePathSchema.parse(destination);
  const safeOperationId = operationIdSchema.parse(operationId);
  if (!Number.isSafeInteger(entryIndex) || entryIndex < 0) {
    throw new Error('Operation journal entry index must be a non-negative safe integer.');
  }
  const directory = portableDirectory(portableDestination);
  const prefix = `.skill-sync-${safeOperationId}-${String(entryIndex)}`;
  const relativeToDirectory = (name: string): string =>
    portableRelativePathSchema.parse(directory === '' ? name : `${directory}/${name}`);
  return {
    candidate: relativeToDirectory(`${prefix}-candidate`),
    rollback: relativeToDirectory(`${prefix}-rollback`),
  };
}

/** Hash the normalized root without persisting the machine-specific absolute path. */
export function transactionRootFingerprint(root: string): string {
  return createHash('sha256')
    .update('skill-sync-transaction-root-v1\0')
    .update(resolve(root))
    .digest('hex');
}

export const operationJournalV2EntrySchema = z
  .strictObject({
    action: z.enum(['replace', 'remove']),
    candidate: portableRelativePathSchema.optional(),
    destination: portableRelativePathSchema,
    finalDigest: contentDigestSchema.nullable(),
    originalDigest: contentDigestSchema.nullable(),
    rollback: portableRelativePathSchema,
    sourceDigest: contentDigestSchema.nullable(),
    state: z.enum(['pending', 'prepared', 'original-moved', 'committed', 'restored']),
  })
  .superRefine((entry, context) => {
    if (entry.action === 'replace') {
      if (entry.candidate === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A replacement journal entry requires a candidate path.',
          path: ['candidate'],
        });
      }
      if (entry.sourceDigest === null || entry.finalDigest === null) {
        context.addIssue({
          code: 'custom',
          message: 'A replacement journal entry requires source and final digests.',
          path: ['sourceDigest'],
        });
      } else if (entry.sourceDigest !== entry.finalDigest) {
        context.addIssue({
          code: 'custom',
          message: 'Replacement source and final digests must match.',
          path: ['finalDigest'],
        });
      }
    } else {
      if (entry.candidate !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'A removal journal entry must not include a candidate path.',
          path: ['candidate'],
        });
      }
      if (entry.sourceDigest !== null || entry.finalDigest !== null) {
        context.addIssue({
          code: 'custom',
          message: 'A removal journal entry must use null source and final digests.',
          path: ['finalDigest'],
        });
      }
    }
    if (
      entry.destination === entry.rollback ||
      entry.destination === entry.candidate ||
      entry.rollback === entry.candidate
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Journal destination, candidate, and rollback paths must be distinct.',
        path: ['rollback'],
      });
    }
  });

export const operationJournalV2Schema = z
  .strictObject({
    createdAt: z.iso.datetime(),
    entries: z.array(operationJournalV2EntrySchema),
    kind: z.string().min(1).max(128),
    note: z.string().max(4_096).optional(),
    operationId: operationIdSchema,
    rootFingerprint: contentDigestSchema,
    schemaVersion: z.literal(OPERATION_JOURNAL_SCHEMA_VERSION),
    scope: operationScopeSchema,
    status: operationJournalStatusSchema,
    terminal: operationJournalTerminalSchema.optional(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((journal, context) => {
    const terminalStatus = journal.status === 'committed' || journal.status === 'rolled-back';
    if (terminalStatus && journal.terminal?.outcome !== journal.status) {
      context.addIssue({
        code: 'custom',
        message: 'A terminal journal requires matching terminal metadata.',
        path: ['terminal'],
      });
    }
    if (!terminalStatus && journal.terminal !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A nonterminal journal must not include terminal metadata.',
        path: ['terminal'],
      });
    }

    const destinations = new Set<string>();
    for (const [index, entry] of journal.entries.entries()) {
      if (destinations.has(entry.destination)) {
        context.addIssue({
          code: 'custom',
          message: 'Journal destinations must be unique.',
          path: ['entries', index, 'destination'],
        });
      }
      destinations.add(entry.destination);
      const expected = deterministicOperationPaths(entry.destination, journal.operationId, index);
      if (entry.rollback !== expected.rollback) {
        context.addIssue({
          code: 'custom',
          message: 'Journal rollback path is not deterministic for this entry.',
          path: ['entries', index, 'rollback'],
        });
      }
      if (entry.action === 'replace' && entry.candidate !== expected.candidate) {
        context.addIssue({
          code: 'custom',
          message: 'Journal candidate path is not deterministic for this entry.',
          path: ['entries', index, 'candidate'],
        });
      }
    }
  });

export type OperationJournalV2 = z.infer<typeof operationJournalV2Schema>;
export type OperationJournalV2Entry = z.infer<typeof operationJournalV2EntrySchema>;
export type ReadableOperationJournal = OperationJournal | OperationJournalV2;

export interface OperationJournalHandle {
  readonly path: string;
  readonly value: ReadableOperationJournal;
}

export interface OperationJournalV2Handle {
  readonly path: string;
  readonly value: OperationJournalV2;
}

export async function createOperationJournal(
  directory: string,
  options: {
    readonly entries?: readonly OperationJournalEntry[];
    readonly kind: string;
    readonly now?: Date;
    readonly operationId: string;
  },
): Promise<OperationJournalHandle> {
  const timestamp = (options.now ?? new Date()).toISOString();
  const operationId = operationIdSchema.parse(options.operationId);
  const journal = operationJournalSchema.parse({
    createdAt: timestamp,
    entries: options.entries ?? [],
    kind: options.kind,
    operationId,
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    status: 'preparing',
    updatedAt: timestamp,
  });
  const path = join(directory, `${operationId}.json`);
  await writeJsonAtomic(path, journal, { mode: 0o600 });
  return { path, value: journal };
}

export async function readOperationJournal(path: string): Promise<ReadableOperationJournal> {
  const contents = await readFile(path, 'utf8');
  const value = JSON.parse(contents) as unknown;
  if (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'schemaVersion') === OPERATION_JOURNAL_SCHEMA_VERSION
  ) {
    return operationJournalV2Schema.parse(value);
  }
  return operationJournalSchema.parse(value);
}

const validJournalTransitions: Readonly<
  Record<OperationJournalStatus, readonly OperationJournalStatus[]>
> = {
  committed: ['rolling-back'],
  committing: ['committing', 'committed', 'rolling-back', 'failed'],
  failed: ['committing', 'rolling-back'],
  prepared: ['committing', 'rolling-back', 'failed'],
  preparing: ['prepared', 'committing', 'rolling-back', 'failed'],
  'rolled-back': [],
  'rolling-back': ['rolling-back', 'rolled-back', 'failed'],
};

export async function updateOperationJournal(
  path: string,
  update: {
    readonly entries?: readonly OperationJournalEntry[];
    readonly note?: string;
    readonly now?: Date;
    readonly status: OperationJournalStatus;
  },
): Promise<OperationJournal> {
  const current = await readOperationJournal(path);
  if (current.schemaVersion !== TRANSACTION_SCHEMA_VERSION) {
    throw new Error('Operation journal schema v2 requires the v2 transition writer.');
  }
  if (!validJournalTransitions[current.status].includes(update.status)) {
    throw new Error(`Invalid journal transition from ${current.status} to ${update.status}.`);
  }
  const next = operationJournalSchema.parse({
    ...current,
    ...(update.entries === undefined ? {} : { entries: update.entries }),
    ...(update.note === undefined ? {} : { note: redactCredentials(update.note) }),
    status: update.status,
    updatedAt: (update.now ?? new Date()).toISOString(),
  });
  await writeJsonAtomic(path, next, { mode: 0o600 });
  return next;
}

export async function createOperationJournalV2(
  directory: string,
  options: {
    readonly entries: readonly OperationJournalV2Entry[];
    readonly kind: string;
    readonly note?: string;
    readonly now?: Date;
    readonly operationId: string;
    readonly rootFingerprint: string;
    readonly scope: OperationJournalV2['scope'];
  },
): Promise<OperationJournalV2Handle> {
  const timestamp = (options.now ?? new Date()).toISOString();
  const operationId = operationIdSchema.parse(options.operationId);
  const journal = operationJournalV2Schema.parse({
    createdAt: timestamp,
    entries: options.entries,
    kind: options.kind,
    ...(options.note === undefined ? {} : { note: redactCredentials(options.note) }),
    operationId,
    rootFingerprint: options.rootFingerprint,
    schemaVersion: OPERATION_JOURNAL_SCHEMA_VERSION,
    scope: options.scope,
    status: 'preparing',
    updatedAt: timestamp,
  });
  const path = join(directory, `${operationId}.json`);
  try {
    await writeJsonAtomic(path, journal, { mode: 0o600 });
  } catch (error) {
    throw new JournalTransitionError(path, { cause: error });
  }
  return { path, value: journal };
}

export async function updateOperationJournalV2(
  path: string,
  update: {
    readonly entries?: readonly OperationJournalV2Entry[];
    readonly note?: string;
    readonly now?: Date;
    readonly status: OperationJournalStatus;
  },
): Promise<OperationJournalV2> {
  try {
    const current = await readOperationJournal(path);
    if (current.schemaVersion !== OPERATION_JOURNAL_SCHEMA_VERSION) {
      throw new Error('Legacy operation journals are inspect-only.');
    }
    if (!validJournalTransitions[current.status].includes(update.status)) {
      throw new Error(`Invalid journal transition from ${current.status} to ${update.status}.`);
    }
    const timestamp = (update.now ?? new Date()).toISOString();
    const terminal =
      update.status === 'committed' || update.status === 'rolled-back'
        ? { completedAt: timestamp, outcome: update.status }
        : undefined;
    const next = operationJournalV2Schema.parse({
      ...current,
      ...(update.entries === undefined ? {} : { entries: update.entries }),
      ...(update.note === undefined ? {} : { note: redactCredentials(update.note) }),
      ...(terminal === undefined ? {} : { terminal }),
      status: update.status,
      updatedAt: timestamp,
    });
    await writeJsonAtomic(path, next, { mode: 0o600 });
    return next;
  } catch (error) {
    if (error instanceof JournalTransitionError) throw error;
    throw new JournalTransitionError(path, { cause: error });
  }
}

export async function listOperationJournals(directory: string): Promise<OperationJournalHandle[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const handles: OperationJournalHandle[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const path = join(directory, name);
    handles.push({ path, value: await readOperationJournal(path) });
  }
  return handles;
}

export async function createStagingDirectory(
  stagingRoot: string,
  operationId: string,
): Promise<string> {
  const safeOperationId = operationIdSchema.parse(operationId);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(stagingRoot, `${safeOperationId}-`));
  await chmod(path, 0o700);
  return path;
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

async function copyRegularPath(source: string, destination: string): Promise<void> {
  const information = await lstat(source);
  if (information.isSymbolicLink()) {
    throw new Error(`Refusing to stage symbolic link: ${source}`);
  }
  if (information.isFile()) {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    // Copied content is inert: regular files do not gain executable bits.
    await chmod(destination, information.mode & 0o666);
    return;
  }
  if (!information.isDirectory()) {
    throw new Error(`Refusing to stage special filesystem entry: ${source}`);
  }

  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.git') {
      throw new Error(`Refusing to stage nested Git repository: ${join(source, entry.name)}`);
    }
    await copyRegularPath(join(source, entry.name), join(destination, entry.name));
  }
  await chmod(destination, information.mode & 0o777);
}

export async function stageRegularPath(
  source: string,
  stagingDirectory: string,
  relativePath: string,
): Promise<string> {
  const portablePath = portableRelativePathSchema.parse(relativePath);
  const realStagingDirectory = await realpath(stagingDirectory);
  const destination = resolve(realStagingDirectory, ...portablePath.split('/'));
  if (!isPathContained(realStagingDirectory, destination)) {
    throw new Error(`Staging path escapes its root: ${relativePath}`);
  }
  if (await pathExists(destination)) {
    throw new Error(`Staging destination already exists: ${relativePath}`);
  }
  await copyRegularPath(source, destination);
  return destination;
}

const backupManifestSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  entries: z.array(
    z.strictObject({
      originalPath: portableRelativePathSchema,
      storedPath: portableRelativePathSchema,
    }),
  ),
  operationId: operationIdSchema,
  schemaVersion: z.literal(TRANSACTION_SCHEMA_VERSION),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

export async function readBackupManifest(path: string): Promise<BackupManifest> {
  const contents = await readFile(path, 'utf8');
  return backupManifestSchema.parse(JSON.parse(contents) as unknown);
}

export async function createRecoverableBackup(options: {
  readonly backupRoot: string;
  readonly entries: readonly { readonly path: string; readonly relativePath: string }[];
  readonly now?: Date;
  readonly operationId: string;
  readonly projectRoot: string;
}): Promise<{ readonly manifest: BackupManifest; readonly path: string }> {
  const operationId = operationIdSchema.parse(options.operationId);
  const realProjectRoot = await realpath(options.projectRoot);
  const normalizedEntries = options.entries
    .map((entry) => ({
      path: entry.path,
      relativePath: portableRelativePathSchema.parse(entry.relativePath),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (
    new Set(normalizedEntries.map((entry) => entry.relativePath)).size !== normalizedEntries.length
  ) {
    throw new Error('Backup entries must have unique relative paths.');
  }

  for (const entry of normalizedEntries) {
    const actualSource = await realpath(entry.path);
    if (!isPathContained(realProjectRoot, actualSource)) {
      throw new Error(`Backup source escapes the selected project root: ${entry.relativePath}`);
    }
  }

  await mkdir(options.backupRoot, { recursive: true, mode: 0o700 });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/gu, '-');
  const backupPath = join(
    options.backupRoot,
    `${stamp}-${operationId}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(backupPath, { mode: 0o700 });
  const storedEntries: BackupManifest['entries'] = [];

  try {
    for (const entry of normalizedEntries) {
      const storedPath = join('files', entry.relativePath).split(sep).join('/');
      await copyRegularPath(entry.path, join(backupPath, ...storedPath.split('/')));
      storedEntries.push({ originalPath: entry.relativePath, storedPath });
    }
    const manifest = backupManifestSchema.parse({
      createdAt: (options.now ?? new Date()).toISOString(),
      entries: storedEntries,
      operationId,
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
    });
    await writeJsonAtomic(join(backupPath, 'backup.json'), manifest, { mode: 0o600 });
    return { manifest, path: backupPath };
  } catch (error) {
    await rm(backupPath, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

export interface AtomicReplacement {
  readonly action: 'replace' | 'remove';
  readonly destinationPath: string;
  readonly expectedOriginalDigest?: string | null;
  readonly stagedPath?: string;
}

interface PreparedReplacement extends AtomicReplacement {
  readonly candidatePath?: string;
  readonly candidateRelativePath?: string;
  readonly destinationRelativePath: string;
  readonly finalDigest: string | null;
  readonly originalDigest: string | null;
  readonly rollbackRelativePath: string;
  readonly rollbackPath: string;
  readonly sourceDigest: string | null;
  newCommitted: boolean;
  originalMoved: boolean;
}

export type TransactionDurableStep =
  | 'journal-created'
  | 'candidate-prepared'
  | 'journal-prepared'
  | 'journal-committing'
  | 'original-moved'
  | 'journal-original-moved'
  | 'candidate-committed'
  | 'journal-entry-committed'
  | 'journal-committed'
  | 'journal-rolling-back'
  | 'committed-destination-removed'
  | 'original-restored'
  | 'candidate-removed'
  | 'journal-rolled-back'
  | 'journal-failed';

export interface TransactionHooks {
  readonly afterDurableStep?: (
    step: TransactionDurableStep,
    entryIndex?: number,
  ) => Promise<void> | void;
  readonly beforeCommit?: (index: number) => Promise<void> | void;
}

export class TransactionRollbackError extends RecoveryIntegrityError {
  public readonly failures: readonly unknown[];

  public constructor(failures: readonly unknown[], options: { readonly cause: unknown }) {
    super(
      'failed-rollback',
      'The operation failed and one or more paths could not be rolled back.',
      options,
    );
    this.name = 'TransactionRollbackError';
    this.failures = failures;
  }
}

export class MutationPlanChangedError extends SkillSyncError {
  public constructor(
    destination: string,
    reason: 'candidate-digest' | 'destination-digest',
    planFingerprint: string,
  ) {
    super(
      'STALE_MUTATION_PLAN',
      `Mutation input changed after planning for ${destination}; no commit was started.`,
      EXIT_CODES.conflict,
      { destination, planFingerprint, reason },
    );
    this.name = 'MutationPlanChangedError';
  }
}

function preparedPlanFingerprint(
  kind: string,
  rootFingerprint: string,
  replacements: readonly PreparedReplacement[],
): string {
  return createHash('sha256')
    .update(
      stableJsonStringify({
        kind,
        replacements: replacements.map((replacement) => ({
          action: replacement.action,
          destination: replacement.destinationRelativePath,
          finalDigest: replacement.finalDigest,
          originalDigest: replacement.originalDigest,
          sourceDigest: replacement.sourceDigest,
        })),
        rootFingerprint,
      }),
    )
    .digest('hex');
}

function portablePathFromRoot(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return portableRelativePathSchema.parse(value);
}

async function syncDirectoryDurably(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
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

async function syncRegularPath(path: string): Promise<void> {
  const information = await lstat(path);
  if (information.isFile()) {
    // Windows requires a writable handle for fsync even when only flushing copied data.
    const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`Refusing to sync non-regular transaction content: ${path}`);
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await syncRegularPath(join(path, entry.name));
  }
  await syncDirectoryDurably(path);
}

async function renameDurably(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  const sourceParent = dirname(source);
  const destinationParent = dirname(destination);
  await syncDirectoryDurably(sourceParent);
  if (destinationParent !== sourceParent) {
    await syncDirectoryDurably(destinationParent);
  }
}

async function removeDurably(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
  await syncDirectoryDurably(dirname(path));
}

export async function transactionContentDigest(path: string): Promise<string> {
  const information = await lstat(path);
  const hash = createHash('sha256');
  if (information.isFile()) {
    hash.update('skill-sync-transaction-file-v1\0');
    hash.update(await readFile(path));
    return hash.digest('hex');
  }
  if (information.isDirectory() && !information.isSymbolicLink()) {
    hash.update('skill-sync-transaction-tree-v1\0');
    hash.update(await sha256TreeDigest(path, { rejectNestedSkillRoots: false }));
    return hash.digest('hex');
  }
  throw new Error(`Refusing to digest non-regular transaction content: ${path}`);
}

/**
 * Commit all replacements as one logical transaction. Each replacement uses same-filesystem
 * renames; any later failure restores every destination already changed by this call.
 */
export async function replacePathsAtomically(options: {
  readonly hooks?: TransactionHooks;
  readonly journalDirectory?: string;
  readonly kind: string;
  readonly now?: () => Date;
  readonly operationGuard?: OperationGuard;
  readonly operationId: string;
  readonly replacements: readonly AtomicReplacement[];
  readonly reviewedPlanFingerprint?: string;
  readonly root: string;
  readonly scope?: OperationJournalV2['scope'];
}): Promise<{ readonly journal?: OperationJournalHandle }> {
  const operationId = operationIdSchema.parse(options.operationId);
  const lexicalRoot = resolve(options.root);
  const realRoot = await realpath(options.root);
  const now = options.now ?? (() => new Date());
  const destinations = new Set<string>();
  const prepared: PreparedReplacement[] = [];

  for (const [index, replacement] of options.replacements.entries()) {
    const lexicalDestination = isAbsolute(replacement.destinationPath)
      ? resolve(replacement.destinationPath)
      : resolve(lexicalRoot, replacement.destinationPath);
    if (
      !isPathContained(lexicalRoot, lexicalDestination) ||
      lexicalDestination === lexicalRoot ||
      basename(lexicalDestination) === ''
    ) {
      throw new Error(
        `Replacement destination escapes or equals its transaction root: ${lexicalDestination}`,
      );
    }
    const destinationRelativePath = portablePathFromRoot(lexicalRoot, lexicalDestination);
    const destination = resolve(realRoot, ...destinationRelativePath.split('/'));
    await resolveContainedProjectPath(realRoot, destinationRelativePath);
    if (destinations.has(destination)) {
      throw new Error(`Replacement destination occurs more than once: ${destinationRelativePath}`);
    }
    destinations.add(destination);
    if (replacement.action === 'replace' && replacement.stagedPath === undefined) {
      throw new Error(`Replacement requires staged content: ${destinationRelativePath}`);
    }
    if (replacement.action === 'remove' && replacement.stagedPath !== undefined) {
      throw new Error(`Removal must not include staged content: ${destinationRelativePath}`);
    }

    const artifactPaths = deterministicOperationPaths(destinationRelativePath, operationId, index);
    const candidatePath =
      replacement.action === 'replace'
        ? resolve(realRoot, ...artifactPaths.candidate.split('/'))
        : undefined;
    const rollbackPath = resolve(realRoot, ...artifactPaths.rollback.split('/'));
    if (
      (candidatePath !== undefined && (await pathExists(candidatePath))) ||
      (await pathExists(rollbackPath))
    ) {
      throw new Error(
        `Deterministic transaction artifacts already exist for ${destinationRelativePath}.`,
      );
    }
    const sourceDigest =
      replacement.stagedPath === undefined
        ? null
        : await transactionContentDigest(replacement.stagedPath);
    const originalDigest = (await pathExists(destination))
      ? await transactionContentDigest(destination)
      : null;
    prepared.push({
      action: replacement.action,
      ...(candidatePath === undefined
        ? {}
        : { candidatePath, candidateRelativePath: artifactPaths.candidate }),
      destinationPath: destination,
      destinationRelativePath,
      ...(replacement.expectedOriginalDigest === undefined
        ? {}
        : { expectedOriginalDigest: replacement.expectedOriginalDigest }),
      finalDigest: sourceDigest,
      newCommitted: false,
      originalDigest,
      originalMoved: false,
      rollbackRelativePath: artifactPaths.rollback,
      rollbackPath,
      sourceDigest,
      ...(replacement.stagedPath === undefined ? {} : { stagedPath: replacement.stagedPath }),
    });
  }

  const journalEntries = (
    stateForIndex: (index: number) => OperationJournalV2Entry['state'],
  ): OperationJournalV2Entry[] =>
    prepared.map((replacement, index) => ({
      action: replacement.action,
      ...(replacement.candidateRelativePath === undefined
        ? {}
        : { candidate: replacement.candidateRelativePath }),
      destination: replacement.destinationRelativePath,
      finalDigest: replacement.finalDigest,
      originalDigest: replacement.originalDigest,
      rollback: replacement.rollbackRelativePath,
      sourceDigest: replacement.sourceDigest,
      state: stateForIndex(index),
    }));
  const rootFingerprint = transactionRootFingerprint(realRoot);
  const planFingerprint =
    options.reviewedPlanFingerprint ??
    preparedPlanFingerprint(options.kind, rootFingerprint, prepared);

  for (const replacement of prepared) {
    if (
      replacement.expectedOriginalDigest !== undefined &&
      replacement.expectedOriginalDigest !== replacement.originalDigest
    ) {
      throw new MutationPlanChangedError(
        replacement.destinationRelativePath,
        'destination-digest',
        planFingerprint,
      );
    }
  }

  let journal: OperationJournalV2Handle | undefined;
  if (options.journalDirectory !== undefined) {
    journal = await createOperationJournalV2(options.journalDirectory, {
      entries: journalEntries(() => 'pending'),
      kind: options.kind,
      now: now(),
      operationId,
      rootFingerprint,
      scope:
        options.scope ??
        ({
          id: `root-${rootFingerprint}`,
          kind: options.kind.startsWith('global-') ? 'global' : 'project',
        } satisfies OperationJournalV2['scope']),
    });
    await options.hooks?.afterDurableStep?.('journal-created');
  }
  const entryStates: OperationJournalV2Entry['state'][] = prepared.map(() => 'pending');

  try {
    for (const [index, replacement] of prepared.entries()) {
      await mkdir(dirname(replacement.destinationPath), { recursive: true, mode: 0o700 });
      if (replacement.candidatePath !== undefined && replacement.stagedPath !== undefined) {
        await copyRegularPath(replacement.stagedPath, replacement.candidatePath);
        await syncRegularPath(replacement.candidatePath);
        await syncDirectoryDurably(dirname(replacement.candidatePath));
      }
      entryStates[index] = 'prepared';
      await options.hooks?.afterDurableStep?.('candidate-prepared', index);
    }
    if (journal !== undefined) {
      journal = {
        path: journal.path,
        value: await updateOperationJournalV2(journal.path, {
          entries: journalEntries((index) => entryStates[index] ?? 'pending'),
          now: now(),
          status: 'prepared',
        }),
      };
      await options.hooks?.afterDurableStep?.('journal-prepared');
    }
    for (const replacement of prepared) {
      const destinationDigest = (await pathExists(replacement.destinationPath))
        ? await transactionContentDigest(replacement.destinationPath)
        : null;
      if (destinationDigest !== replacement.originalDigest) {
        throw new MutationPlanChangedError(
          replacement.destinationRelativePath,
          'destination-digest',
          planFingerprint,
        );
      }
      if (replacement.candidatePath !== undefined) {
        const candidateDigest = await transactionContentDigest(replacement.candidatePath);
        if (candidateDigest !== replacement.finalDigest) {
          throw new MutationPlanChangedError(
            replacement.destinationRelativePath,
            'candidate-digest',
            planFingerprint,
          );
        }
      }
    }
    if (journal !== undefined) {
      options.operationGuard?.beginCommit();
      journal = {
        path: journal.path,
        value: await updateOperationJournalV2(journal.path, {
          entries: journal.value.entries,
          now: now(),
          status: 'committing',
        }),
      };
      await options.hooks?.afterDurableStep?.('journal-committing');
    } else {
      options.operationGuard?.beginCommit();
    }

    for (const [index, replacement] of prepared.entries()) {
      await options.hooks?.beforeCommit?.(index);
      if (await pathExists(replacement.destinationPath)) {
        await renameDurably(replacement.destinationPath, replacement.rollbackPath);
        replacement.originalMoved = true;
        entryStates[index] = 'original-moved';
        await options.hooks?.afterDurableStep?.('original-moved', index);
        if (journal !== undefined) {
          journal = {
            path: journal.path,
            value: await updateOperationJournalV2(journal.path, {
              entries: journalEntries((entryIndex) => entryStates[entryIndex] ?? 'pending'),
              now: now(),
              status: 'committing',
            }),
          };
          await options.hooks?.afterDurableStep?.('journal-original-moved', index);
        }
      }
      if (replacement.action === 'replace') {
        if (replacement.candidatePath === undefined) {
          throw new Error('Prepared replacement is missing its candidate path.');
        }
        await renameDurably(replacement.candidatePath, replacement.destinationPath);
        replacement.newCommitted = true;
        await options.hooks?.afterDurableStep?.('candidate-committed', index);
      }
      entryStates[index] = 'committed';
      if (journal !== undefined) {
        journal = {
          path: journal.path,
          value: await updateOperationJournalV2(journal.path, {
            entries: journalEntries((entryIndex) => entryStates[entryIndex] ?? 'pending'),
            now: now(),
            status: 'committing',
          }),
        };
        await options.hooks?.afterDurableStep?.('journal-entry-committed', index);
      }
    }

    if (journal !== undefined) {
      journal = {
        path: journal.path,
        value: await updateOperationJournalV2(journal.path, {
          entries: journalEntries((index) => entryStates[index] ?? 'pending'),
          now: now(),
          status: 'committed',
        }),
      };
      options.operationGuard?.markCommitted();
      await options.hooks?.afterDurableStep?.('journal-committed');
    } else {
      options.operationGuard?.markCommitted();
    }
    // Cleanup happens only after the transaction is durably marked committed. A cleanup failure
    // leaves a recoverable hidden rollback copy and must never trigger removal of committed data.
    for (const replacement of prepared) {
      if (replacement.originalMoved) {
        await removeDurably(replacement.rollbackPath).catch(() => undefined);
      }
    }
    return { ...(journal === undefined ? {} : { journal }) };
  } catch (error) {
    if (journal?.value.status === 'committed' || options.operationGuard?.state === 'committed') {
      return { ...(journal === undefined ? {} : { journal }) };
    }
    if (
      journal !== undefined &&
      ['preparing', 'prepared', 'committing'].includes(journal.value.status)
    ) {
      journal = {
        path: journal.path,
        value: await updateOperationJournalV2(journal.path, {
          entries: journalEntries((index) => entryStates[index] ?? 'pending'),
          now: now(),
          status: 'rolling-back',
        }),
      };
      await options.hooks?.afterDurableStep?.('journal-rolling-back');
    }

    const rollbackFailures: unknown[] = [];
    for (const [reverseIndex, replacement] of [...prepared].reverse().entries()) {
      const index = prepared.length - reverseIndex - 1;
      try {
        if (replacement.newCommitted && (await pathExists(replacement.destinationPath))) {
          await removeDurably(replacement.destinationPath);
          replacement.newCommitted = false;
          await options.hooks?.afterDurableStep?.('committed-destination-removed', index);
        }
        if (replacement.originalMoved && (await pathExists(replacement.rollbackPath))) {
          await renameDurably(replacement.rollbackPath, replacement.destinationPath);
          replacement.originalMoved = false;
          await options.hooks?.afterDurableStep?.('original-restored', index);
        }
        if (
          replacement.candidatePath !== undefined &&
          (await pathExists(replacement.candidatePath))
        ) {
          await removeDurably(replacement.candidatePath);
          await options.hooks?.afterDurableStep?.('candidate-removed', index);
        }
        entryStates[index] = 'restored';
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }

    if (journal !== undefined) {
      const finalStatus = rollbackFailures.length === 0 ? 'rolled-back' : 'failed';
      try {
        journal = {
          path: journal.path,
          value: await updateOperationJournalV2(journal.path, {
            entries: journalEntries((index) => entryStates[index] ?? 'pending'),
            note: redactCredentials(error instanceof Error ? error.message : String(error)),
            now: now(),
            status: finalStatus,
          }),
        };
        await options.hooks?.afterDurableStep?.(
          finalStatus === 'rolled-back' ? 'journal-rolled-back' : 'journal-failed',
        );
      } catch (journalError) {
        rollbackFailures.push(journalError);
      }
    }
    if (rollbackFailures.length > 0) {
      if (
        options.operationGuard !== undefined &&
        options.operationGuard.state !== 'recovery-required'
      ) {
        options.operationGuard.markRecoveryRequired();
      }
      throw new TransactionRollbackError(rollbackFailures, { cause: error });
    }
    if (options.operationGuard !== undefined && options.operationGuard.state !== 'rolled-back') {
      options.operationGuard.markRolledBack();
    }
    if (error instanceof RecoveryIntegrityError || error instanceof SkillSyncError) throw error;
    throw new TransactionRolledBackError({ cause: error });
  }
}

export type RecoveryResumeAction = 'commit-candidate' | 'mark-committed' | 'move-original';

export interface RecoveryResumePlanEntry {
  readonly action: OperationJournalV2Entry['action'];
  readonly actions: readonly RecoveryResumeAction[];
  readonly candidate?: string;
  readonly destination: string;
  readonly index: number;
  readonly rollback: string;
}

export interface RecoveryResumePlan {
  readonly entries: readonly RecoveryResumePlanEntry[];
  readonly fingerprint: string;
  readonly journalPath: string;
  readonly operationId: string;
  readonly root: string;
  readonly rootFingerprint: string;
  readonly status: OperationJournalStatus;
}

export class TransactionRecoveryValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TransactionRecoveryValidationError';
  }
}

async function digestIfPresent(path: string): Promise<string | null> {
  if (!(await pathExists(path))) return null;
  return await transactionContentDigest(path);
}

function recoveryPlanFingerprint(plan: Omit<RecoveryResumePlan, 'fingerprint'>): string {
  return createHash('sha256')
    .update('skill-sync-recovery-resume-plan-v1\0')
    .update(stableJsonStringify(plan))
    .digest('hex');
}

export async function planOperationJournalResume(
  journalPath: string,
  root: string,
): Promise<RecoveryResumePlan> {
  const journal = await readOperationJournal(journalPath);
  if (journal.schemaVersion !== OPERATION_JOURNAL_SCHEMA_VERSION) {
    throw new TransactionRecoveryValidationError(
      'Legacy operation journals are inspect-only and cannot be resumed.',
    );
  }
  if (journal.status === 'rolled-back' || journal.status === 'rolling-back') {
    throw new TransactionRecoveryValidationError(
      `Operation ${journal.operationId} is ${journal.status} and cannot be resumed forward.`,
    );
  }
  const realRoot = await realpath(root);
  const rootFingerprint = transactionRootFingerprint(realRoot);
  if (rootFingerprint !== journal.rootFingerprint) {
    throw new TransactionRecoveryValidationError(
      'The selected recovery root does not match the journal root fingerprint.',
    );
  }

  const entries: RecoveryResumePlanEntry[] = [];
  for (const [index, entry] of journal.entries.entries()) {
    await resolveContainedProjectPath(realRoot, entry.destination);
    await resolveContainedProjectPath(realRoot, entry.rollback);
    if (entry.candidate !== undefined) {
      await resolveContainedProjectPath(realRoot, entry.candidate);
    }
    const destination = resolve(realRoot, ...entry.destination.split('/'));
    const rollback = resolve(realRoot, ...entry.rollback.split('/'));
    const candidate =
      entry.candidate === undefined ? undefined : resolve(realRoot, ...entry.candidate.split('/'));
    const destinationDigest = await digestIfPresent(destination);
    const rollbackDigest = await digestIfPresent(rollback);
    const candidateDigest = candidate === undefined ? null : await digestIfPresent(candidate);

    if (rollbackDigest !== null && rollbackDigest !== entry.originalDigest) {
      throw new TransactionRecoveryValidationError(
        `Rollback evidence conflicts with the journal for ${entry.destination}.`,
      );
    }
    if (candidateDigest !== null && candidateDigest !== entry.sourceDigest) {
      throw new TransactionRecoveryValidationError(
        `Candidate evidence conflicts with the journal for ${entry.destination}.`,
      );
    }

    const actions: RecoveryResumeAction[] = [];
    if (entry.action === 'replace') {
      if (destinationDigest === entry.finalDigest && candidateDigest === null) {
        actions.push('mark-committed');
      } else {
        if (candidateDigest !== entry.sourceDigest || candidate === undefined) {
          throw new TransactionRecoveryValidationError(
            `The replacement candidate is unavailable for ${entry.destination}.`,
          );
        }
        if (destinationDigest === entry.originalDigest && rollbackDigest === null) {
          if (entry.originalDigest !== null) actions.push('move-original');
        } else if (
          destinationDigest !== null ||
          (entry.originalDigest !== null && rollbackDigest !== entry.originalDigest)
        ) {
          throw new TransactionRecoveryValidationError(
            `Destination evidence conflicts with the journal for ${entry.destination}.`,
          );
        }
        actions.push('commit-candidate');
      }
    } else if (destinationDigest === null) {
      if (
        entry.originalDigest !== null &&
        rollbackDigest !== null &&
        rollbackDigest !== entry.originalDigest
      ) {
        throw new TransactionRecoveryValidationError(
          `Removal rollback evidence conflicts with the journal for ${entry.destination}.`,
        );
      }
      actions.push('mark-committed');
    } else if (destinationDigest === entry.originalDigest && rollbackDigest === null) {
      actions.push('move-original', 'mark-committed');
    } else {
      throw new TransactionRecoveryValidationError(
        `Removal destination conflicts with the journal for ${entry.destination}.`,
      );
    }

    entries.push({
      action: entry.action,
      actions,
      ...(candidate === undefined ? {} : { candidate }),
      destination,
      index,
      rollback,
    });
  }

  const planWithoutFingerprint = {
    entries,
    journalPath,
    operationId: journal.operationId,
    root: realRoot,
    rootFingerprint,
    status: journal.status,
  };
  return {
    ...planWithoutFingerprint,
    fingerprint: recoveryPlanFingerprint(planWithoutFingerprint),
  };
}

export async function resumeOperationJournal(options: {
  readonly expectedFingerprint: string;
  readonly hooks?: TransactionHooks;
  readonly journalPath: string;
  readonly now?: () => Date;
  readonly operationGuard?: OperationGuard;
  readonly root: string;
}): Promise<OperationJournalV2Handle> {
  const plan = await planOperationJournalResume(options.journalPath, options.root);
  if (plan.fingerprint !== options.expectedFingerprint) {
    throw new TransactionRecoveryValidationError(
      'Recovery evidence changed after review; generate and confirm a fresh resume plan.',
    );
  }
  const current = await readOperationJournal(options.journalPath);
  if (current.schemaVersion !== OPERATION_JOURNAL_SCHEMA_VERSION) {
    throw new TransactionRecoveryValidationError('Legacy operation journals are inspect-only.');
  }
  if (current.status === 'committed') {
    return { path: options.journalPath, value: current };
  }

  const now = options.now ?? (() => new Date());
  const entries = current.entries.map((entry) => ({ ...entry }));
  const setEntryState = (index: number, state: OperationJournalV2Entry['state']): void => {
    const entry = entries[index];
    if (entry === undefined) {
      throw new TransactionRecoveryValidationError(
        `Resume plan references missing journal entry ${String(index)}.`,
      );
    }
    entries[index] = { ...entry, state };
  };
  options.operationGuard?.beginCommit();
  await updateOperationJournalV2(options.journalPath, {
    entries,
    now: now(),
    status: 'committing',
  });
  await options.hooks?.afterDurableStep?.('journal-committing');

  for (const planned of plan.entries) {
    for (const action of planned.actions) {
      if (action === 'move-original') {
        await renameDurably(planned.destination, planned.rollback);
        setEntryState(planned.index, 'original-moved');
        await options.hooks?.afterDurableStep?.('original-moved', planned.index);
        await updateOperationJournalV2(options.journalPath, {
          entries,
          now: now(),
          status: 'committing',
        });
        await options.hooks?.afterDurableStep?.('journal-original-moved', planned.index);
      } else if (action === 'commit-candidate') {
        if (planned.candidate === undefined) {
          throw new TransactionRecoveryValidationError(
            `Resume plan is missing a candidate for ${planned.destination}.`,
          );
        }
        await renameDurably(planned.candidate, planned.destination);
        setEntryState(planned.index, 'committed');
        await options.hooks?.afterDurableStep?.('candidate-committed', planned.index);
        await updateOperationJournalV2(options.journalPath, {
          entries,
          now: now(),
          status: 'committing',
        });
        await options.hooks?.afterDurableStep?.('journal-entry-committed', planned.index);
      } else {
        setEntryState(planned.index, 'committed');
        await updateOperationJournalV2(options.journalPath, {
          entries,
          now: now(),
          status: 'committing',
        });
        await options.hooks?.afterDurableStep?.('journal-entry-committed', planned.index);
      }
    }
  }

  const journal = await updateOperationJournalV2(options.journalPath, {
    entries,
    now: now(),
    status: 'committed',
  });
  options.operationGuard?.markCommitted();
  await options.hooks?.afterDurableStep?.('journal-committed');
  for (const entry of plan.entries) {
    if (await pathExists(entry.rollback)) {
      await removeDurably(entry.rollback).catch(() => undefined);
    }
  }
  return { path: options.journalPath, value: journal };
}

export type RecoveryRestoreAction =
  'mark-restored' | 'remove-candidate' | 'remove-committed' | 'restore-original';

export interface RecoveryRestorePlanEntry {
  readonly actions: readonly RecoveryRestoreAction[];
  readonly candidate?: string;
  readonly destination: string;
  readonly index: number;
  readonly rollback: string;
}

export interface RecoveryRestorePlan {
  readonly entries: readonly RecoveryRestorePlanEntry[];
  readonly fingerprint: string;
  readonly journalPath: string;
  readonly operationId: string;
  readonly root: string;
  readonly rootFingerprint: string;
  readonly status: OperationJournalStatus;
}

function recoveryRestorePlanFingerprint(plan: Omit<RecoveryRestorePlan, 'fingerprint'>): string {
  return createHash('sha256')
    .update('skill-sync-recovery-restore-plan-v1\0')
    .update(stableJsonStringify(plan))
    .digest('hex');
}

export async function planOperationJournalRestore(
  journalPath: string,
  root: string,
): Promise<RecoveryRestorePlan> {
  const journal = await readOperationJournal(journalPath);
  if (journal.schemaVersion !== OPERATION_JOURNAL_SCHEMA_VERSION) {
    throw new TransactionRecoveryValidationError(
      'Legacy operation journals are inspect-only and cannot be restored.',
    );
  }
  const realRoot = await realpath(root);
  const rootFingerprint = transactionRootFingerprint(realRoot);
  if (rootFingerprint !== journal.rootFingerprint) {
    throw new TransactionRecoveryValidationError(
      'The selected recovery root does not match the journal root fingerprint.',
    );
  }

  const entries: RecoveryRestorePlanEntry[] = [];
  for (const [index, entry] of journal.entries.entries()) {
    await resolveContainedProjectPath(realRoot, entry.destination);
    await resolveContainedProjectPath(realRoot, entry.rollback);
    if (entry.candidate !== undefined) {
      await resolveContainedProjectPath(realRoot, entry.candidate);
    }
    const destination = resolve(realRoot, ...entry.destination.split('/'));
    const rollback = resolve(realRoot, ...entry.rollback.split('/'));
    const candidate =
      entry.candidate === undefined ? undefined : resolve(realRoot, ...entry.candidate.split('/'));
    const destinationDigest = await digestIfPresent(destination);
    const rollbackDigest = await digestIfPresent(rollback);
    const candidateDigest = candidate === undefined ? null : await digestIfPresent(candidate);

    if (rollbackDigest !== null && rollbackDigest !== entry.originalDigest) {
      throw new TransactionRecoveryValidationError(
        `Rollback evidence conflicts with the journal for ${entry.destination}.`,
      );
    }
    if (candidateDigest !== null && candidateDigest !== entry.sourceDigest) {
      throw new TransactionRecoveryValidationError(
        `Candidate evidence conflicts with the journal for ${entry.destination}.`,
      );
    }

    const actions: RecoveryRestoreAction[] = [];
    if (entry.originalDigest === null) {
      if (rollbackDigest !== null) {
        throw new TransactionRecoveryValidationError(
          `Unexpected rollback content exists for ${entry.destination}.`,
        );
      }
      if (destinationDigest !== null) {
        if (entry.action !== 'replace' || destinationDigest !== entry.finalDigest) {
          throw new TransactionRecoveryValidationError(
            `Destination evidence conflicts with the journal for ${entry.destination}.`,
          );
        }
        actions.push('remove-committed');
      }
    } else if (destinationDigest === entry.originalDigest && rollbackDigest === null) {
      // The original state is already present.
    } else if (
      (destinationDigest === null || destinationDigest === entry.finalDigest) &&
      rollbackDigest === entry.originalDigest
    ) {
      if (destinationDigest !== null) actions.push('remove-committed');
      actions.push('restore-original');
    } else {
      throw new TransactionRecoveryValidationError(
        `Destination evidence conflicts with the journal for ${entry.destination}.`,
      );
    }
    if (candidateDigest !== null) actions.push('remove-candidate');
    actions.push('mark-restored');

    entries.push({
      actions,
      ...(candidate === undefined ? {} : { candidate }),
      destination,
      index,
      rollback,
    });
  }

  const planWithoutFingerprint = {
    entries,
    journalPath,
    operationId: journal.operationId,
    root: realRoot,
    rootFingerprint,
    status: journal.status,
  };
  return {
    ...planWithoutFingerprint,
    fingerprint: recoveryRestorePlanFingerprint(planWithoutFingerprint),
  };
}

export async function restoreOperationJournal(options: {
  readonly expectedFingerprint: string;
  readonly hooks?: TransactionHooks;
  readonly journalPath: string;
  readonly now?: () => Date;
  readonly operationGuard?: OperationGuard;
  readonly root: string;
}): Promise<OperationJournalV2Handle> {
  const plan = await planOperationJournalRestore(options.journalPath, options.root);
  if (plan.fingerprint !== options.expectedFingerprint) {
    throw new TransactionRecoveryValidationError(
      'Recovery evidence changed after review; generate and confirm a fresh restore plan.',
    );
  }
  const current = await readOperationJournal(options.journalPath);
  if (current.schemaVersion !== OPERATION_JOURNAL_SCHEMA_VERSION) {
    throw new TransactionRecoveryValidationError('Legacy operation journals are inspect-only.');
  }
  if (current.status === 'rolled-back') {
    return { path: options.journalPath, value: current };
  }

  const now = options.now ?? (() => new Date());
  const entries = current.entries.map((entry) => ({ ...entry }));
  const setEntryState = (index: number, state: OperationJournalV2Entry['state']): void => {
    const entry = entries[index];
    if (entry === undefined) {
      throw new TransactionRecoveryValidationError(
        `Restore plan references missing journal entry ${String(index)}.`,
      );
    }
    entries[index] = { ...entry, state };
  };
  options.operationGuard?.beginCommit();
  await updateOperationJournalV2(options.journalPath, {
    entries,
    now: now(),
    status: 'rolling-back',
  });
  await options.hooks?.afterDurableStep?.('journal-rolling-back');

  for (const planned of [...plan.entries].reverse()) {
    for (const action of planned.actions) {
      if (action === 'remove-committed') {
        await removeDurably(planned.destination);
        const originalExists = await pathExists(planned.rollback);
        setEntryState(planned.index, originalExists ? 'original-moved' : 'restored');
        await options.hooks?.afterDurableStep?.('committed-destination-removed', planned.index);
      } else if (action === 'restore-original') {
        await renameDurably(planned.rollback, planned.destination);
        setEntryState(planned.index, 'restored');
        await options.hooks?.afterDurableStep?.('original-restored', planned.index);
      } else if (action === 'remove-candidate') {
        if (planned.candidate !== undefined) {
          await removeDurably(planned.candidate);
          await options.hooks?.afterDurableStep?.('candidate-removed', planned.index);
        }
      } else {
        setEntryState(planned.index, 'restored');
      }
      await updateOperationJournalV2(options.journalPath, {
        entries,
        now: now(),
        status: 'rolling-back',
      });
    }
  }

  const journal = await updateOperationJournalV2(options.journalPath, {
    entries,
    now: now(),
    status: 'rolled-back',
  });
  options.operationGuard?.markCommitted();
  await options.hooks?.afterDurableStep?.('journal-rolled-back');
  return { path: options.journalPath, value: journal };
}
