import { createElement } from 'react';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { DefaultTuiActionPort } from '../../src/ui/tui/runner.js';
import {
  TuiApp,
  TuiAddFolderForm,
  TuiAddLocationBrowser,
  TuiAddReview,
  TuiCatalogEmptyState,
  TuiFirstRunMenu,
  TuiGitignorePolicy,
  TuiInstallPreviewReview,
  TuiReleaseUpdateIndicator,
  TuiSetupDiagnostics,
  TuiSetupForm,
  TuiSetupGuide,
  TuiSetupReview,
  TUI_SETUP_GUIDE_URL,
  TuiWindowIndicator,
} from '../../src/ui/tui/app.js';
import {
  tuiAddLocationItems,
  tuiInstallReviewLimits,
  windowTuiItems,
} from '../../src/ui/tui/controller.js';
import { EXIT_CODES, failure, success } from '../../src/domain/result.js';
import type { CommandInvocation } from '../../src/commands/program.js';
import type {
  TuiDashboard,
  TuiDoctorSummary,
  TuiInstallPreview,
  TuiLibraryInitPlan,
} from '../../src/ui/tui/types.js';
import { withTempDirectory } from '../helpers/temp.js';

function installPreview(): TuiInstallPreview {
  return {
    fingerprint: `install-v1-${'f'.repeat(64)}`,
    freshness: 'cache-only',
    gitignore: {
      after: '# skill-sync managed\n/.codex/skills/review-ui/\n',
      applicable: true,
      before: '',
      changed: true,
      path: '/workspace/.gitignore',
    },
    libraryRevision: 'a'.repeat(40),
    location: '/workspace',
    scope: 'project',
    skills: [
      {
        digest: 'b'.repeat(64),
        id: 'frontend/review-ui',
        projections: [
          {
            destination: '.claude/skills/review-ui',
            target: 'claude',
            write: false,
          },
          { destination: '.codex/skills/review-ui', target: 'codex', write: true },
        ],
        status: 'expand-targets',
      },
    ],
    stale: true,
    state: { lockChanged: true, manifestChanged: false },
    writes: ['.codex/skills/review-ui', 'skill-sync.lock.json', '.gitignore'],
  };
}

function libraryInitPlan(overrides: Partial<TuiLibraryInitPlan> = {}): TuiLibraryInitPlan {
  return {
    action: 'connect',
    branch: 'main',
    configurationChanged: true,
    effects: {
      cache: 'refresh',
      configuration: 'write',
      githubRepository: 'none',
      remoteLibrary: 'none',
    },
    fingerprint: `init-v1-${'f'.repeat(64)}`,
    remote: {
      cloneUrl: 'git@github.com:acme/skills.git',
      identity: 'github.com/acme/skills',
      transport: 'ssh',
    },
    remoteState: 'compatible',
    repository: null,
    revision: 'a'.repeat(40),
    validation: { groups: 1, skills: 3 },
    visibility: null,
    ...overrides,
  };
}

function initDryRunResult(plan: TuiLibraryInitPlan): Readonly<Record<string, unknown>> {
  return {
    action: plan.action,
    applied: false,
    branch: plan.branch,
    configuration: { changed: plan.configurationChanged },
    dryRun: true,
    effects: plan.effects,
    fingerprint: plan.fingerprint,
    operation: 'init',
    remote: plan.remote,
    remoteState: plan.remoteState,
    repository: plan.repository,
    revision: plan.revision,
    validation: plan.validation,
    visibility: plan.visibility,
  };
}

function doctorSummary(issueCount = 5): TuiDoctorSummary {
  return {
    counts: { fail: 2, pass: 7, skipped: 1, warning: 2 },
    issues: Array.from({ length: issueCount }, (_, index) => ({
      id: `check-${String(index + 1)}`,
      message: `Diagnostic message ${String(index + 1)} with details that remain bounded.`,
      remediation: `Run remediation ${String(index + 1)} and then rerun diagnostics.`,
      scope: index === 2 ? ('remote' as const) : ('local' as const),
      status:
        index < 2 ? ('fail' as const) : index < 4 ? ('warning' as const) : ('skipped' as const),
    })),
    location: '/workspace',
    offline: false,
    scope: 'project',
  };
}

describe('TUI renderer and action port', () => {
  it('renders a compact no-color loading screen without opening a terminal session', () => {
    const output = renderToString(
      createElement(TuiApp, {
        actions: {
          add: () => Promise.resolve(success({})),
          adopt: () => Promise.resolve(success({})),
          applyLibrarySetup: () => Promise.resolve(success({})),
          checkForUpdate: () => Promise.resolve(undefined),
          diagnose: () => Promise.resolve(success(doctorSummary(0))),
          install: () => Promise.resolve(success({})),
          load: () => new Promise<TuiDashboard>(() => undefined),
          previewLibrarySetup: () => Promise.resolve(success(libraryInitPlan())),
          previewAdd: () =>
            Promise.resolve(
              success({
                changed: true as const,
                digest: 'b'.repeat(64),
                dryRun: true as const,
                id: 'workflows/openspec/openspec-propose',
                revision: 'a'.repeat(40),
              }),
            ),
          previewInstall: () => Promise.resolve(success(installPreview())),
          sync: () => Promise.resolve(success({})),
        },
        color: false,
        implicit: false,
      }),
      { columns: 40 },
    );

    expect(output).toContain('skill-sync command center');
    expect(output).toContain('Loading your skill library');
    expect(output).not.toContain('\u001b[');
  });

  it('renders a useful first-run menu instead of an empty dashboard', () => {
    const output = renderToString(
      createElement(TuiFirstRunMenu, {
        color: false,
        cursor: 0,
      }),
    );

    expect(output).toContain('Set up your skill library');
    expect(output).toContain('Connect existing library');
    expect(output).toContain('Create GitHub library');
    expect(output).toContain('starts empty');
    expect(output).toContain('Run diagnostics');
    expect(output).toContain('Show setup guide');
    expect(output).toContain('Quit');
  });

  it('renders malformed first-run input with inline examples and keeps it available to edit', () => {
    const connect = renderToString(
      createElement(TuiSetupForm, {
        color: false,
        error:
          'Use a valid HTTPS or SSH owner/repository URL. Example: https://github.com/you/ai-skills.git',
        input: 'not-a-repository',
        kind: 'connect',
      }),
    );
    const create = renderToString(
      createElement(TuiSetupForm, {
        color: false,
        error: 'Use GitHub owner/name syntax. Example: you/ai-skills',
        input: 'noslash',
        kind: 'create',
      }),
    );

    expect(connect).toContain('Repository URL: not-a-repository');
    expect(connect).toContain('Example:');
    expect(connect).toContain('https://github.com/you/ai-skills.git');
    expect(connect).toContain('Enter review · Esc back');
    expect(create).toContain('GitHub repository: noslash');
    expect(create).toContain('Example: you/ai-skills');
    expect(create).toContain('library starts empty');
    expect(create).toContain('Enter review · Esc back');
  });

  it('renders the validated init plan before connect, creation, or empty initialization', () => {
    const connect = renderToString(
      createElement(TuiSetupReview, {
        color: false,
        plan: libraryInitPlan(),
      }),
    );
    const createPlan = libraryInitPlan({
      action: 'create',
      effects: {
        cache: 'refresh',
        configuration: 'write',
        githubRepository: 'create',
        remoteLibrary: 'initialize',
      },
      fingerprint: `init-v1-${'e'.repeat(64)}`,
      remote: {
        cloneUrl: 'https://github.com/acme/skills.git',
        identity: 'github.com/acme/skills',
        transport: 'https',
      },
      remoteState: 'available',
      repository: 'acme/skills',
      revision: null,
      validation: null,
      visibility: 'private',
    });
    const create = renderToString(
      createElement(TuiSetupReview, {
        color: false,
        plan: createPlan,
      }),
    );
    const empty = renderToString(
      createElement(TuiSetupReview, {
        color: false,
        plan: libraryInitPlan({
          action: 'initialize-empty',
          effects: {
            cache: 'refresh',
            configuration: 'write',
            githubRepository: 'none',
            remoteLibrary: 'initialize',
          },
          remoteState: 'empty',
          revision: null,
          validation: null,
        }),
      }),
    );

    expect(connect).toContain('Review library connection');
    expect(connect).toContain('URL: git@github.com:acme/skills.git');
    expect(connect).toContain(`Revision: ${'a'.repeat(40)}`);
    expect(connect).toContain('Validated: 3 skill(s), 1 group(s)');
    expect(connect).toContain('Existing remote content will not be changed');
    expect(connect).toContain(`Plan: init-v1-${'f'.repeat(64)}`);
    expect(connect).toContain('y apply · Esc edit');
    expect(create).toContain('Review GitHub library creation');
    expect(create).toContain('Branch: main');
    expect(create).toContain('Visibility: private · Transport: HTTPS');
    expect(create).toContain('Create the GitHub repository');
    expect(create).toContain('Initialize an empty library with no skills');
    expect(create).toContain('Push the initial library commit');
    expect(create).toContain('Warning: this creates content on a remote Git provider');
    expect(create).toContain(
      'If a later step fails, the repository may remain; inspect it with GitHub before',
    );
    expect(create).toContain('retrying or deleting it.');
    expect(create).toContain('y apply · Esc edit');
    expect(empty).toContain('Review empty remote initialization');
    expect(empty).toContain('Initialize an empty library with no skills');
    expect(empty).toContain('Push the initial library commit');
    expect(empty).toContain('y apply · Esc edit');
  });

  it('renders actionable empty-library and filtered-catalog states', () => {
    const empty = renderToString(
      createElement(TuiCatalogEmptyState, { color: false, filtered: false }),
    );
    const filtered = renderToString(
      createElement(TuiCatalogEmptyState, { color: false, filtered: true }),
    );

    expect(empty).toContain('This library has no skills yet');
    expect(empty).toContain('Open Unmanaged inventory');
    expect(empty).toContain('skill-sync add <path> --dry-run');
    expect(filtered).toContain('No skills match the current search and group filter');
    expect(filtered).not.toContain('skill-sync add');
  });

  it('renders the setup guide URL without launching a browser', () => {
    const output = renderToString(createElement(TuiSetupGuide, { color: false }));

    expect(output).toContain('Setup guide');
    expect(output).toContain(TUI_SETUP_GUIDE_URL);
    expect(output).toContain('Enter/Esc back');
  });

  it('renders bounded actionable diagnostic issues and summary counts', () => {
    const output = renderToString(
      createElement(TuiSetupDiagnostics, {
        color: false,
        columns: 80,
        cursor: 0,
        rows: 14,
        summary: doctorSummary(),
      }),
    );

    expect(output).toContain('Pass 7 · Warning 2 · Fail 2 · Skipped 1');
    expect(output).toContain('FAIL · check 1');
    expect(output).toContain('Next: Run remediation 1');
    expect(output).toContain('Rows 1–2 of 5 · active 1');
    expect(output).not.toContain('Diagnostic message 3');
    expect(output).toContain('↑↓ issues · r run again · Enter/Esc back');
  });

  it('keeps diagnostic errors and controls bounded on a small terminal', () => {
    const error = `DOCTOR_FAILED: ${'x'.repeat(500)}`;
    const output = renderToString(
      createElement(TuiSetupDiagnostics, {
        color: false,
        columns: 28,
        cursor: 0,
        error,
        rows: 10,
      }),
      { columns: 28 },
    );

    expect(output).toContain('Setup diagnostics');
    expect(output).toContain('DOCTOR_FAILED:');
    expect(output).toContain('…');
    expect(output).not.toContain('x'.repeat(100));
    expect(output).toContain('r run again · Enter/Esc back');
  });

  it('renders an available CLI update as a passive footer indicator', () => {
    const output = renderToString(
      createElement(TuiReleaseUpdateIndicator, {
        color: false,
        update: { availableVersion: '0.2.0', installedVersion: '0.1.0' },
      }),
    );

    expect(output).toContain('CLI update available: 0.1.0 → 0.2.0');
    expect(output).toContain('skill-sync self-update');
  });

  it('renders a position indicator only when a list is truncated', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    const truncated = renderToString(
      createElement(TuiWindowIndicator, {
        color: false,
        window: windowTuiItems(items, 9, 9),
      }),
    );
    const complete = renderToString(
      createElement(TuiWindowIndicator, {
        color: false,
        window: windowTuiItems(items.slice(0, 9), 8, 9),
      }),
    );

    expect(truncated).toContain('Rows 2–10 of 20 · active 10');
    expect(complete).toBe('');
  });

  it('renders both reviewed .gitignore policies explicitly', () => {
    const unchanged = renderToString(
      createElement(TuiGitignorePolicy, { applicable: true, color: false, managed: false }),
    );
    const managed = renderToString(
      createElement(TuiGitignorePolicy, { applicable: true, color: false, managed: true }),
    );
    const global = renderToString(
      createElement(TuiGitignorePolicy, { applicable: false, color: false, managed: true }),
    );

    expect(unchanged).toContain('Do not manage skill paths in .gitignore');
    expect(managed).toContain('Manage exact skill paths in .gitignore');
    expect(global).toContain('not applicable to global installs');
    expect(global).not.toContain('Manage exact skill paths');
  });

  it('renders every safety-relevant field from an install dry-run', () => {
    const output = renderToString(
      createElement(TuiInstallPreviewReview, {
        color: false,
        preview: installPreview(),
      }),
      { columns: 200 },
    );

    expect(output).toContain(`Library revision: ${'a'.repeat(40)}`);
    expect(output).toContain(`Reviewed plan: install-v1-${'f'.repeat(64)}`);
    expect(output).toContain(`digest ${'b'.repeat(12)}…`);
    expect(output).toContain('Freshness: cache-only · stale');
    expect(output).toContain('Manifest state: no change');
    expect(output).toContain('Lock state: would update');
    expect(output).toContain('Gitignore file: would update /workspace/.gitignore');
    expect(output).toContain('codex → .codex/skills/review-ui · write');
    expect(output).toContain('claude → .claude/skills/review-ui · no write');
    expect(output).toContain('Exact planned writes:');
    expect(output).toContain('skill-sync.lock.json');
  });

  it('bounds long install reviews with explicit omitted counts', () => {
    const output = renderToString(
      createElement(TuiInstallPreviewReview, {
        color: false,
        limits: tuiInstallReviewLimits(20),
        preview: installPreview(),
      }),
    );

    expect(output).toContain('1 more destinations omitted for this terminal');
    expect(output).toContain('2 more writes omitted for this terminal');
    expect(output).not.toContain('skill-sync.lock.json');
  });

  it('renders add-to-library folder browsing, creation, and review details', () => {
    const entry = {
      adoptable: true,
      issues: [],
      name: 'openspec-propose',
      path: '/workspace/.codex/skills/openspec-propose',
      status: 'unmanaged',
      target: 'codex',
    };
    const items = tuiAddLocationItems(
      ['tools', 'workflows', 'workflows/shared'],
      ['workflows/openspec'],
      'workflows',
    );
    const browser = renderToString(
      createElement(TuiAddLocationBrowser, {
        color: false,
        currentGroup: 'workflows',
        cursor: 2,
        entry,
        window: windowTuiItems(items, 2, 10),
      }),
    );
    const folderForm = renderToString(
      createElement(TuiAddFolderForm, {
        color: false,
        currentGroup: 'workflows/openspec',
        error: undefined,
        input: 'changes',
      }),
    );
    const review = renderToString(
      createElement(TuiAddReview, {
        color: false,
        entry,
        preview: {
          changed: true,
          digest: 'b'.repeat(64),
          dryRun: true,
          id: 'workflows/openspec/openspec-propose',
          revision: 'a'.repeat(40),
        },
      }),
    );

    expect(browser).toContain('Choose library location');
    expect(browser).toContain('Save in workflows');
    expect(browser).toContain('.. Back to library root');
    expect(browser).toContain('openspec/ [new]');
    expect(browser).toContain('+ Add folder');
    expect(folderForm).toContain('Inside: workflows/openspec');
    expect(folderForm).toContain('Folder name: changes');
    expect(folderForm).toContain('Enter create and open');
    expect(review).toContain('Canonical skill: workflows/openspec/openspec-propose');
    expect(review).toContain('commit and push');
    expect(review).toContain('y add and track');
  });

  it('routes confirmed UI operations through the existing command executor contract', async () => {
    const calls: CommandInvocation[] = [];
    const port = new DefaultTuiActionPort(
      (input) => {
        calls.push(input);
        return Promise.resolve(
          input.command === 'release:check'
            ? success({ availableVersion: '0.2.0', installedVersion: '0.1.0' })
            : input.command === 'doctor'
              ? success({
                  checks: [],
                  exitCode: EXIT_CODES.success,
                  offline: false,
                  projectRoot: '/workspace',
                  scope: 'project',
                })
              : input.command === 'init' && input.options.dryRun === true
                ? success(
                    initDryRunResult(
                      input.options.create === undefined
                        ? libraryInitPlan()
                        : libraryInitPlan({
                            action: 'create',
                            effects: {
                              cache: 'refresh',
                              configuration: 'write',
                              githubRepository: 'create',
                              remoteLibrary: 'initialize',
                            },
                            fingerprint: `init-v1-${'e'.repeat(64)}`,
                            remote: {
                              cloneUrl: 'https://github.com/acme/skills.git',
                              identity: 'github.com/acme/skills',
                              transport: 'https',
                            },
                            remoteState: 'available',
                            repository: 'acme/skills',
                            revision: null,
                            validation: null,
                            visibility: 'private',
                          }),
                    ),
                  )
                : input.command === 'add' && input.options.dryRun === true
                  ? success({
                      changed: true,
                      digest: 'b'.repeat(64),
                      dryRun: true,
                      id: 'workflows/openspec/openspec-propose',
                      revision: 'a'.repeat(40),
                    })
                  : success({}),
        );
      },
      { project: '/workspace' },
    );

    await port.adopt('frontend/review-ui', 'codex');
    await expect(port.checkForUpdate()).resolves.toEqual({
      availableVersion: '0.2.0',
      installedVersion: '0.1.0',
    });
    await port.install(
      ['frontend/review-ui'],
      ['codex', 'claude'],
      true,
      `install-v1-${'f'.repeat(64)}`,
    );
    await port.sync(true);
    await port.previewLibrarySetup({
      kind: 'connect',
      value: 'git@github.com:acme/skills.git',
    });
    await port.applyLibrarySetup(
      { kind: 'connect', value: 'git@github.com:acme/skills.git' },
      `init-v1-${'f'.repeat(64)}`,
    );
    await port.previewLibrarySetup({ kind: 'create', value: 'acme/skills' });
    await port.applyLibrarySetup(
      { kind: 'create', value: 'acme/skills' },
      `init-v1-${'e'.repeat(64)}`,
    );
    await port.diagnose();
    await expect(
      port.previewAdd('/workspace/.codex/skills/openspec-propose', 'workflows/openspec'),
    ).resolves.toMatchObject({
      ok: true,
      data: { id: 'workflows/openspec/openspec-propose' },
    });
    await port.add('/workspace/.codex/skills/openspec-propose', 'workflows/openspec');

    expect(calls).toHaveLength(11);
    expect(calls[0]?.command).toBe('adopt');
    expect(calls[0]?.arguments).toEqual(['frontend/review-ui']);
    expect(calls[0]?.options).toMatchObject({
      json: true,
      noInput: true,
      target: 'codex',
      yes: true,
    });
    expect(calls[1]?.command).toBe('release:check');
    expect(calls[1]?.arguments).toEqual([]);
    expect(calls[1]?.options).toMatchObject({ json: true, noInput: true, yes: true });
    expect(calls[2]?.command).toBe('install');
    expect(calls[2]?.arguments).toEqual([['frontend/review-ui']]);
    expect(calls[2]?.options).toMatchObject({
      gitignore: true,
      expectPlan: `install-v1-${'f'.repeat(64)}`,
      json: true,
      noInput: true,
      target: ['codex', 'claude'],
      yes: true,
    });
    expect(calls[3]?.command).toBe('sync');
    expect(calls[3]?.arguments).toEqual([]);
    expect(calls[3]?.options).toMatchObject({
      discardLocal: true,
      json: true,
      noInput: true,
      yes: true,
    });
    expect(calls[4]).toEqual({
      command: 'init',
      arguments: ['git@github.com:acme/skills.git'],
      options: { color: true, dryRun: true, json: true, noInput: true, yes: false },
    });
    expect(calls[5]).toEqual({
      command: 'init',
      arguments: ['git@github.com:acme/skills.git'],
      options: {
        color: true,
        expectPlan: `init-v1-${'f'.repeat(64)}`,
        json: true,
        noInput: true,
        yes: true,
      },
    });
    expect(calls[6]).toEqual({
      command: 'init',
      arguments: [],
      options: {
        color: true,
        create: 'acme/skills',
        dryRun: true,
        json: true,
        noInput: true,
        yes: false,
      },
    });
    expect(calls[7]).toEqual({
      command: 'init',
      arguments: [],
      options: {
        color: true,
        create: 'acme/skills',
        expectPlan: `init-v1-${'e'.repeat(64)}`,
        json: true,
        noInput: true,
        yes: true,
      },
    });
    expect(calls[8]).toMatchObject({
      command: 'doctor',
      arguments: [],
      options: { json: true, noInput: true, yes: false },
    });
    expect(calls[9]).toEqual({
      command: 'add',
      arguments: ['/workspace/.codex/skills/openspec-propose'],
      options: {
        color: true,
        dryRun: true,
        group: 'workflows/openspec',
        json: true,
        noInput: true,
        yes: false,
      },
    });
    expect(calls[10]).toEqual({
      command: 'add',
      arguments: ['/workspace/.codex/skills/openspec-propose'],
      options: {
        color: true,
        group: 'workflows/openspec',
        json: true,
        noInput: true,
        yes: false,
      },
    });
  });

  it('detects an unconfigured library as first-run state without duplicate errors', async () => {
    const port = new DefaultTuiActionPort(
      () =>
        Promise.resolve(
          failure(
            {
              code: 'LIBRARY_NOT_CONFIGURED',
              message: 'No default skill library is configured.',
            },
            EXIT_CODES.validation,
          ),
        ),
      { project: '/workspace' },
    );

    await expect(port.load()).resolves.toMatchObject({
      errors: [],
      firstRun: true,
      skills: [],
      managed: [],
    });
  });

  it('preserves an existing managed project gitignore policy in install action data', async () => {
    await withTempDirectory('skill-sync-tui-gitignore-', async (root) => {
      const project = join(root, 'project');
      const identity = 'github.com/acme/skills';
      await mkdir(project);
      await writeFile(
        join(project, 'skill-sync.json'),
        `${JSON.stringify({
          gitignore: 'managed',
          library: { identity },
          schemaVersion: 1,
          skills: [],
        })}\n`,
      );
      await writeFile(
        join(project, 'skill-sync.lock.json'),
        `${JSON.stringify({
          library: { identity, revision: 'a'.repeat(40) },
          schemaVersion: 1,
          skills: [],
        })}\n`,
      );

      const calls: CommandInvocation[] = [];
      const port = new DefaultTuiActionPort(
        (input) => {
          calls.push(input);
          if (input.command === 'status')
            return Promise.resolve(success({ projectRoot: project, skills: [] }));
          if (input.command === 'config:list') {
            return Promise.resolve(success({ effective: { value: { gitignore: 'leave' } } }));
          }
          return Promise.resolve(success({ skills: [] }));
        },
        { project },
      );

      const dashboard = await port.load();
      expect(dashboard.manageGitignore).toBe(true);
      await port.install(
        ['frontend/review-ui'],
        ['codex'],
        dashboard.manageGitignore,
        `install-v1-${'f'.repeat(64)}`,
      );

      const install = calls.find((call) => call.command === 'install');
      expect(install?.options).toMatchObject({
        expectPlan: `install-v1-${'f'.repeat(64)}`,
        gitignore: true,
        target: ['codex'],
      });
    });
  });

  it('omits the project-only gitignore option from global install invocations', async () => {
    const calls: CommandInvocation[] = [];
    const port = new DefaultTuiActionPort(
      (input) => {
        calls.push(input);
        return Promise.resolve(success({}));
      },
      { global: true },
    );

    await port.install(['frontend/review-ui'], ['codex'], true, `install-v1-${'f'.repeat(64)}`);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'install',
      arguments: [['frontend/review-ui']],
      options: {
        global: true,
        expectPlan: `install-v1-${'f'.repeat(64)}`,
        json: true,
        noInput: true,
        target: ['codex'],
        yes: true,
      },
    });
    expect(calls[0]?.options).not.toHaveProperty('gitignore');
  });
});
