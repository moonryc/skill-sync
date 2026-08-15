import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type ConfigurationListing,
  type ConfigService,
} from '../../src/application/config-service.js';
import {
  LibraryLifecycleError,
  type LibraryInitializationExecutionOptions,
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
import type { RuntimeRecoveryParticipant } from '../../src/runtime/boundary.js';
import { OperationGuard } from '../../src/runtime/operation-guard.js';
import { TargetRegistry } from '../../src/targets/index.js';
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
  readonly initApplications: {
    readonly expectedPlanFingerprint: string;
    readonly options: LibraryInitializationExecutionOptions;
    readonly request: Readonly<Record<string, unknown>>;
  }[];
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

function memoryIo(interactive = false, stdout?: string[]): RuntimeIo {
  return {
    stdinIsTty: interactive,
    stdoutIsTty: interactive,
    writeStdout: (value) => stdout?.push(value),
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

function unconfiguredListing(): ConfigurationListing {
  const configured = listing();
  const { branch, defaultTargets, gitignore, transport } = configured.effective.value;
  const value = {
    ...(branch === undefined ? {} : { branch }),
    defaultTargets,
    gitignore,
    transport,
  };
  return {
    ...configured,
    configured: { ...configured.configured, 'library.remote': undefined },
    effective: {
      ...configured.effective,
      value,
      sources: { ...configured.effective.sources, libraryUrl: 'default' },
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

async function createEmptyLibrary(root: string): Promise<string> {
  const library = join(root, 'empty-library');
  await mkdir(join(library, '.skill-sync'), { recursive: true });
  await mkdir(join(library, 'skills'));
  await writeFile(join(library, '.skill-sync', 'library.json'), '{"schemaVersion":1}\n');
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

function isolatedTargetRegistry(root: string): TargetRegistry {
  const codexRoot = join(root, 'home', '.codex');
  return new TargetRegistry([
    {
      name: 'codex',
      detect: () => Promise.resolve(true),
      relativeDestination: (skillLeafName) => join('.codex', 'skills', skillLeafName),
      globalRoot: () => codexRoot,
      globalDestination: (skillLeafName) => join(codexRoot, 'skills', skillLeafName),
    },
  ]);
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

function cacheStub(
  current: LibraryCacheRevision,
  inspectError?: Error,
): {
  readonly cache: LibraryCache;
  readonly calls: CacheCalls;
} {
  const calls: CacheCalls = { inspect: [], refresh: [] };
  const value = {
    inspect: (request: LibraryCacheInspectRequest): Promise<LibraryCacheRevision> => {
      calls.inspect.push(request);
      if (inspectError !== undefined) return Promise.reject(inspectError);
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

function lifecycleStub(
  current: ValidatedLibrarySnapshot,
  initError?: Error,
): {
  readonly calls: LifecycleCalls;
  readonly lifecycle: LibraryLifecycleService;
} {
  const calls: LifecycleCalls = {
    create: 0,
    groupRemove: [],
    init: 0,
    initApplications: [],
    libraryRemove: [],
    validated: [],
  };
  const value = {
    planInitialization: (request: Readonly<Record<string, unknown>>) => {
      const create = request.kind === 'create';
      if (create) calls.create += 1;
      else calls.init += 1;
      if (initError !== undefined) return Promise.reject(initError);
      const repository =
        typeof request.repository === 'string' ? request.repository : 'acme/skills';
      const remote = normalizeGitRemote(
        create
          ? `https://github.com/${repository}.git`
          : typeof request.url === 'string'
            ? request.url
            : '',
      );
      return Promise.resolve({
        action: create ? 'create' : 'connect',
        applied: false,
        branch: 'main',
        configuration: {
          beforeFingerprint: `config-v1-${'b'.repeat(64)}`,
          changed: true,
          nextIdentity: remote.identity,
          previousIdentity: null,
        },
        dryRun: true,
        effects: {
          cache: 'refresh',
          configuration: 'write',
          githubRepository: create ? 'create' : 'none',
          remoteLibrary: create ? 'initialize' : 'none',
        },
        fingerprint: `init-v1-${'a'.repeat(64)}`,
        operation: 'init',
        remote,
        remoteState: create ? 'available' : 'compatible',
        repository: create ? repository : null,
        revision: create ? null : current.revision,
        validation: create ? null : { groups: 1, skills: 1 },
        visibility: create ? 'private' : null,
      });
    },
    applyInitialization: (
      request: Readonly<Record<string, unknown>>,
      expectedPlanFingerprint: string,
      options: LibraryInitializationExecutionOptions = {},
    ) => {
      calls.initApplications.push({ expectedPlanFingerprint, options, request });
      if (initError !== undefined) return Promise.reject(initError);
      const create = request.kind === 'create';
      const repository =
        typeof request.repository === 'string' ? request.repository : 'acme/skills';
      const remote = normalizeGitRemote(
        create
          ? `https://github.com/${repository}.git`
          : typeof request.url === 'string'
            ? request.url
            : '',
      );
      return Promise.resolve({
        branch: 'main',
        changed: true,
        initialized: create,
        remote,
        revision: current.revision,
      });
    },
    add: (request: Readonly<Record<string, unknown>>) =>
      Promise.resolve({
        changed: true,
        digest: 'a'.repeat(64),
        dryRun: request.dryRun === true,
        id: 'examples/hello',
        revision: current.revision,
      }),
    create: (request: Readonly<Record<string, unknown>>) => {
      calls.create += 1;
      const repository =
        typeof request.repository === 'string' ? request.repository : 'acme/skills';
      return Promise.resolve({
        branch: 'main',
        changed: true,
        initialized: true,
        remote: normalizeGitRemote(`https://github.com/${repository}.git`),
        revision: current.revision,
      });
    },
    groupList: () =>
      Promise.resolve([
        { description: 'Product engineering', path: 'engineering' },
        { description: null, path: 'design' },
      ]),
    groupRemove: (request: Readonly<Record<string, unknown>>) => {
      calls.groupRemove.push(request);
      if (request.dryRun !== true) return Promise.reject(new Error('Unexpected group mutation.'));
      return Promise.resolve({
        affectedIds: ['examples/hello'],
        changed: true,
        dryRun: true,
        revision: current.revision,
        warning: 'Existing copies will remain installed.',
      });
    },
    groupCreate: (request: Readonly<Record<string, unknown>>) =>
      request.group === 'engineering'
        ? Promise.reject(new AdvisoryLockUnavailableError('/runtime/library.lock'))
        : Promise.resolve({
            affectedIds: [],
            changed: true,
            dryRun: false,
            revision: current.revision,
          }),
    groupRename: () =>
      Promise.resolve({
        affectedIds: ['design/hello'],
        changed: true,
        dryRun: false,
        revision: current.revision,
        warning: 'Managed projects may report previous IDs as orphaned.',
      }),
    init: (request: Readonly<Record<string, unknown>>) => {
      calls.init += 1;
      if (initError !== undefined) return Promise.reject(initError);
      if (typeof request.url !== 'string') {
        return Promise.reject(new Error('Expected an init URL.'));
      }
      return Promise.resolve({
        branch: 'main',
        changed: true,
        initialized: request.initializeEmpty === true,
        remote: normalizeGitRemote(request.url),
        revision: current.revision,
      });
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
    publish: (request: Readonly<Record<string, unknown>>) =>
      Promise.resolve({
        changed: true,
        dryRun: request.dryRun === true,
        projectStateUpdated: request.dryRun !== true,
        revision: current.revision,
        skills: [
          {
            changed: true,
            diff: { added: ['new.md'], modified: ['SKILL.md'], removed: [] },
            digest: 'b'.repeat(64),
            id: 'examples/hello',
            previousDigest: 'a'.repeat(64),
          },
        ],
      }),
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
  configuration: ConfigurationListing = listing(),
  terminal: {
    readonly cacheInspectError?: Error;
    readonly lifecycleInitError?: Error;
    readonly interactive?: boolean;
    readonly stdout?: string[];
    readonly targets?: TargetRegistry;
  } = {},
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
  const cache = cacheStub(currentCache, terminal.cacheInspectError);
  const lifecycle = lifecycleStub(currentSnapshot, terminal.lifecycleInitError);
  const config = { list: () => Promise.resolve(configuration) } as unknown as ConfigService;
  const git = {
    run: (): Promise<never> => Promise.reject(new Error('Unexpected Git checkout.')),
  } as unknown as GitClient;
  return {
    cacheCalls: cache.calls,
    handler: createWorkflowCommandHandler({
      cache: cache.cache,
      config,
      environment: terminal.interactive === true ? {} : { CI: '1' },
      git,
      io: memoryIo(terminal.interactive === true, terminal.stdout),
      lifecycle: lifecycle.lifecycle,
      paths,
      reconciliationStagingRoot: join(root, 'reconciliation-staging'),
      ...(terminal.targets === undefined ? {} : { targets: terminal.targets }),
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
  it('adopts only an explicit exact catalog ID and leaves the target bytes in place', async () => {
    await withTempDirectory('skill-sync-workflow-adopt-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      const destination = join(project, '.codex', 'skills', 'hello');
      await mkdir(project);
      await cp(join(library, 'skills', 'examples', 'hello'), destination, { recursive: true });
      const before = await readFile(join(destination, 'SKILL.md'));
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const preview = await fixture.handler(
        invocation('adopt', ['examples/hello'], {
          dryRun: true,
          project,
          target: 'codex',
        }),
      );
      expect(preview.ok && preview.data).toContain('Adoption preview');
      expect(preview.ok && preview.data).toContain('Existing copy: codex: .codex/skills/hello');
      expect(preview.ok && preview.data).toContain('Target files: unchanged');
      expect(await readFile(join(destination, 'SKILL.md'))).toEqual(before);

      const adopted = await fixture.handler(
        invocation('adopt', ['examples/hello'], {
          json: true,
          noInput: true,
          project,
          target: 'codex',
          yes: true,
        }),
      );

      expect(adopted).toMatchObject({
        data: {
          applied: true,
          operation: 'adopt',
          skill: { id: 'examples/hello', target: 'codex' },
        },
        ok: true,
      });
      expect(await readFile(join(destination, 'SKILL.md'))).toEqual(before);
      expect(await readFile(join(project, 'skill-sync.json'), 'utf8')).toContain('examples/hello');

      const unknown = await fixture.handler(
        invocation('adopt', ['hello'], { json: true, noInput: true, project, target: 'codex' }),
      );
      expect(unknown).toMatchObject({
        errors: [{ code: 'UNKNOWN_SKILL_ID' }],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });
    });
  });

  it('keeps a completed global adoption and its structured preview in global scope', async () => {
    await withTempDirectory('skill-sync-workflow-global-adopt-output-', async (root) => {
      const library = await createLibrary(root);
      const destination = join(root, 'home', '.codex', 'skills', 'hello');
      await cp(join(library, 'skills', 'examples', 'hello'), destination, { recursive: true });
      const before = await readFile(join(destination, 'SKILL.md'));
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        listing(),
        { targets: isolatedTargetRegistry(root) },
      );

      const preview = await fixture.handler(
        invocation('adopt', ['examples/hello'], {
          dryRun: true,
          global: true,
          json: true,
          noInput: true,
          target: 'codex',
        }),
      );
      expect(preview).toMatchObject({
        data: {
          applied: false,
          dryRun: true,
          operation: 'adopt',
          scope: 'global',
          skill: { id: 'examples/hello', target: 'codex' },
        },
        ok: true,
      });

      const adopted = await fixture.handler(
        invocation('adopt', ['examples/hello'], {
          global: true,
          noInput: true,
          target: 'codex',
        }),
      );
      expect(adopted.ok && adopted.data).toContain(
        'Adoption complete; the existing copy is now tracked.',
      );
      expect(adopted.ok && adopted.data).toContain('Scope: global');
      expect(adopted.ok && adopted.data).toContain('Tracking writes completed:');
      expect(adopted.ok && adopted.data).toContain(
        'Next: Run skill-sync --global status to verify the managed copy.',
      );
      expect(adopted.ok && adopted.data).not.toContain(
        'Next: Run skill-sync status to verify the managed copy.',
      );
      expect(await readFile(join(destination, 'SKILL.md'))).toEqual(before);
    });
  });

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
      const human = await fixture.handler(
        invocation('install', [['examples/hello']], {
          dryRun: true,
          gitignore: false,
          noInput: true,
          project,
          target: ['codex'],
        }),
      );
      expect(human.ok && human.data).toContain('Library source:');
      expect(human.ok && human.data).toContain('(cache-only, stale)');
      expect(human.ok && human.data).toContain(
        'Warning: this preview uses cached library data. Apply refreshes it',
      );
      expect(human.ok && human.data).toContain('Plan fingerprint: install-v1-');
      expect(human.ok && human.data).toContain('Gitignore: unchanged');
      expect(human.ok && human.data).toContain('Planned writes:');
      if (!result.ok) throw new Error('Expected an install preview.');
      const fingerprint = (result.data as { readonly fingerprint: string }).fingerprint;
      expect(fingerprint).toMatch(/^install-v1-[a-f0-9]{64}$/u);
      expect(human.ok && human.data).toContain(
        `Next: skill-sync --project <project-path> install examples/hello --target codex --no-gitignore --expect-plan ${fingerprint}`,
      );
      expect(fixture.lifecycleCalls.validated).toEqual([
        { branch: 'main', cacheOnly: true, remoteUrl },
        { branch: 'main', cacheOnly: true, remoteUrl },
      ]);
      expect(fixture.cacheCalls.inspect).toEqual([]);
      expect(fixture.cacheCalls.refresh).toEqual([]);

      const changedPlan = await fixture.handler(
        invocation('install', [['examples/hello']], {
          expectPlan: `install-v1-${'0'.repeat(64)}`,
          gitignore: false,
          noInput: true,
          project,
          target: ['codex'],
        }),
      );
      expect(changedPlan).toMatchObject({
        errors: [{ code: 'INSTALL_PLAN_CHANGED' }],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });

      expect(await readdir(project)).toEqual([]);
    });
  });

  it('reports an actionable missing target after an install selector is supplied', async () => {
    await withTempDirectory('skill-sync-workflow-install-target-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(
        invocation('install', [['examples/hello']], {
          dryRun: true,
          gitignore: false,
          noInput: true,
          project,
        }),
      );

      expect(result).toMatchObject({
        errors: [{ code: 'MISSING_TARGET_SELECTION' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });
      if (result.ok) throw new Error('Expected missing-target failure.');
      expect(result.errors[0]?.message).toMatch(/--target codex.*--target claude/u);
    });
  });

  it('shows an install preview instead of mutating when confirmation is unavailable', async () => {
    await withTempDirectory('skill-sync-workflow-install-preview-default-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision, {
          freshness: 'cache-only',
          stale: true,
        }),
        cacheRevision(library, secondRevision, 'cache-only'),
      );

      const result = await fixture.handler(
        invocation('install', [['examples/hello']], {
          gitignore: false,
          noInput: true,
          project,
          target: ['codex'],
        }),
      );

      expect(result.ok && result.data).toContain('Install preview');
      expect(result.ok && result.data).toContain('no changes made');
      expect(result.ok && result.data).toContain('--expect-plan install-v1-');
      expect(result.ok && result.data).toContain(
        'Next: skill-sync --project <project-path> install examples/hello --target codex --no-gitignore --expect-plan install-v1-',
      );
      expect(fixture.lifecycleCalls.validated).toEqual([
        { branch: 'main', cacheOnly: true, remoteUrl },
      ]);
      expect(fixture.cacheCalls.refresh).toEqual([]);
      expect(await readdir(project)).toEqual([]);
    });
  });

  it('guides library maintainers only when the underlying human catalog is empty', async () => {
    await withTempDirectory('skill-sync-workflow-empty-list-', async (root) => {
      const emptyLibrary = await createEmptyLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      const emptyFixture = handlerFixture(
        root,
        await snapshot(emptyLibrary, secondRevision),
        cacheRevision(emptyLibrary, secondRevision),
      );

      const human = await emptyFixture.handler(invocation('list', [], { project }));
      expect(human).toMatchObject({ ok: true, exitCode: EXIT_CODES.success });
      expect(human.ok && human.data).toContain('Scope: project');
      expect(human.ok && human.data).toContain(`Library: ${identity} @ ${secondRevision}`);
      expect(human.ok && human.data).toContain('Matches: 0');
      expect(human.ok && human.data).toContain('No skills found.');
      expect(human.ok && human.data).toContain(
        'Next: Add the first skill with skill-sync add <path> --group <group>.',
      );

      const json = await emptyFixture.handler(invocation('list', [], { json: true, project }));
      expect(json).toEqual({
        data: {
          branch: 'main',
          freshness: 'fetched',
          revision: secondRevision,
          scope: 'project',
          skills: [],
          stale: false,
        },
        exitCode: EXIT_CODES.success,
        ok: true,
      });

      const populatedLibrary = await createLibrary(root);
      const populatedFixture = handlerFixture(
        root,
        await snapshot(populatedLibrary, secondRevision),
        cacheRevision(populatedLibrary, secondRevision),
      );
      const filtered = await populatedFixture.handler(
        invocation('list', [], { project, query: ['definitely absent'] }),
      );
      expect(filtered).toMatchObject({ ok: true, exitCode: EXIT_CODES.success });
      expect(filtered.ok && filtered.data).toContain('Matches: 0');
      expect(filtered.ok && filtered.data).toContain(
        'Next: Adjust the filters or run skill-sync --project <project-path> list without filters.',
      );

      const listed = await populatedFixture.handler(invocation('list', [], { project }));
      expect(listed.ok && listed.data).toContain('Matches: 1');
      expect(listed.ok && listed.data).toContain(
        'Next: Inspect it with skill-sync --project <project-path> info examples/hello, then preview installation with skill-sync --project <project-path> install examples/hello --target codex --gitignore --dry-run.',
      );

      const info = await populatedFixture.handler(
        invocation('info', ['examples/hello'], { project }),
      );
      expect(info.ok && info.data).toContain('Scope: project');
      expect(info.ok && info.data).toContain(`Library: ${identity} @ ${secondRevision}`);
      expect(info.ok && info.data).toContain('Files (1):');
      expect(info.ok && info.data).toContain(
        'Next: Preview installation with skill-sync --project <project-path> install examples/hello --target codex --gitignore --dry-run.',
      );

      const globalList = await populatedFixture.handler(invocation('list', [], { global: true }));
      expect(globalList.ok && globalList.data).toContain('Scope: global');
      expect(globalList.ok && globalList.data).toContain(
        'Next: Inspect it with skill-sync --global info examples/hello, then preview installation with skill-sync --global install examples/hello --target codex --dry-run.',
      );
      const globalInfo = await populatedFixture.handler(
        invocation('info', ['examples/hello'], { global: true }),
      );
      expect(globalInfo.ok && globalInfo.data).toContain(
        'Next: Preview installation with skill-sync --global install examples/hello --target codex --dry-run.',
      );

      const explicitProjectValidation = await populatedFixture.handler(
        invocation('validate', ['examples/hello'], { project }),
      );
      expect(explicitProjectValidation.ok && explicitProjectValidation.data).toContain(
        'Next: Run skill-sync --project <project-path> info examples/hello',
      );
      const globalValidation = await populatedFixture.handler(
        invocation('validate', ['examples/hello'], { global: true }),
      );
      expect(globalValidation.ok && globalValidation.data).toContain(
        'Next: Run skill-sync --global info examples/hello',
      );

      const globalFiltered = await populatedFixture.handler(
        invocation('list', [], { global: true, query: ['definitely absent'] }),
      );
      expect(globalFiltered.ok && globalFiltered.data).toContain(
        'Next: Adjust the filters or run skill-sync --global list without filters.',
      );

      const staleFixture = handlerFixture(
        root,
        await snapshot(populatedLibrary, secondRevision, {
          freshness: 'stale-cache',
          stale: true,
        }),
        cacheRevision(populatedLibrary, secondRevision, 'stale-cache'),
      );
      const staleList = await staleFixture.handler(invocation('list', [], { project }));
      expect(staleList.ok && staleList.data).toContain(
        'Next: Re-run skill-sync --project <project-path> list when remote access is available before choosing changes.',
      );
      expect(staleList.ok && staleList.data).not.toContain(
        'preview installation with skill-sync install examples/hello',
      );
      const staleInfo = await staleFixture.handler(
        invocation('info', ['examples/hello'], { project }),
      );
      expect(staleInfo.ok && staleInfo.data).toContain(
        'Next: Re-run skill-sync --project <project-path> info examples/hello when remote access is available',
      );
      expect(staleInfo.ok && staleInfo.data).not.toContain('without --offline');

      const staleGlobalList = await staleFixture.handler(invocation('list', [], { global: true }));
      expect(staleGlobalList.ok && staleGlobalList.data).toContain(
        'Next: Re-run skill-sync --global list when remote access is available before choosing changes.',
      );
    });
  });

  it('turns info selector failures into exact scope-aware read-only recovery', async () => {
    await withTempDirectory('skill-sync-workflow-info-recovery-', async (root) => {
      const library = await createLibrary(root);
      const secondHello = join(library, 'skills', 'backend', 'hello');
      await mkdir(secondHello, { recursive: true });
      await writeFile(join(library, 'skills', 'backend', '.skill-sync-group.json'), '{}\n');
      await writeFile(
        join(secondHello, 'SKILL.md'),
        '---\nname: hello\ndescription: Backend hello\n---\n\n# Backend hello\n',
      );
      const project = join(root, 'project');
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const typo = await fixture.handler(invocation('info', ['examples/hellp'], { project }));
      expect(typo).toMatchObject({ errors: [{ code: 'SKILL_INFO_FAILED' }], ok: false });
      if (typo.ok) throw new Error('Expected typo info to fail.');
      expect(typo.errors[0]?.message).toContain('Closest exact ID: examples/hello.');
      expect(typo.errors[0]?.message).toContain(
        'Next: Run skill-sync --project <project-path> info examples/hello.',
      );

      const globalTypo = await fixture.handler(
        invocation('info', ['examples/hellp'], { global: true }),
      );
      expect(globalTypo).toMatchObject({ errors: [{ code: 'SKILL_INFO_FAILED' }], ok: false });
      if (globalTypo.ok) throw new Error('Expected global typo info to fail.');
      expect(globalTypo.errors[0]?.message).toContain(
        'Next: Run skill-sync --global info examples/hello.',
      );

      const ambiguous = await fixture.handler(invocation('info', ['hello'], { project }));
      expect(ambiguous).toMatchObject({
        errors: [{ code: 'SKILL_INFO_FAILED' }],
        ok: false,
      });
      if (ambiguous.ok) throw new Error('Expected ambiguous info to fail.');
      expect(ambiguous.errors[0]?.message).toContain('Next: Retry with one exact skill ID:');
      expect(ambiguous.errors[0]?.message).toContain(
        '  skill-sync --project <project-path> info backend/hello',
      );
      expect(ambiguous.errors[0]?.message).toContain(
        '  skill-sync --project <project-path> info examples/hello',
      );

      const absent = await fixture.handler(invocation('info', ['unrelated-skill'], { project }));
      expect(absent).toMatchObject({ errors: [{ code: 'SKILL_INFO_FAILED' }], ok: false });
      if (absent.ok) throw new Error('Expected absent info to fail.');
      expect(absent.errors[0]?.message).toContain(
        'Next: Run skill-sync --project <project-path> list to copy an exact skill ID.',
      );

      const json = await fixture.handler(
        invocation('info', ['examples/hellp'], { json: true, project }),
      );
      expect(json).toMatchObject({
        errors: [
          {
            code: 'SKILL_INFO_FAILED',
            details: {
              report: {
                errors: [
                  {
                    code: 'unknown-selector',
                    candidates: ['examples/hello'],
                    value: 'examples/hellp',
                  },
                ],
              },
            },
          },
        ],
        ok: false,
      });
      if (json.ok) throw new Error('Expected JSON typo info to fail.');
      expect(json.errors[0]?.message).not.toContain('Next:');
    });
  });

  it('keeps typo candidates advisory and performs no fuzzy install', async () => {
    await withTempDirectory('skill-sync-workflow-install-typo-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(
        invocation('install', [['examples/hellp']], {
          gitignore: false,
          noInput: true,
          project,
          target: ['codex'],
          yes: true,
        }),
      );

      expect(result).toMatchObject({
        errors: [{ code: 'INVALID_SKILL_SELECTION' }],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });
      if (result.ok) throw new Error('Expected typo install to fail.');
      expect(result.errors[0]?.message).toContain('Closest exact ID: examples/hello.');
      expect(result.errors[0]?.message).not.toContain('skill-sync install');
      expect(await readdir(project)).toEqual([]);
    });
  });

  it('bounds human catalog output while keeping every JSON match', async () => {
    await withTempDirectory('skill-sync-workflow-bounded-list-', async (root) => {
      const library = await createLibrary(root);
      for (let index = 0; index < 24; index += 1) {
        const name = `skill-${String(index).padStart(2, '0')}`;
        const skillRoot = join(library, 'skills', 'examples', name);
        await mkdir(skillRoot, { recursive: true });
        await writeFile(
          join(skillRoot, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Generated fixture ${String(index)}\n---\n\n# Fixture\n`,
        );
      }
      const project = join(root, 'project');
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const human = await fixture.handler(invocation('list', [], { project }));
      expect(human.ok && human.data).toContain('Matches: 25 (showing first 20)');
      expect(human.ok && human.data).toContain('… 5 more matching skills omitted');
      expect(human.ok && human.data).not.toContain('examples/skill-23 —');

      const json = await fixture.handler(invocation('list', [], { json: true, project }));
      expect(json).toMatchObject({ ok: true });
      if (!json.ok) throw new Error('Expected catalog JSON.');
      expect((json.data as { readonly skills: readonly unknown[] }).skills).toHaveLength(25);
    });
  });

  it('uses the first supported compatible target when codex is unavailable', async () => {
    await withTempDirectory('skill-sync-workflow-claude-next-action-', async (root) => {
      const library = await createLibrary(root);
      await writeFile(
        join(library, 'skills', 'examples', 'hello', 'SKILL.md'),
        '---\nname: hello\ndescription: Example skill\nagents:\n  - claude\n---\n\n# Hello\n',
      );
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const listed = await fixture.handler(invocation('list', [], { project: root }));
      expect(listed.ok && listed.data).toContain(
        'skill-sync --project <project-path> install examples/hello --target claude --gitignore --dry-run',
      );
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

  it('guides offline status with no verified cache without mutating project state', async () => {
    await withTempDirectory('skill-sync-workflow-status-cache-miss-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      await installFixture(root, project, library);
      const manifestPath = join(project, 'skill-sync.json');
      const lockPath = join(project, 'skill-sync.lock.json');
      const installedPath = join(project, '.codex', 'skills', 'hello', 'SKILL.md');
      const manifestBefore = await readFile(manifestPath);
      const lockBefore = await readFile(lockPath);
      const installedBefore = await readFile(installedPath);
      const projectTreeBefore = (await readdir(project, { recursive: true })).sort();
      const cacheMiss =
        'No verified cached library revision is available for cache-only inspection.';
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        listing(),
        { cacheInspectError: new Error(cacheMiss) },
      );

      const result = await fixture.handler(invocation('status', [], { offline: true, project }));

      expect(result).toEqual({
        errors: [
          {
            code: 'LIBRARY_REVISION_UNAVAILABLE',
            message: `Unable to resolve the library revision: ${cacheMiss} Re-run this status command without --offline when remote access is available to populate a verified cache.`,
          },
        ],
        exitCode: EXIT_CODES.repository,
        ok: false,
      });
      expect(fixture.cacheCalls.inspect).toEqual([
        { branch: 'main', remote: normalizeGitRemote(remoteUrl) },
      ]);
      expect(fixture.cacheCalls.refresh).toEqual([]);
      expect(fixture.lifecycleCalls.validated).toEqual([]);
      expect(await readFile(manifestPath)).toEqual(manifestBefore);
      expect(await readFile(lockPath)).toEqual(lockBefore);
      expect(await readFile(installedPath)).toEqual(installedBefore);
      expect((await readdir(project, { recursive: true })).sort()).toEqual(projectTreeBefore);
      await expect(stat(join(root, 'reconciliation-staging'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('reports an empty project without library access and rejects an incomplete state pair', async () => {
    await withTempDirectory('skill-sync-workflow-empty-status-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const human = await fixture.handler(invocation('status', [], { project }));
      const resolvedProject = await realpath(project);
      expect(human).toEqual({
        data: [
          'Scope: project',
          `Project: ${resolvedProject}`,
          'No managed skills are tracked in this project.',
          'Next: Run skill-sync --project <project-path> list, using the Project path shown above to browse available skills, then follow its preview-ready install command.',
        ].join('\n'),
        exitCode: EXIT_CODES.success,
        ok: true,
      });

      const json = await fixture.handler(invocation('status', [], { json: true, project }));
      expect(json).toEqual({
        data: {
          managed: false,
          nextAction: 'skill-sync list',
          operation: 'status',
          projectRoot: resolvedProject,
          skills: [],
        },
        exitCode: EXIT_CODES.success,
        ok: true,
      });
      expect(fixture.lifecycleCalls.validated).toEqual([]);
      expect(fixture.cacheCalls.inspect).toEqual([]);
      expect(fixture.cacheCalls.refresh).toEqual([]);

      const unconfiguredProject = join(root, 'unconfigured-project');
      await mkdir(unconfiguredProject);
      const unconfigured = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        unconfiguredListing(),
      );
      const setup = await unconfigured.handler(
        invocation('status', [], { json: true, project: unconfiguredProject }),
      );
      expect(setup).toMatchObject({
        data: { managed: false, nextAction: 'skill-sync init <repository-url> --dry-run' },
        ok: true,
      });
      const setupHuman = await unconfigured.handler(
        invocation('status', [], { project: unconfiguredProject }),
      );
      expect(setupHuman.ok && setupHuman.data).toContain(
        'Next: Preview setup with skill-sync init <repository-url> --dry-run',
      );
      expect(setupHuman.ok && setupHuman.data).toContain(
        'then run skill-sync --project <project-path> list, using the Project path shown above.',
      );
      expect(unconfigured.lifecycleCalls.validated).toEqual([]);

      await installFixture(root, project, library);
      const lockPath = join(project, 'skill-sync.lock.json');
      const lockContents = await readFile(lockPath);
      await rm(lockPath);
      const manifestOnly = await fixture.handler(invocation('status', [], { json: true, project }));
      expect(manifestOnly).toMatchObject({
        errors: [{ code: 'INCOMPLETE_PROJECT_STATE' }],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });

      await rm(join(project, 'skill-sync.json'));
      await writeFile(lockPath, lockContents);
      const lockOnly = await fixture.handler(invocation('status', [], { json: true, project }));
      expect(lockOnly).toMatchObject({
        errors: [{ code: 'INCOMPLETE_PROJECT_STATE' }],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });
    });
  });

  it.each([
    ['online with a configured library', false, true],
    ['offline with a configured library', true, true],
    ['online without a configured library', false, false],
    ['offline without a configured library', true, false],
  ] as const)(
    'reports empty global status %s without cache, remote, or state writes',
    async (_description, offline, configured) => {
      await withTempDirectory('skill-sync-workflow-empty-global-status-', async (root) => {
        const library = await createLibrary(root);
        const fixture = handlerFixture(
          root,
          await snapshot(library, secondRevision),
          cacheRevision(library, secondRevision),
          configured ? listing() : unconfiguredListing(),
        );
        const stateDirectory = fixture.paths.globalStateDirectory;
        if (stateDirectory === undefined) throw new Error('Expected a global state directory.');
        const options = { global: true, ...(offline ? { offline: true } : {}) };

        const human = await fixture.handler(invocation('status', [], options));
        const json = await fixture.handler(invocation('status', [], { ...options, json: true }));
        const nextAction = configured
          ? 'skill-sync list --global'
          : 'skill-sync init <repository-url> --dry-run';

        expect(human).toEqual({
          data: [
            'Scope: global',
            `State: no global manifest or lock in ${stateDirectory}`,
            'No managed skills are tracked globally.',
            configured
              ? 'Next: Run skill-sync list --global to browse available skills, then follow its preview-ready global install command.'
              : 'Next: Preview setup with skill-sync init <repository-url> --dry-run (or skill-sync init --create <owner/name> --dry-run), run the exact --expect-plan command it prints, then run skill-sync list --global.',
          ].join('\n'),
          exitCode: EXIT_CODES.success,
          ok: true,
        });
        expect(json).toEqual({
          data: {
            managed: false,
            nextAction,
            operation: 'status',
            scope: 'global',
            skills: [],
            stateDirectory,
          },
          exitCode: EXIT_CODES.success,
          ok: true,
        });
        expect(fixture.lifecycleCalls.validated).toEqual([]);
        expect(fixture.cacheCalls.inspect).toEqual([]);
        expect(fixture.cacheCalls.refresh).toEqual([]);
        await expect(stat(stateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      });
    },
  );

  it('keeps configured-library validation for existing global state and names both setup routes', async () => {
    await withTempDirectory('skill-sync-workflow-global-library-required-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        unconfiguredListing(),
      );
      const stateDirectory = fixture.paths.globalStateDirectory;
      const manifestFile = fixture.paths.globalManifestFile;
      if (stateDirectory === undefined || manifestFile === undefined) {
        throw new Error('Expected global state paths.');
      }
      const expectedError = {
        code: 'LIBRARY_NOT_CONFIGURED',
        message:
          'No default skill library is configured. Preview setup with skill-sync init <repository-url> --dry-run or skill-sync init --create <owner/name> --dry-run, then run the exact --expect-plan command printed by the preview.',
      };

      const list = await fixture.handler(invocation('list', [], { global: true, json: true }));
      expect(list).toMatchObject({
        errors: [expectedError],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });

      await mkdir(stateDirectory, { recursive: true });
      await writeFile(manifestFile, '{}\n');
      const status = await fixture.handler(invocation('status', [], { global: true, json: true }));
      expect(status).toMatchObject({
        errors: [expectedError],
        exitCode: EXIT_CODES.validation,
        ok: false,
      });
      expect(fixture.lifecycleCalls.validated).toEqual([]);
      expect(fixture.cacheCalls.inspect).toEqual([]);
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

      const human = await fixture.handler(
        invocation('sync', [], { check: true, noInput: true, project }),
      );
      expect(human).toMatchObject({
        errors: [{ code: 'RECONCILIATION_CHECK_FAILED' }],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });
      if (human.ok) throw new Error('Expected reconciliation check drift.');
      expect(human.errors[0]?.message).toContain('Sync check: project');
      expect(human.errors[0]?.message).toContain('Result: changes detected; selected 1');
      expect(human.errors[0]?.message).toContain('Outcomes: planned 1');
      expect(human.errors[0]?.message).toContain('Next: Apply with skill-sync sync');

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
      expect(fixture.cacheCalls.refresh).toHaveLength(2);
      expect(fixture.cacheCalls.refresh).toEqual(
        expect.arrayContaining([expect.objectContaining({ access: 'mutation', branch: 'main' })]),
      );
      expect(await readFile(join(project, 'skill-sync.lock.json'))).toEqual(lockBefore);
      expect(await readFile(join(project, '.codex', 'skills', 'hello', 'SKILL.md'))).toEqual(
        installedBefore,
      );
    });
  });

  it('renders core workflow successes as concise human text while preserving JSON data', async () => {
    await withTempDirectory('skill-sync-workflow-human-results-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      await installFixture(root, project, library);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const initHuman = await fixture.handler(invocation('init', [remoteUrl], { yes: true }));
      expect(initHuman).toMatchObject({ ok: true });
      expect(initHuman.ok && initHuman.data).toContain('Connected to skill library');
      expect(initHuman.ok && initHuman.data).toContain('Next: Run skill-sync list');
      const initJson = await fixture.handler(
        invocation('init', [remoteUrl], { json: true, yes: true }),
      );
      expect(initJson).toMatchObject({ data: { revision: secondRevision }, ok: true });

      const installHuman = await fixture.handler(
        invocation('install', [['examples/hello']], {
          dryRun: true,
          gitignore: false,
          project,
          target: ['codex'],
        }),
      );
      expect(installHuman.ok && installHuman.data).toContain('Install preview');
      expect(installHuman.ok && installHuman.data).toContain('codex: .codex/skills/hello');
      expect(installHuman.ok && installHuman.data).toContain(
        `Library source: ${secondRevision} (fetched)`,
      );
      expect(installHuman.ok && installHuman.data).toContain('Gitignore: unchanged');
      expect(installHuman.ok && installHuman.data).toContain(
        'everything selected is already installed (no changes planned)',
      );
      expect(installHuman.ok && installHuman.data).toContain(
        'Next: Run skill-sync --project <project-path> status to verify managed copies.',
      );
      expect(installHuman.ok && installHuman.data).not.toContain('--expect-plan');

      const addHuman = await fixture.handler(
        invocation('add', [join(root, 'source')], { dryRun: true, group: 'examples' }),
      );
      expect(addHuman.ok && addHuman.data).toContain('Would add examples/hello');
      expect(addHuman.ok && addHuman.data).toContain('Canonical path: skills/examples/hello');
      const addJson = await fixture.handler(
        invocation('add', [join(root, 'source')], { dryRun: true, group: 'examples', json: true }),
      );
      expect(addJson).toMatchObject({ data: { dryRun: true, id: 'examples/hello' }, ok: true });

      const publishHuman = await fixture.handler(
        invocation('publish', [['examples/hello']], { dryRun: true, project }),
      );
      expect(publishHuman.ok && publishHuman.data).toContain('Publish preview');
      expect(publishHuman.ok && publishHuman.data).toContain(
        'examples/hello -> skills/examples/hello: would publish',
      );
      const publishJson = await fixture.handler(
        invocation('publish', [['examples/hello']], { dryRun: true, json: true, project }),
      );
      expect(publishJson).toMatchObject({
        data: { dryRun: true, skills: [{ id: 'examples/hello' }] },
        ok: true,
      });
      const published = await fixture.handler(
        invocation('publish', [['examples/hello']], { project }),
      );
      expect(published.ok && published.data).toContain('Publish complete.');
      expect(published.ok && published.data).toContain(
        'Next: Run skill-sync --project <project-path> status to verify the canonical revision.',
      );

      const uninstallHuman = await fixture.handler(
        invocation('uninstall', [['examples/hello']], { dryRun: true, project }),
      );
      expect(uninstallHuman.ok && uninstallHuman.data).toContain('Uninstall preview');
      expect(uninstallHuman.ok && uninstallHuman.data).toContain('Backup: not required');
      expect(uninstallHuman.ok && uninstallHuman.data).toContain('Gitignore: unchanged');
      expect(uninstallHuman.ok && uninstallHuman.data).toContain(
        'codex: .codex/skills/hello (remove)',
      );
      const uninstallJson = await fixture.handler(
        invocation('uninstall', [['examples/hello']], { dryRun: true, json: true, project }),
      );
      expect(uninstallJson).toMatchObject({
        data: { dryRun: true, operation: 'uninstall', skills: [{ id: 'examples/hello' }] },
        ok: true,
      });
    });
  });

  it('exposes the same reviewed init plan for human, JSON, and fingerprinted apply paths', async () => {
    await withTempDirectory('skill-sync-workflow-init-plan-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );
      const fingerprint = `init-v1-${'a'.repeat(64)}`;

      const human = await fixture.handler(
        invocation('init', [remoteUrl], { dryRun: true, noInput: true }),
      );
      expect(human.ok && human.data).toContain('Initialization preview');
      expect(human.ok && human.data).toContain('No changes were made.');
      expect(human.ok && human.data).toContain(`--expect-plan ${fingerprint}`);

      const json = await fixture.handler(
        invocation('init', [remoteUrl], { dryRun: true, json: true, noInput: true }),
      );
      expect(json).toMatchObject({
        data: { applied: false, dryRun: true, fingerprint, operation: 'init' },
        ok: true,
      });

      const createPreview = await fixture.handler(
        invocation('init', [], {
          create: 'acme/new-skills',
          dryRun: true,
          noInput: true,
          transport: 'ssh',
          visibility: 'internal',
        }),
      );
      expect(createPreview.ok && createPreview.data).toContain(
        'If a later setup step fails, the newly created repository may remain; inspect it with GitHub before retrying or deleting it.',
      );
      expect(createPreview.ok && createPreview.data).toContain(
        'skill-sync init --create acme/new-skills --visibility private --transport https --branch main --expect-plan',
      );

      const applied = await fixture.handler(
        invocation('init', [remoteUrl], {
          expectPlan: fingerprint,
          json: true,
          noInput: true,
        }),
      );
      expect(applied).toMatchObject({ data: { revision: secondRevision }, ok: true });
      expect(fixture.lifecycleCalls.init).toBe(2);
    });
  });

  it('shows a setup preview instead of mutating when confirmation is unavailable', async () => {
    await withTempDirectory('skill-sync-workflow-init-preview-default-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const human = await fixture.handler(invocation('init', [remoteUrl], { noInput: true }));
      const json = await fixture.handler(
        invocation('init', [remoteUrl], { json: true, noInput: true }),
      );

      expect(human.ok && human.data).toContain('Initialization preview');
      expect(human.ok && human.data).toContain('No changes were made.');
      expect(human.ok && human.data).toContain('--expect-plan');
      expect(json).toMatchObject({
        data: { applied: false, dryRun: true, operation: 'init' },
        ok: true,
      });
      expect(fixture.lifecycleCalls.initApplications).toEqual([]);
    });
  });

  it('turns a changed init plan into an exact option-preserving re-preview command', async () => {
    await withTempDirectory('skill-sync-workflow-init-plan-changed-', async (root) => {
      const library = await createLibrary(root);
      const currentPlan = {
        action: 'create',
        applied: false,
        branch: 'stable',
        configuration: {
          beforeFingerprint: `config-v1-${'b'.repeat(64)}`,
          changed: true,
          nextIdentity: 'github.com/acme/new-skills',
          previousIdentity: null,
        },
        dryRun: true,
        effects: {
          cache: 'refresh',
          configuration: 'write',
          githubRepository: 'create',
          remoteLibrary: 'initialize',
        },
        fingerprint: `init-v1-${'c'.repeat(64)}`,
        operation: 'init',
        remote: normalizeGitRemote('git@github.com:acme/new-skills.git'),
        remoteState: 'available',
        repository: 'acme/new-skills',
        revision: null,
        validation: null,
        visibility: 'internal',
      } as const;
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        listing(),
        {
          lifecycleInitError: new LibraryLifecycleError(
            'INIT_PLAN_CHANGED',
            'The initialization plan changed after review, so nothing was applied.',
            { currentPlan },
          ),
        },
      );
      const previewCommand =
        'skill-sync init --create acme/new-skills --visibility internal --transport ssh --branch stable --dry-run';

      const result = await fixture.handler(
        invocation('init', [], {
          create: 'acme/new-skills',
          expectPlan: `init-v1-${'a'.repeat(64)}`,
          json: true,
          noInput: true,
        }),
      );

      expect(result).toMatchObject({
        errors: [
          {
            code: 'INIT_PLAN_CHANGED',
            details: { currentPlan, previewCommand },
            message: `The initialization plan changed after review, so nothing was applied. Next: ${previewCommand}`,
          },
        ],
        exitCode: EXIT_CODES.conflict,
        ok: false,
      });
    });
  });

  it('forwards the runtime signal, commit guard, and recovery registration to init apply', async () => {
    await withTempDirectory('skill-sync-workflow-init-runtime-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );
      const controller = new AbortController();
      const operationGuard = new OperationGuard(controller.signal);
      const participants: RuntimeRecoveryParticipant[] = [];
      const registerRecovery = (participant: RuntimeRecoveryParticipant) => {
        participants.push(participant);
        return { complete: () => undefined };
      };
      const context = {
        operationGuard,
        registerRecovery,
        signal: controller.signal,
        throwIfCancelled: () => operationGuard.throwIfCancelled(),
      };

      await fixture.handler(
        invocation('init', [remoteUrl], {
          expectPlan: `init-v1-${'a'.repeat(64)}`,
          noInput: true,
        }),
        context,
      );
      await fixture.handler(invocation('init', [remoteUrl], { noInput: true, yes: true }), context);

      expect(fixture.lifecycleCalls.initApplications).toHaveLength(2);
      for (const application of fixture.lifecycleCalls.initApplications) {
        expect(application.options).toMatchObject({
          recovery: {
            journalDirectory: join(fixture.paths.journalsDirectory, 'library'),
            operationGuard,
            registerRecovery,
          },
          signal: controller.signal,
        });
        expect(application.options.recovery?.rootFingerprint).toMatch(/^[a-f0-9]{64}$/u);
      }
      expect(participants).toEqual([]);
    });
  });

  it('shows and binds an exact install plan before an interactive apply', async () => {
    await withTempDirectory('skill-sync-workflow-interactive-install-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      const stdout: string[] = [];
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        listing(),
        { interactive: true, stdout },
      );

      const result = await fixture.handler(
        invocation('install', [['examples/hello']], {
          gitignore: false,
          project,
          target: ['codex'],
          yes: true,
        }),
      );

      expect(stdout.join('')).toContain('Install preview (no changes made).');
      expect(stdout.join('')).toMatch(/Plan fingerprint: install-v1-[a-f0-9]{64}/u);
      expect(stdout.join('')).toContain(
        'Next: Confirm the prompt below to apply this exact reviewed plan; no second command is needed.',
      );
      expect(stdout.join('')).not.toContain('--expect-plan install-v1-');
      expect(result.ok && result.data).toContain('Install complete.');
      expect(result.ok && result.data).toContain('Writes completed:');
      expect(result.ok && result.data).toContain(
        'Next: Run skill-sync --project <project-path> status to verify managed copies.',
      );
      await expect(
        stat(join(project, '.codex', 'skills', 'hello', 'SKILL.md')),
      ).resolves.toBeDefined();
    });
  });

  it('does not ask to apply an interactive install when everything is already installed', async () => {
    await withTempDirectory('skill-sync-workflow-interactive-install-noop-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      const stdout: string[] = [];
      await mkdir(project);
      await installFixture(root, project, library);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        listing(),
        { interactive: true, stdout },
      );

      const result = await fixture.handler(
        invocation('install', [['examples/hello']], {
          gitignore: false,
          project,
          target: ['codex'],
          yes: true,
        }),
      );

      expect(result.ok && result.data).toContain(
        'everything selected is already installed (no changes planned)',
      );
      expect(result.ok && result.data).toContain(
        'Next: Run skill-sync --project <project-path> status to verify managed copies.',
      );
      expect(result.ok && result.data).not.toContain('Confirm the prompt below');
      expect(result.ok && result.data).not.toContain('Install made no changes.');
      expect(stdout).toEqual([]);
    });
  });

  it('keeps a completed global install result in global scope', async () => {
    await withTempDirectory('skill-sync-workflow-global-install-output-', async (root) => {
      const library = await createLibrary(root);
      const project = join(root, 'project');
      await mkdir(project);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
        listing(),
        { targets: isolatedTargetRegistry(root) },
      );

      const human = await fixture.handler(
        invocation('install', [['examples/hello']], {
          global: true,
          noInput: true,
          target: ['codex'],
          yes: true,
        }),
      );

      expect(human).toMatchObject({ ok: true });
      expect(human.ok && human.data).toContain('Install complete.');
      expect(human.ok && human.data).toContain('Scope: global');
      expect(human.ok && human.data).toContain('Writes completed:');
      expect(human.ok && human.data).toContain(
        'Next: Run skill-sync --global status to verify managed copies.',
      );
      expect(human.ok && human.data).not.toContain(
        'Next: Run skill-sync status to verify managed copies.',
      );

      const json = await fixture.handler(
        invocation('install', [['examples/hello']], {
          global: true,
          json: true,
          noInput: true,
          target: ['codex'],
          yes: true,
        }),
      );
      expect(json).toMatchObject({
        data: {
          applied: false,
          dryRun: false,
          scope: 'global',
          skills: [{ id: 'examples/hello', status: 'already-installed' }],
          writes: [],
        },
        ok: true,
      });

      const uninstallJson = await fixture.handler(
        invocation('uninstall', [['examples/hello']], {
          dryRun: true,
          global: true,
          json: true,
          noInput: true,
        }),
      );
      expect(uninstallJson).toMatchObject({
        data: {
          applied: false,
          dryRun: true,
          operation: 'uninstall',
          scope: 'global',
          skills: [{ id: 'examples/hello' }],
        },
        ok: true,
      });

      const uninstalled = await fixture.handler(
        invocation('uninstall', [['examples/hello']], {
          global: true,
          noInput: true,
        }),
      );
      expect(uninstalled.ok && uninstalled.data).toContain('Uninstall complete.');
      expect(uninstalled.ok && uninstalled.data).toContain('Writes completed:');
      expect(uninstalled.ok && uninstalled.data).toContain(
        'Next: Run skill-sync --global status to verify remaining managed skills.',
      );
      expect(uninstalled.ok && uninstalled.data).not.toContain(
        'Next: Run skill-sync status to verify remaining managed skills.',
      );

      const status = await fixture.handler(
        invocation('status', [], { global: true, noInput: true }),
      );
      expect(status.ok && status.data).toContain('Managed skills: 0');
      expect(status.ok && status.data).toContain(
        'Next: Run skill-sync list --global and follow its preview-ready global install command.',
      );
    });
  });

  it('recognizes a library-root validation path and preserves the structured JSON result', async () => {
    await withTempDirectory('skill-sync-workflow-validate-library-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const human = await fixture.handler(invocation('validate', [library]));
      expect(human).toEqual({
        data: [
          'Validation passed.',
          'Kind: library',
          'Skills checked: 1',
          'Issues: 0',
          'Details:',
          '  examples/hello — 1 file (library:examples/hello)',
          'Next: Run skill-sync list to browse the validated skills.',
        ].join('\n'),
        exitCode: EXIT_CODES.success,
        ok: true,
      });

      const json = await fixture.handler(invocation('validate', [library], { json: true }));
      expect(json).toMatchObject({
        data: { kind: 'library', valid: true, skills: [{ id: 'examples/hello' }] },
        exitCode: EXIT_CODES.success,
        ok: true,
      });
      expect(fixture.lifecycleCalls.validated).toEqual([]);
    });
  });

  it('uses the validation formatter for a malformed local path while preserving JSON details', async () => {
    await withTempDirectory('skill-sync-workflow-validate-invalid-', async (root) => {
      const library = await createLibrary(root);
      const malformed = join(root, 'malformed-skill');
      await mkdir(malformed);
      await writeFile(join(malformed, 'SKILL.md'), 'missing front matter\n');
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const human = await fixture.handler(invocation('validate', [malformed]));
      expect(human).toMatchObject({ errors: [{ code: 'VALIDATION_FAILED' }], ok: false });
      if (human.ok) throw new Error('Expected validation to fail.');
      expect(human.errors[0]?.message).toContain('Validation failed.');
      expect(human.errors[0]?.message).toContain('Kind: local skill path');
      expect(human.errors[0]?.message).toContain('Issues:');
      expect(human.errors[0]?.message).toContain(
        'Next: Fix the issues above, then rerun skill-sync validate <same-id-or-path>.',
      );

      const json = await fixture.handler(invocation('validate', [malformed], { json: true }));
      expect(json).toMatchObject({
        errors: [
          {
            code: 'VALIDATION_FAILED',
            details: { report: { kind: 'local-path', valid: false } },
          },
        ],
        ok: false,
      });
      if (json.ok) throw new Error('Expected JSON validation to fail.');
      expect(json.errors[0]?.message).not.toContain('Kind: local skill path');
    });
  });

  it('renders group and library lifecycle results as guidance while keeping JSON unchanged', async () => {
    await withTempDirectory('skill-sync-workflow-library-human-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const groupList = await fixture.handler(invocation('group:list'));
      expect(groupList.ok && groupList.data).toBe(
        [
          'Library groups (2):',
          '  design',
          '  engineering — Product engineering',
          'Read-only: no changes made.',
          'Next: Run skill-sync list --group <group> to browse a group.',
        ].join('\n'),
      );
      const groupListJson = await fixture.handler(invocation('group:list', [], { json: true }));
      expect(groupListJson).toMatchObject({
        data: [
          { description: 'Product engineering', path: 'engineering' },
          { description: null, path: 'design' },
        ],
        ok: true,
      });

      const created = await fixture.handler(invocation('group:create', ['design-systems']));
      expect(created.ok && created.data).toContain('Created library group design-systems.');
      expect(created.ok && created.data).toContain('Changed: yes');
      expect(created.ok && created.data).toContain('Dry run: no');
      expect(created.ok && created.data).toContain(`Revision: ${secondRevision}`);
      expect(created.ok && created.data).toContain('Affected skill IDs (0): none');
      expect(created.ok && created.data).toContain('Next: Add a skill with skill-sync add');
      const createdJson = await fixture.handler(
        invocation('group:create', ['design-systems'], { json: true }),
      );
      expect(createdJson).toMatchObject({
        data: { affectedIds: [], changed: true, dryRun: false, revision: secondRevision },
        ok: true,
      });

      const renamed = await fixture.handler(
        invocation('group:rename', ['design', 'product-design']),
      );
      expect(renamed.ok && renamed.data).toContain(
        'Renamed library group design to product-design.',
      );
      expect(renamed.ok && renamed.data).toContain('Affected skill IDs (1): design/hello');
      expect(renamed.ok && renamed.data).toContain('Warning: Managed projects may report');
      expect(renamed.ok && renamed.data).toContain('Next: Run skill-sync status');
      const renamedJson = await fixture.handler(
        invocation('group:rename', ['design', 'product-design'], { json: true }),
      );
      expect(renamedJson).toMatchObject({
        data: {
          affectedIds: ['design/hello'],
          changed: true,
          dryRun: false,
          revision: secondRevision,
        },
        ok: true,
      });

      const groupPreview = await fixture.handler(
        invocation('group:remove', ['examples'], {
          dryRun: true,
          noInput: true,
          recursive: true,
        }),
      );
      expect(groupPreview.ok && groupPreview.data).toContain('Group removal preview for examples');
      expect(groupPreview.ok && groupPreview.data).toContain('Changed: yes (preview only)');
      expect(groupPreview.ok && groupPreview.data).toContain('Dry run: yes');
      expect(groupPreview.ok && groupPreview.data).toContain(
        'Affected skill IDs (1): examples/hello',
      );
      expect(groupPreview.ok && groupPreview.data).toContain('Warning: Existing copies');
      expect(groupPreview.ok && groupPreview.data).toContain(
        'Next: Re-run skill-sync group remove examples --recursive --yes without --dry-run',
      );
      const groupPreviewJson = await fixture.handler(
        invocation('group:remove', ['examples'], {
          dryRun: true,
          json: true,
          noInput: true,
          recursive: true,
        }),
      );
      expect(groupPreviewJson).toMatchObject({ data: { dryRun: true }, ok: true });

      const libraryPreview = await fixture.handler(
        invocation('library:remove', ['examples/hello'], { dryRun: true, noInput: true }),
      );
      expect(libraryPreview.ok && libraryPreview.data).toContain(
        'Library skill removal preview for examples/hello',
      );
      expect(libraryPreview.ok && libraryPreview.data).toContain('Changed: yes (preview only)');
      expect(libraryPreview.ok && libraryPreview.data).toContain('Dry run: yes');
      expect(libraryPreview.ok && libraryPreview.data).toContain(`Revision: ${secondRevision}`);
      expect(libraryPreview.ok && libraryPreview.data).toContain('Affected installed copies: none');
      expect(libraryPreview.ok && libraryPreview.data).toContain(
        'Next: Re-run skill-sync library remove examples/hello --yes without --dry-run',
      );
      const libraryPreviewJson = await fixture.handler(
        invocation('library:remove', ['examples/hello'], {
          dryRun: true,
          json: true,
          noInput: true,
        }),
      );
      expect(libraryPreviewJson).toMatchObject({
        data: { dryRun: true, id: 'examples/hello' },
        ok: true,
      });
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

      const uninstallPreview = await fixture.handler(
        invocation('uninstall', [['examples/hello']], {
          discardLocal: true,
          dryRun: true,
          noInput: true,
          project,
        }),
      );
      expect(uninstallPreview.ok && uninstallPreview.data).toContain('Backup: required for');
      expect(uninstallPreview.ok && uninstallPreview.data).toContain('.codex/skills/hello');
      expect(uninstallPreview.ok && uninstallPreview.data).toContain(
        'without --dry-run and add --yes to apply this preview',
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
    ['human', false],
    ['JSON', true],
  ] as const)(
    'keeps actionable init remote guidance identical for %s output',
    async (_description, json) => {
      await withTempDirectory('skill-sync-workflow-init-remote-failure-', async (root) => {
        const library = await createLibrary(root);
        const treeBefore = (await readdir(root, { recursive: true })).sort();
        const message =
          'The library remote could not be accessed. Git reported: fatal: repository not found Verify the repository exists and your account has access. For HTTPS, configure a Git credential helper or authenticate with your Git provider (for GitHub, run gh auth login).';
        const fixture = handlerFixture(
          root,
          await snapshot(library, secondRevision),
          cacheRevision(library, secondRevision),
          listing(),
          {
            lifecycleInitError: new LibraryLifecycleError('REMOTE_ACCESS_FAILED', message),
          },
        );

        const result = await fixture.handler(
          invocation('init', [remoteUrl], { json, noInput: true }),
        );

        expect(result).toEqual({
          errors: [{ code: 'REMOTE_ACCESS_FAILED', details: {}, message }],
          exitCode: EXIT_CODES.repository,
          ok: false,
        });
        expect(fixture.lifecycleCalls.init).toBe(1);
        expect(fixture.cacheCalls.inspect).toEqual([]);
        expect(fixture.cacheCalls.refresh).toEqual([]);
        expect((await readdir(root, { recursive: true })).sort()).toEqual(treeBefore);
      });
    },
  );

  it('names both init inputs before command I/O when prompting is unavailable', async () => {
    await withTempDirectory('skill-sync-workflow-init-input-', async (root) => {
      const library = await createLibrary(root);
      const treeBefore = (await readdir(root, { recursive: true })).sort();
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      const result = await fixture.handler(invocation('init', [], { noInput: true }));

      expect(result).toEqual({
        errors: [
          {
            code: 'MISSING_INPUT',
            message:
              'a repository URL or --create <owner/name> must be supplied when prompting is disabled.',
          },
        ],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });
      expect(fixture.lifecycleCalls.init).toBe(0);
      expect(fixture.lifecycleCalls.create).toBe(0);
      expect(fixture.cacheCalls.inspect).toEqual([]);
      expect(fixture.cacheCalls.refresh).toEqual([]);
      expect((await readdir(root, { recursive: true })).sort()).toEqual(treeBefore);
    });
  });

  it.each([
    ['human', false],
    ['JSON', true],
  ] as const)(
    'keeps actionable incompatible-library guidance identical for %s output',
    async (_description, json) => {
      await withTempDirectory('skill-sync-workflow-init-incompatible-', async (root) => {
        const library = await createLibrary(root);
        const treeBefore = (await readdir(root, { recursive: true })).sort();
        const message =
          'The nonempty remote is not a compatible skill-sync library. Its contents and your saved library configuration were left unchanged. Next: preview a compatible or empty repository with skill-sync init <repository-url> --dry-run, or preview a new one with skill-sync init --create <owner/name> --dry-run.';
        const fixture = handlerFixture(
          root,
          await snapshot(library, secondRevision),
          cacheRevision(library, secondRevision),
          listing(),
          {
            lifecycleInitError: new LibraryLifecycleError('INCOMPATIBLE_LIBRARY', message),
          },
        );

        const result = await fixture.handler(
          invocation('init', [remoteUrl], { json, noInput: true }),
        );

        expect(result).toEqual({
          errors: [{ code: 'INCOMPATIBLE_LIBRARY', details: {}, message }],
          exitCode: EXIT_CODES.validation,
          ok: false,
        });
        expect(fixture.lifecycleCalls.init).toBe(1);
        expect(fixture.cacheCalls.inspect).toEqual([]);
        expect(fixture.cacheCalls.refresh).toEqual([]);
        expect((await readdir(root, { recursive: true })).sort()).toEqual(treeBefore);
      });
    },
  );

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
      if (result.ok) throw new Error('Expected the held advisory lock to fail.');
      expect(result.errors[0]?.message).toContain('run skill-sync recovery list before retrying');
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

  it('rejects project and global scope selectors for init before lifecycle access', async () => {
    await withTempDirectory('skill-sync-workflow-init-scope-', async (root) => {
      const library = await createLibrary(root);
      const fixture = handlerFixture(
        root,
        await snapshot(library, secondRevision),
        cacheRevision(library, secondRevision),
      );

      for (const options of [{ global: true }, { project: join(root, 'project') }]) {
        const result = await fixture.handler(invocation('init', [remoteUrl], options));
        expect(result).toMatchObject({
          errors: [{ code: 'SCOPE_OPTION_UNSUPPORTED' }],
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
      expect(preview.ok && preview.data).toContain('Group removal preview for examples');
      expect(preview.ok && preview.data).toContain('Dry run: yes');

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
