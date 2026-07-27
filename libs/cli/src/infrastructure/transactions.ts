import { randomUUID } from 'node:crypto';
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
  chmod,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { portableRelativePathSchema } from '../domain/project-state.js';
import { redactCredentials } from './config.js';
import { isPathContained, resolveContainedProjectPath } from './project-state.js';
import { stableJsonStringify, writeJsonAtomic } from './stable-json.js';

const TRANSACTION_SCHEMA_VERSION = 1 as const;
const operationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'Invalid operation ID.');

const lockMetadataSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  hostname: z.string().min(1),
  operationId: operationIdSchema,
  ownerToken: z.uuid(),
  pid: z.number().int().positive(),
  schemaVersion: z.literal(TRANSACTION_SCHEMA_VERSION),
});

export type AdvisoryLockMetadata = z.infer<typeof lockMetadataSchema>;

export class AdvisoryLockUnavailableError extends Error {
  public readonly lockPath: string;
  public readonly owner: AdvisoryLockMetadata | undefined;

  public constructor(lockPath: string, owner?: AdvisoryLockMetadata) {
    super(
      owner === undefined
        ? `Another operation holds advisory lock ${lockPath}.`
        : `Operation ${owner.operationId} (PID ${String(owner.pid)} on ${owner.hostname}) holds advisory lock ${lockPath}.`,
    );
    this.name = 'AdvisoryLockUnavailableError';
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export class AdvisoryLockOwnershipError extends Error {
  public constructor(lockPath: string) {
    super(`Advisory lock ownership changed before release: ${lockPath}.`);
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
  },
): Promise<AdvisoryLock> {
  const metadata = lockMetadataSchema.parse({
    createdAt: (options.now ?? new Date()).toISOString(),
    hostname: options.hostname ?? hostname(),
    operationId: options.operationId,
    ownerToken: randomUUID(),
    pid: options.pid ?? process.pid,
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
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
      throw new AdvisoryLockUnavailableError(path, owner);
    }
    await unlink(path).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    metadata,
    path,
    release: async () => {
      if (released) return;
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

export interface OperationJournalHandle {
  readonly path: string;
  readonly value: OperationJournal;
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

export async function readOperationJournal(path: string): Promise<OperationJournal> {
  const contents = await readFile(path, 'utf8');
  return operationJournalSchema.parse(JSON.parse(contents) as unknown);
}

const validJournalTransitions: Readonly<
  Record<OperationJournalStatus, readonly OperationJournalStatus[]>
> = {
  committed: [],
  committing: ['committed', 'rolling-back', 'failed'],
  failed: [],
  prepared: ['committing', 'rolling-back', 'failed'],
  preparing: ['prepared', 'rolling-back', 'failed'],
  'rolled-back': [],
  'rolling-back': ['rolled-back', 'failed'],
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
  readonly stagedPath?: string;
}

interface PreparedReplacement extends AtomicReplacement {
  readonly candidatePath?: string;
  readonly destinationRelativePath: string;
  readonly rollbackPath: string;
  newCommitted: boolean;
  originalMoved: boolean;
}

export class TransactionRollbackError extends Error {
  public readonly failures: readonly unknown[];

  public constructor(failures: readonly unknown[], options: { readonly cause: unknown }) {
    super('The operation failed and one or more paths could not be rolled back.', options);
    this.name = 'TransactionRollbackError';
    this.failures = failures;
  }
}

function portablePathFromRoot(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  return portableRelativePathSchema.parse(value);
}

/**
 * Commit all replacements as one logical transaction. Each replacement uses same-filesystem
 * renames; any later failure restores every destination already changed by this call.
 */
export async function replacePathsAtomically(options: {
  readonly hooks?: { readonly beforeCommit?: (index: number) => Promise<void> | void };
  readonly journalDirectory?: string;
  readonly kind: string;
  readonly now?: () => Date;
  readonly operationId: string;
  readonly replacements: readonly AtomicReplacement[];
  readonly root: string;
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

    const nonce = `${operationId}-${String(index)}-${randomUUID()}`;
    const candidatePath =
      replacement.action === 'replace'
        ? join(dirname(destination), `.skill-sync-${nonce}-stage`)
        : undefined;
    const rollbackPath = join(dirname(destination), `.skill-sync-${nonce}-rollback`);
    prepared.push({
      action: replacement.action,
      ...(candidatePath === undefined ? {} : { candidatePath }),
      destinationPath: destination,
      destinationRelativePath,
      newCommitted: false,
      originalMoved: false,
      rollbackPath,
      ...(replacement.stagedPath === undefined ? {} : { stagedPath: replacement.stagedPath }),
    });
  }

  let journal: OperationJournalHandle | undefined;
  if (options.journalDirectory !== undefined) {
    journal = await createOperationJournal(options.journalDirectory, {
      entries: prepared.map((replacement) => ({
        action: replacement.action,
        destination: replacement.destinationRelativePath,
        state: 'pending',
      })),
      kind: options.kind,
      now: now(),
      operationId,
    });
  }

  const journalEntries = (stateForIndex: (index: number) => OperationJournalEntry['state']) =>
    prepared.map((replacement, index) => ({
      action: replacement.action,
      destination: replacement.destinationRelativePath,
      state: stateForIndex(index),
    }));

  try {
    for (const replacement of prepared) {
      await mkdir(dirname(replacement.destinationPath), { recursive: true, mode: 0o700 });
      if (replacement.candidatePath !== undefined && replacement.stagedPath !== undefined) {
        await copyRegularPath(replacement.stagedPath, replacement.candidatePath);
      }
    }
    if (journal !== undefined) {
      journal = {
        path: journal.path,
        value: await updateOperationJournal(journal.path, {
          entries: journalEntries(() => 'prepared'),
          now: now(),
          status: 'prepared',
        }),
      };
      journal = {
        path: journal.path,
        value: await updateOperationJournal(journal.path, {
          entries: journal.value.entries,
          now: now(),
          status: 'committing',
        }),
      };
    }

    for (const [index, replacement] of prepared.entries()) {
      await options.hooks?.beforeCommit?.(index);
      if (await pathExists(replacement.destinationPath)) {
        await rename(replacement.destinationPath, replacement.rollbackPath);
        replacement.originalMoved = true;
      }
      if (replacement.action === 'replace') {
        if (replacement.candidatePath === undefined) {
          throw new Error('Prepared replacement is missing its candidate path.');
        }
        await rename(replacement.candidatePath, replacement.destinationPath);
        replacement.newCommitted = true;
      }
    }

    if (journal !== undefined) {
      journal = {
        path: journal.path,
        value: await updateOperationJournal(journal.path, {
          entries: journalEntries(() => 'committed'),
          now: now(),
          status: 'committed',
        }),
      };
    }
    // Cleanup happens only after the transaction is durably marked committed. A cleanup failure
    // leaves a recoverable hidden rollback copy and must never trigger removal of committed data.
    for (const replacement of prepared) {
      if (replacement.originalMoved) {
        await rm(replacement.rollbackPath, { force: true, recursive: true }).catch(() => undefined);
      }
    }
    return { ...(journal === undefined ? {} : { journal }) };
  } catch (error) {
    if (
      journal !== undefined &&
      ['preparing', 'prepared', 'committing'].includes(journal.value.status)
    ) {
      journal = {
        path: journal.path,
        value: await updateOperationJournal(journal.path, {
          entries: journalEntries((index) => {
            const replacement = prepared[index];
            if (replacement?.newCommitted === true) return 'committed';
            if (replacement?.originalMoved === true) return 'original-moved';
            return replacement?.candidatePath === undefined ? 'pending' : 'prepared';
          }),
          now: now(),
          status: 'rolling-back',
        }),
      };
    }

    const rollbackFailures: unknown[] = [];
    for (const replacement of [...prepared].reverse()) {
      try {
        if (replacement.newCommitted && (await pathExists(replacement.destinationPath))) {
          await rm(replacement.destinationPath, { force: true, recursive: true });
        }
        if (replacement.originalMoved && (await pathExists(replacement.rollbackPath))) {
          await rename(replacement.rollbackPath, replacement.destinationPath);
        }
        if (
          replacement.candidatePath !== undefined &&
          (await pathExists(replacement.candidatePath))
        ) {
          await rm(replacement.candidatePath, { force: true, recursive: true });
        }
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }

    if (journal !== undefined) {
      const finalStatus = rollbackFailures.length === 0 ? 'rolled-back' : 'failed';
      const journalBeforeFinalUpdate = journal;
      await updateOperationJournal(journal.path, {
        entries: journalEntries(() => (rollbackFailures.length === 0 ? 'restored' : 'committed')),
        note: redactCredentials(error instanceof Error ? error.message : String(error)),
        now: now(),
        status: finalStatus,
      }).catch(() => journalBeforeFinalUpdate.value);
    }
    if (rollbackFailures.length > 0) {
      throw new TransactionRollbackError(rollbackFailures, { cause: error });
    }
    throw error;
  }
}
