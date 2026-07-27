import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type ConfigurationListing,
  type ConfigService,
} from '../../src/application/config-service.js';
import {
  type LibraryLifecycleService,
  type ValidatedLibrarySnapshot,
} from '../../src/application/library-lifecycle.js';
import {
  installProjectSkills,
  type ProjectMutationStorage,
} from '../../src/application/project-installation.js';
import type { ProjectReconciliationReport } from '../../src/application/project-reconciliation.js';
import {
  createWorkflowCommandHandler,
  reconciliationResult,
} from '../../src/commands/workflow-handler.js';
import { validateLibrary } from '../../src/domain/library.js';
import { EXIT_CODES } from '../../src/domain/result.js';
import { resolveApplicationPaths, type ApplicationPaths } from '../../src/infrastructure/config.js';
import { normalizeGitRemote, type GitClient } from '../../src/infrastructure/git.js';
import type {
  LibraryCache,
  LibraryCacheInspectRequest,
  LibraryCacheRefreshRequest,
  LibraryCacheRevision,
} from '../../src/infrastructure/library-cache.js';
import { AdvisoryLockUnavailableError } from '../../src/infrastructure/transactions.js';
import type { RuntimeIo } from '../../src/ports/index.js';
import { withTempDirectory } from '../helpers/temp.js';

const remoteUrl = 'https://github.com/acme/skills.git';
const identity = 'github.com/acme/skills';
const firstRevision = '1'.repeat(40);
const secondRevision = '2'.repeat(40);

interface LifecycleValidationOptions {
  readonly allowStale?: boolean;
  readonly branch?: string;
  readonly cacheOnly?: boolean;
  readonly remoteUrl?: string;
}

interface LifecycleCalls {
  readonly validated: LifecycleValidationOptions[];
  readonly groupRemove: Readonly<Record<string, unknown>>[];
  readonly libraryRemove: Readonly<Record<string, unknown>>[];
  init: number;
  create: number;
}

interface CacheCalls {
  readonly inspect: LibraryCacheInspectRequest[];
  readonly refresh: LibraryCacheRefreshRequest[];
}

function memoryIo(interactive = false): RuntimeIo {
  return {
    stdinIsTty: interactive,
    stdoutIsTty: interactive,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    setExitCode: () => undefined,
  };
}

function listing(): ConfigurationListing {
  return {
    path: '/config/config.json',
    configured: {
      'library.remote': remoteUrl,
      'library.branch': 'main',
      'library.transport': 'https',
      'defaults.targets': undefined,
      'defaults.gitignore': undefined,
    },
    effective: {
      value: {
        branch: 'main',
        defaultTargets: [],
        gitignore: 'leave',
        libraryUrl: remoteUrl,
        transport: 'https',
      },
      sources: {
        branch: 'user',
        defaultTargets: 'default',
        gitignore: 'default',
        libraryUrl: 'user',
        transport: 'user',
      },
    },
  };
}

async function createLibrary(root: string, body = '# Hello one\n'): Promise<string> {
  const library = join(root, 'library');
  await mkdir(join(library, '.skill-sync'), { recursive: true });
  await mkdir(join(library, 'skills', 'examples', 'hello'), { recursive: true });
  await writeFile(join(library, '.skill-sync', 'library.json'), '{"schemaVersion":1}\n');
  await writeFile(join(library, 'skills', 'examples', '.skill-sync-group.json'), '{}\n');
  await writeFile(
    join(library, 'skills', 'examples', 'hello', 'SKILL.md'),
    `---\nname: hello\ndescription: Example skill\n---\n\n${body}`,
  );
  const validation = await validateLibrary(library);
  expect(validation.errors).toEqual([]);
  return library;
}

async function snapshot(
  libraryRoot: string,
  revision: string,
  options: {
    readonly freshness?: ValidatedLibrarySnapshot['freshness'];
    readonly stale?: boolean;
  } = {},
): Promise<ValidatedLibrarySnapshot> {
  const library = await validateLibrary(libraryRoot);
  if (!library.valid) throw new Error('Fixture library is invalid.');
  return {
    branch: 'main',
    freshness: options.freshness ?? 'fetched',
    identity,
    library,
    revision,
    rootPath: libraryRoot,
    stale: options.stale ?? false,
  };
}

function storage(root: string): ProjectMutationStorage {
  return {
    backupRoot: join(root, 'runtime', 'backups'),
    journalDirectory: join(root, 'runtime', 'journals'),
    lockPath: join(root, 'runtime', 'locks', 'project.lock'),
    stagingRoot: join(root, 'runtime', 'staging'),
  };
}

async function installFixture(root: string, project: string, libraryRoot: string): Promise<void> {
  const validation = await validateLibrary(libraryRoot);
  if (!validation.valid) throw new Error('Fixture library is invalid.');
  await installProjectSkills({
    libraryIdentity: identity,
    libraryRevision: firstRevision,
    operationId: 'workflow-handler-install',
    projectRoot: project,
    skills: validation.skills.map((skill) => ({
      digest: skill.digest,
      id: skill.id,
      name: skill.name,
      rootPath: skill.rootPath,
    })),
    storage: storage(root),
    targets: ['codex'],
  });
}

function cacheRevision(
  libraryRoot: string,
  revision: string,
  freshness: LibraryCacheRevision['freshness'] = 'fetched',
): LibraryCacheRevision {
  const stale = freshness !== 'fetched';
  return {
    branch: 'main',
    freshness,
    identity,
    refreshedAt: '2026-07-19T12:00:00.000Z',
    repositoryDirectory: '/unused/repository.git',
    revision,
    stale,
    treeDirectory: libraryRoot,
    usableForMutation: !stale || freshness === 'offline-revision',
    ...(stale
      ? {
          warning: {
            code: freshness === 'cache-only' ? 'CACHE_ONLY' : 'STALE_CACHE',
            message: 'The cached result is not current with the remote.',
          },
        }
      : {}),
  };
}

function cacheStub(current: LibraryCacheRevision): {
  readonly cache: LibraryCache;
  readonly calls: CacheCalls;
} {
  const calls: CacheCalls = { inspect: [], refresh: [] };
  const value = {
    inspect: (request: LibraryCacheInspectRequest): Promise<LibraryCacheRevision> => {
      calls.inspect.push(request);
      return Promise.resolve({
        ...current,
        freshness: 'cache-only',
        stale: true,
        usableForMutation: false,
      });
    },
    refresh: (request: LibraryCacheRefreshRequest): Promise<LibraryCacheRevision> => {
      calls.refresh.push(request);
      return Promise.resolve(current);
    },
  };
  return { cache: value as unknown as LibraryCache, calls };
}

function lifecycleStub(current: ValidatedLibrarySnapshot): {
  readonly calls: LifecycleCalls;
  readonly lifecycle: LibraryLifecycleService;
} {
  const calls: LifecycleCalls = {
    create: 0,
    groupRemove: [],
    init: 0,
    libraryRemove: [],
    validated: [],
  };
  const value = {
    create: (): Promise<never> => {
      calls.create += 1;
      return Promise.reject(new Error('Unexpected create call.'));
    },
    groupRemove: (request: Readonly<Record<string, unknown>>) => {
      calls.groupRemove.push(request);
      if (request.dryRun !== true) return Promise.reject(new Error('Unexpected group mutation.'));
      return Promise.resolve({
        affectedIds: ['examples/hello'],
        changed: true,
        dryRun: true,
        revision: current.revision,
      });
    },
    groupCreate: (): Promise<never> =>
      Promise.reject(new AdvisoryLockUnavailableError('/runtime/library.lock')),
    init: (request: Readonly<Record<string, unknown>>): Promise<never> => {
      calls.init += 1;
      if (typeof request.url !== 'string') {
        return Promise.reject(new Error('Expected an init URL.'));
      }
      normalizeGitRemote(request.url);
      return Promise.reject(new Error('Unexpected init call.'));
    },
    libraryRemove: (request: Readonly<Record<string, unknown>>) => {
      calls.libraryRemove.push(request);
      if (request.dryRun !== true) return Promise.reject(new Error('Unexpected library mutation.'));
      return Promise.resolve({
        changed: true,
        dryRun: true,
        id: request.id,
        revision: current.revision,
        warning: 'Project copies remain installed.',
      });
    },
    withValidatedLibrary: async (
      options: LifecycleValidationOptions,
      operation: (value: ValidatedLibrarySnapshot) => Promise<unknown>,
    ): Promise<unknown> => {
      calls.validated.push(options);
      return await operation(current);
    },
  };
  return { calls, lifecycle: value as unknown as LibraryLifecycleService };
}

function handlerFixture(
  root: string,
  currentSnapshot: ValidatedLibrarySnapshot,
  currentCache: LibraryCacheRevision,
): {
  readonly cacheCalls: CacheCalls;
  readonly handler: ReturnType<typeof createWorkflowCommandHandler>;
  readonly lifecycleCalls: LifecycleCalls;
  readonly paths: ApplicationPaths;
} {
  const paths = resolveApplicationPaths({
    cwd: root,
    env: { SKILL_SYNC_CONFIG_HOME: join(root, 'config') },
  });
  const cache = cacheStub(currentCache);
  const lifecycle = lifecycleStub(currentSnapshot);
  const config = { list: () => Promise.resolve(listing()) } as unknown as ConfigService;
  const git = {
    run: (): Promise<never> => Promise.reject(new Error('Unexpected Git checkout.')),
  } as unknown as GitClient;
  return {
    cacheCalls: cache.calls,
    handler: createWorkflowCommandHandler({
      cache: cache.cache,
      config,
      environment: { CI: '1' },
      git,
      io: memoryIo(),
      lifecycle: lifecycle.lifecycle,
      paths,
      reconciliationStagingRoot: join(root, 'reconciliation-staging'),
    }),
    lifecycleCalls: lifecycle.calls,
    paths,
  };
}

function invocation(
  command: string,
  arguments_: readonly unknown[] = [],
  options: Readonly<Record<string, unknown>> = {},
) {
  return { command, arguments: arguments_, options };
}

describe('workflow command handler', () => {
  it('uses only a verified cache snapshot for install dry-run and resolves aliases atomically', async () => {
    await withTempDirectory('skill-sync-workflow-install-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      const currentSnapshot = await snapshot(library, secondRevision, {
        freshness: 'cache-only',
        stale: true,
      });
      const fixture = handlerFixture(
        root,
        currentSnapshot,
        cacheRevision(library, secondRevision, 'cache-only'),
      );

      const result = await fixture.handler(
        invocation('install', [['hello', 'examples/hello']], {
          dryRun: true,
          gitignore: false,
          json: true,
          noInput: true,
          project,
          target: ['codex'],
        }),
      );

      expect(result).toMatchObject({
        ok: true,
        data: {
          applied: false,
          dryRun: true,
          freshness: 'cache-only',
          stale: true,
          skills: [{ id: 'examples/hello' }],
        },
      });
      expect(fixture.lifecycleCalls.validated).toEqual([
        { branch: 'main', cacheOnly: true, remoteUrl },
      ]);
      expect(fixture.cacheCalls.inspect).toEqual([]);
      expect(fixture.cacheCalls.refresh).toEqual([]);
      expect(await readdir(project)).toEqual([]);
    });
  });

  it.each([
    ['install', { noInput: true }],
    ['install', { json: true }],
    ['update', { noInput: true }],
    ['update', {}],
  ] as const)(
    '%s refuses omitted automated selection before cache or lifecycle access',
    async (command, mode) => {
      await withTempDirectory('skill-sync-workflow-selection-', async (root) => {
        const library = await createLibrary(root);
        const fixture = handlerFixture(
          root,
          await snapshot(library, secondRevision),
          cacheRevision(library, secondRevision),
        );
        const result = await fixture.handler(invocation(command, [], mode));

        expect(result).toMatchObject({
          errors: [{ code: 'MISSING_INPUT' }],
          exitCode: EXIT_CODES.usage,
          ok: false,
        });
        expect(fixture.lifecycleCalls.validated).toEqual([]);
        expect(fixture.cacheCalls.inspect).toEqual([]);
        expect(fixture.cacheCalls.refresh).toEqual([]);
      });
    },
  );

  it('routes status --offline through latest write-free cache inspection', async () => {
    await withTempDirectory('skill-sync-workflow-status-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      await installFixture(root, project, library);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision, { freshness: 'cache-only', stale: true }),
        cacheRevision(library, secondRevision, 'cache-only'),
      );

      const result = await fixture.handler(
        invocation('status', [], { json: true, offline: true, project }),
      );

      expect(result).toMatchObject({
        data: {
          authoritative: false,
          freshness: 'cache-only',
          libraryRevision: secondRevision,
          stale: true,
        },
        ok: true,
      });
      expect(fixture.cacheCalls.inspect).toHaveLength(1);
      expect(fixture.cacheCalls.refresh).toEqual([]);
    });
  });

  it.each(['install', 'update'] as const)(
    '%s rejects --all with selectors before cache or lifecycle access',
    async (command) => {
      await withTempDirectory('skill-sync-workflow-conflicting-selection-', async (root) => {
        const library = await createLibrary(root);
        const fixture = handlerFixture(
          root,
          await snapshot(library, secondRevision),
          cacheRevision(library, secondRevision),
        );
        const result = await fixture.handler(
          invocation(command, [['examples/hello']], { all: true, noInput: true }),
        );

        expect(result).toMatchObject({
          errors: [{ code: 'CONFLICTING_SELECTION' }],
          exitCode: EXIT_CODES.usage,
          ok: false,
        });
        expect(fixture.lifecycleCalls.validated).toEqual([]);
        expect(fixture.cacheCalls.refresh).toEqual([]);
      });
    },
  );

  it('rejects an unknown explicit update selector before resolving the library revision', async () => {
    await withTempDirectory('skill-sync-workflow-unknown-update-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      await installFixture(root, project, library);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(
        invocation('update', [['missing-skill']], { noInput: true, project }),
      );
      expect(result).toMatchObject({
        errors: [{ code: 'INVALID_SKILL_SELECTION' }],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });
      expect(fixture.cacheCalls.refresh).toEqual([]);
    });
  });

  it('maps sync --check drift to its stable command failure and performs no project write', async () => {
    await withTempDirectory('skill-sync-workflow-check-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      await installFixture(root, project, library);
      const lockBefore = await readFile(join(project, 'skill-sync.lock.json'));
      const installedBefore = await readFile(
        join(project, '.codex', 'skills', 'hello', 'SKILL.md'),
      );
      await writeFile(
        join(library, 'skills', 'examples', 'hello', 'SKILL.md'),
        '---\nname: hello\ndescription: Example skill\n---\n\n# Hello two\n',
      );
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(
        invocation('sync', [], { check: true, json: true, noInput: true, project }),
      );

      expect(result).toMatchObject({
        errors: [
          {
            code: 'RECONCILIATION_CHECK_FAILED',
            details: { report: { check: true, exitCode: EXIT_CODES.conflict } },
          },
        ],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });
      expect(fixture.cacheCalls.refresh).toEqual([
        expect.objectContaining({ access: 'mutation', branch: 'main' }),
      ]);
      expect(await readFile(join(project, 'skill-sync.lock.json'))).toEqual(lockBefore);
      expect(await readFile(join(project, '.codex', 'skills', 'hello', 'SKILL.md'))).toEqual(
        installedBefore,
      );
    });
  });

  it('requires --yes for automated discard and uninstall while --yes alone never overwrites', async () => {
    await withTempDirectory('skill-sync-workflow-confirmation-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      await installFixture(root, project, library);
      const installed = join(project, '.codex', 'skills', 'hello', 'SKILL.md');
      await writeFile(installed, 'precious local work\n');
      await writeFile(
        join(library, 'skills', 'examples', 'hello', 'SKILL.md'),
        '---\nname: hello\ndescription: Example skill\n---\n\n# Hello two\n',
      );
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const yesOnly = await fixture.handler(
        invocation('sync', [], { noInput: true, project, yes: true }),
      );
      expect(yesOnly).toMatchObject({ exitCode: EXIT_CODES.conflict, ok: false });
      expect(await readFile(installed, 'utf8')).toBe('precious local work\n');
      const refreshesBeforeMissingConfirmation = fixture.cacheCalls.refresh.length;

      const update = await fixture.handler(
        invocation('update', [['examples/hello']], {
          discardLocal: true,
          noInput: true,
          project,
        }),
      );
      expect(update).toMatchObject({
        errors: [{ code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });
      expect(fixture.cacheCalls.refresh).toHaveLength(refreshesBeforeMissingConfirmation);
      expect(await readFile(installed, 'utf8')).toBe('precious local work\n');

      const uninstall = await fixture.handler(
        invocation('uninstall', [['examples/hello']], {
          discardLocal: true,
          noInput: true,
          project,
        }),
      );
      expect(uninstall).toMatchObject({
        errors: [{ code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });
      expect(await readFile(installed, 'utf8')).toBe('precious local work\n');
      await expect(stat(fixture.paths.backupsDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it.each([
    ['unsupported URL', 'not-a-url', 'UNSUPPORTED_REMOTE_URL'],
    [
      'credential-bearing URL',
      'https://oauth:super-secret-token@github.com/acme/skills.git',
      'REMOTE_CREDENTIALS_FORBIDDEN',
    ],
  ] as const)('maps %s to a stable validation failure', async (_description, url, code) => {
    await withTempDirectory('skill-sync-workflow-init-url-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(invocation('init', [url], { noInput: true }));

      expect(result).toMatchObject({
        errors: [{ code }],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain('super-secret-token');
      expect(fixture.lifecycleCalls.init).toBe(1);
    });
  });

  it.each([
    ['unsupported project schema', '{"schemaVersion":999}\n', 'PROJECT_STATE_VERSION_UNSUPPORTED'],
    ['malformed project JSON', '{not-json', 'MALFORMED_JSON'],
  ] as const)('maps %s to a stable validation failure', async (_description, contents, code) => {
    await withTempDirectory('skill-sync-workflow-project-state-error-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      await writeFile(join(project, 'skill-sync.json'), contents);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(
        invocation('uninstall', [['examples/hello']], { noInput: true, project }),
      );

      expect(result).toMatchObject({
        errors: [{ code }],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });
      expect(fixture.cacheCalls.inspect).toEqual([]);
      expect(fixture.cacheCalls.refresh).toEqual([]);
    });
  });

  it('maps a held advisory lock to the stable conflict result', async () => {
    await withTempDirectory('skill-sync-workflow-lock-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(invocation('group:create', ['engineering']));

      expect(result).toMatchObject({
        errors: [
          {
            code: 'ADVISORY_LOCK_UNAVAILABLE',
            details: { lockPath: '/runtime/library.lock' },
          },
        ],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });
    });
  });

  it('rejects create-only init flags instead of silently ignoring them', async () => {
    await withTempDirectory('skill-sync-workflow-init-flags-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      for (const options of [{ transport: 'ssh' }, { visibility: 'private' }]) {
        const result = await fixture.handler(invocation('init', [remoteUrl], options));
        expect(result).toMatchObject({
          errors: [{ code: 'INIT_OPTION_REQUIRES_CREATE' }],
          exitCode: EXIT_CODES.usage,
          ok: false,
        });
      }
      expect(fixture.lifecycleCalls.create).toBe(0);
      expect(fixture.lifecycleCalls.init).toBe(0);
    });
  });

  it('supports group remove dry-run without confirmation and refuses automated real removals', async () => {
    await withTempDirectory('skill-sync-workflow-group-remove-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const preview = await fixture.handler(
        invocation('group:remove', ['examples'], {
          dryRun: true,
          noInput: true,
          recursive: true,
        }),
      );
      expect(preview).toMatchObject({ ok: true, data: { dryRun: true } });

      const refused = await fixture.handler(
        invocation('group:remove', ['examples'], { noInput: true, recursive: true }),
      );
      expect(refused).toMatchObject({
        errors: [{ code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });
      expect(fixture.lifecycleCalls.groupRemove).toHaveLength(1);
      expect(fixture.lifecycleCalls.groupRemove.every((request) => request.dryRun === true)).toBe(
        true,
      );
    });
  });

  it('refuses automated library removal without --yes before lifecycle access', async () => {
    await withTempDirectory('skill-sync-workflow-library-remove-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );
      const result = await fixture.handler(
        invocation('library:remove', ['examples/hello'], { noInput: true }),
      );
      expect(result).toMatchObject({
        errors: [{ code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });
      expect(fixture.lifecycleCalls.libraryRemove).toEqual([]);
    });
  });
});

function report(
  exitCode: ProjectReconciliationReport['exitCode'],
  check = false,
): ProjectReconciliationReport {
  return {
    applied: false,
    authoritative: true,
    branch: 'main',
    check,
    dryRun: check,
    exitCode,
    freshness: 'fetched',
    libraryIdentity: identity,
    libraryRevision: secondRevision,
    operation: 'sync',
    projectRoot: '/project',
    selectedIds: [],
    skills: [],
    stale: false,
    wouldChange: false,
  };
}

describe('reconciliation command result mapping', () => {
  it.each([
    [EXIT_CODES.partial, false, 'PARTIAL_RECONCILIATION'],
    [EXIT_CODES.conflict, false, 'RECONCILIATION_CONFLICT'],
    [EXIT_CODES.conflict, true, 'RECONCILIATION_CHECK_FAILED'],
    [EXIT_CODES.repository, true, 'RECONCILIATION_CHECK_FAILED'],
    [EXIT_CODES.internal, false, 'RECONCILIATION_FAILED'],
  ] as const)('maps exit %s (check=%s) to %s', (exitCode, check, code) => {
    expect(reconciliationResult(report(exitCode, check), true)).toMatchObject({
      errors: [{ code, details: { report: { exitCode } } }],
      exitCode,
      ok: false,
    });
  });
});
