import type { ApplicationPaths } from '../infrastructure/config.js';
import type { TargetAdapter } from '../targets/index.js';

export type ManagedScope =
  | { readonly kind: 'project'; readonly root: string }
  | { readonly kind: 'global'; readonly root: string };

/** Shared scope data for project and user-level managed copies. */
export interface ManagedScopeDescriptor {
  readonly scope: ManagedScope;
  readonly stateDirectory: string;
  readonly manifestPath: string;
  readonly lockPath: string;
  readonly backupDirectory: string;
  readonly targetDestination: (adapter: TargetAdapter, skillLeafName: string) => string;
}

export function globalManagedScope(paths: ApplicationPaths): ManagedScopeDescriptor {
  if (
    paths.globalStateDirectory === undefined ||
    paths.globalManifestFile === undefined ||
    paths.globalLockFile === undefined
  ) {
    throw new Error('Global skill state paths are unavailable.');
  }
  return {
    scope: { kind: 'global', root: paths.globalStateDirectory },
    stateDirectory: paths.globalStateDirectory,
    manifestPath: paths.globalManifestFile,
    lockPath: paths.globalLockFile,
    backupDirectory: paths.backupsDirectory,
    targetDestination: (adapter, skillLeafName) => {
      if (adapter.globalDestination === undefined) {
        throw new Error(`Target ${adapter.name} does not support global skills.`);
      }
      return adapter.globalDestination(skillLeafName);
    },
  };
}
