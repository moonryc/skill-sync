import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '../application/config-service.js';
import {
  FileLibraryConfigStore,
  LibraryLifecycleService,
} from '../application/library-lifecycle.js';
import { resolveApplicationPaths, type ApplicationPaths } from '../infrastructure/config.js';
import { GitClient } from '../infrastructure/git.js';
import { LibraryCache } from '../infrastructure/library-cache.js';
import type { RuntimeIo } from '../ports/index.js';
import { runWithRuntimeBoundary } from '../runtime/boundary.js';
import { createConfigDoctorCommandHandler } from './config-doctor-handler.js';
import type { CommandExecutor } from './program.js';
import { createWorkflowCommandHandler } from './workflow-handler.js';

export interface DefaultCommandExecutorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly paths?: ApplicationPaths;
}

export function createDefaultCommandExecutor(
  io: RuntimeIo,
  options: DefaultCommandExecutorOptions = {},
): CommandExecutor {
  const environment = options.environment ?? process.env;
  const paths = options.paths ?? resolveApplicationPaths({ env: environment });
  const git = new GitClient({
    environment,
    safetyDirectory: join(paths.stateDirectory, 'git-safety'),
  });
  const cache = new LibraryCache({ rootDirectory: paths.cacheDirectory, git });
  const config = new ConfigService(environment, paths);
  const lifecycle = new LibraryLifecycleService({
    cache,
    config: new FileLibraryConfigStore(paths.configFile),
    git,
    stagingRoot: join(paths.stateDirectory, 'library-staging'),
  });
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
        const systemResult = await system(invocation);
        if (systemResult !== undefined) return systemResult;
        return await workflows(invocation, context);
      },
      {
        diagnostics: (diagnostic) => {
          io.writeStderr(`${diagnostic.code}: ${diagnostic.message}\n`);
        },
      },
    );
}
