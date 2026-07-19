import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ApplicationPaths } from '../infrastructure/config.js';
import {
  listOperationJournals,
  readAdvisoryLock,
  type AdvisoryLockMetadata,
  type OperationJournal,
} from '../infrastructure/transactions.js';

export interface RecoveryLockFinding {
  readonly path: string;
  readonly owner?: AdvisoryLockMetadata;
  readonly problem?: string;
}

export interface RecoveryJournalFinding {
  readonly path: string;
  readonly journal: OperationJournal;
}

export interface RecoveryBackupFinding {
  readonly path: string;
}

export interface RecoveryInspection {
  readonly locks: readonly RecoveryLockFinding[];
  readonly journals: readonly RecoveryJournalFinding[];
  readonly backups: readonly RecoveryBackupFinding[];
  readonly remediation: readonly string[];
}

async function directoryEntries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function inspectRecoveryState(paths: ApplicationPaths): Promise<RecoveryInspection> {
  const locks: RecoveryLockFinding[] = [];
  for (const name of await directoryEntries(paths.locksDirectory)) {
    const path = join(paths.locksDirectory, name);
    try {
      const information = await lstat(path);
      if (!information.isFile() || information.isSymbolicLink()) continue;
      try {
        const owner = await readAdvisoryLock(path);
        locks.push({ path, ...(owner === undefined ? {} : { owner }) });
      } catch (error) {
        locks.push({ path, problem: error instanceof Error ? error.message : String(error) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const terminal = new Set<OperationJournal['status']>(['committed', 'rolled-back']);
  const journals = (await listOperationJournals(paths.journalsDirectory))
    .filter((handle) => !terminal.has(handle.value.status))
    .map((handle) => ({ path: handle.path, journal: handle.value }));

  const backups: RecoveryBackupFinding[] = [];
  for (const name of await directoryEntries(paths.backupsDirectory)) {
    const path = join(paths.backupsDirectory, name);
    try {
      const information = await lstat(path);
      if (information.isDirectory() && !information.isSymbolicLink()) backups.push({ path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const remediation: string[] = [];
  if (locks.length > 0) {
    remediation.push(
      'Verify that no skill-sync process is active before removing abandoned locks.',
    );
  }
  if (journals.length > 0) {
    remediation.push('Inspect incomplete operation journals and restore recorded rollback paths.');
  }
  if (backups.length > 0) {
    remediation.push('Keep recoverable backups until the associated project changes are verified.');
  }
  return { locks, journals, backups, remediation };
}

export function recoveryWarningLines(inspection: RecoveryInspection): readonly string[] {
  if (inspection.locks.length === 0 && inspection.journals.length === 0) return [];
  return [
    `Recovery state detected: ${String(inspection.locks.length)} lock(s), ${String(inspection.journals.length)} incomplete journal(s).`,
    ...inspection.remediation,
  ];
}
