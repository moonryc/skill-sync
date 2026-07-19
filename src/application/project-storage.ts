import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { ProjectMutationStorage } from './project-installation.js';
import type { ApplicationPaths } from '../infrastructure/config.js';

/**
 * Derive bounded per-project coordination paths without persisting the project
 * path itself in a global filename.
 */
export function projectMutationStorage(
  paths: ApplicationPaths,
  projectRoot: string,
): ProjectMutationStorage {
  const projectKey = createHash('sha256').update(projectRoot).digest('hex');
  return {
    backupRoot: join(paths.backupsDirectory, projectKey),
    journalDirectory: join(paths.journalsDirectory, projectKey),
    lockPath: join(paths.locksDirectory, `project-${projectKey}.lock`),
    stagingRoot: join(paths.stateDirectory, 'staging', projectKey),
  };
}
