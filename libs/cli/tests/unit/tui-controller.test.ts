import { describe, expect, it, vi } from 'vitest';

import {
  backFromTuiScreen,
  compatibleAdoptionSkillIds,
  confirmTuiInstallReview,
  confirmTuiLibraryRemoveReview,
  confirmTuiSetupReview,
  confirmTuiSyncReview,
  describeTuiItemWindow,
  firstRunDestination,
  initialTuiNavigation,
  moveTuiCursor,
  overviewDestination,
  tuiAddLocationItems,
  tuiDiagnosticIssueLimit,
  tuiInstallTargetDefaults,
  tuiInstallReviewLimits,
  TUI_ROW_LIMITS,
  tuiRowLimit,
  tuiSetupCompletion,
  tuiSetupReviewScreen,
  validateTuiFolderName,
  validateTuiSetupInput,
  windowTuiItems,
} from '../../src/ui/tui/controller.js';
import { EXIT_CODES, failure, success, type CommandResult } from '../../src/domain/result.js';
import type {
  TuiInstallPreview,
  TuiLibraryInitPlan,
  TuiLibraryRemovePreview,
  TuiSyncPreview,
} from '../../src/ui/tui/types.js';

function installPreview(overrides: Partial<TuiInstallPreview> = {}): TuiInstallPreview {
  return {
    fingerprint: `install-v1-${'f'.repeat(64)}`,
    freshness: 'fetched',
    gitignore: {
      after: '/.codex/skills/review-ui/\n',
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
          { destination: '.codex/skills/review-ui', target: 'codex', write: true },
          { destination: '.claude/skills/review-ui', target: 'claude', write: false },
        ],
        status: 'expand-targets',
      },
    ],
    stale: false,
    state: { lockChanged: true, manifestChanged: true },
    writes: ['skill-sync.lock.json', '.codex/skills/review-ui', '.gitignore'],
    ...overrides,
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
      cloneUrl: 'https://github.com/acme/skills.git',
      identity: 'github.com/acme/skills',
      transport: 'https',
    },
    remoteState: 'compatible',
    repository: null,
    revision: 'a'.repeat(40),
    validation: { groups: 1, skills: 3 },
    visibility: null,
    ...overrides,
  };
}

function syncPreview(overrides: Partial<TuiSyncPreview> = {}): TuiSyncPreview {
  return {
    authoritative: true,
    fingerprint: `sync-review-v1-${'f'.repeat(64)}`,
    freshness: 'fetched',
    libraryRevision: 'a'.repeat(40),
    location: '/workspace',
    scope: 'project',
    skills: [],
    stale: false,
    wouldChange: false,
    ...overrides,
  };
}

describe('TUI navigation controller', () => {
  it('keeps navigation within the visible screen bounds', () => {
    expect(moveTuiCursor(initialTuiNavigation(), -1, 3)).toEqual({ cursor: 0, screen: 'overview' });
    expect(moveTuiCursor({ cursor: 0, screen: 'catalog' }, 9, 3)).toEqual({
      cursor: 2,
      screen: 'catalog',
    });
  });

  it('keeps the active item inside deterministic compact and normal windows', () => {
    const items = Array.from({ length: 20 }, (_, index) => `item-${String(index + 1)}`);

    expect(tuiRowLimit(true)).toBe(TUI_ROW_LIMITS.compact);
    expect(tuiRowLimit(false)).toBe(TUI_ROW_LIMITS.normal);
    expect(tuiRowLimit(false, 24)).toBe(6);
    expect(tuiRowLimit(true, 18)).toBe(3);
    expect(tuiRowLimit(false, 10)).toBe(1);
    expect(tuiInstallReviewLimits(20)).toEqual({ destinations: 1, writes: 1 });
    expect(tuiInstallReviewLimits(30)).toEqual({ destinations: 8, writes: 4 });
    expect(tuiDiagnosticIssueLimit(10)).toBe(1);
    expect(tuiDiagnosticIssueLimit(14)).toBe(2);
    expect(tuiDiagnosticIssueLimit(30)).toBe(6);

    const first = windowTuiItems(items, 0, TUI_ROW_LIMITS.compact);
    expect(first).toMatchObject({ activeIndex: 0, start: 0, end: 9, truncated: true });
    expect(first.items).toEqual(items.slice(0, 9));

    const boundary = windowTuiItems(items, 8, TUI_ROW_LIMITS.compact);
    expect(boundary).toMatchObject({ activeIndex: 8, start: 0, end: 9 });

    const scrolled = windowTuiItems(items, 9, TUI_ROW_LIMITS.compact);
    expect(scrolled).toMatchObject({ activeIndex: 9, start: 1, end: 10 });
    expect(scrolled.items[9 - scrolled.start]).toBe(items[9]);

    const last = windowTuiItems(items, 19, TUI_ROW_LIMITS.compact);
    expect(last).toMatchObject({ activeIndex: 19, start: 11, end: 20 });
    expect(last.items[19 - last.start]).toBe(items[19]);
  });

  it('describes truncated ranges and stays silent when every row is visible', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(describeTuiItemWindow(windowTuiItems(items, 9, 9))).toBe('Rows 2–10 of 20 · active 10');
    expect(describeTuiItemWindow(windowTuiItems(items.slice(0, 9), 8, 9))).toBeUndefined();
  });

  it('maps overview actions and back behavior without renderer state', () => {
    expect(overviewDestination(0)).toBe('managed');
    expect(overviewDestination(1)).toBe('catalog');
    expect(overviewDestination(2)).toBe('unmanaged');
    expect(overviewDestination(3)).toBe('diagnostics');
    expect(overviewDestination(4)).toBe('quit');
    expect(firstRunDestination(0)).toBe('setup-connect');
    expect(firstRunDestination(1)).toBe('setup-create');
    expect(firstRunDestination(2)).toBe('setup-diagnostics');
    expect(firstRunDestination(3)).toBe('setup-guide');
    expect(firstRunDestination(4)).toBe('quit');
    expect(tuiSetupReviewScreen('connect')).toBe('setup-connect-review');
    expect(tuiSetupReviewScreen('create')).toBe('setup-create-review');
    expect(backFromTuiScreen('catalog')).toBe('overview');
    expect(backFromTuiScreen('detail')).toBe('catalog');
    expect(backFromTuiScreen('group-filter')).toBe('catalog');
    expect(backFromTuiScreen('managed-detail')).toBe('managed');
    expect(backFromTuiScreen('diagnostics')).toBe('overview');
    expect(backFromTuiScreen('library-remove-review')).toBe('catalog');
    expect(backFromTuiScreen('add-location')).toBe('unmanaged');
    expect(backFromTuiScreen('add-folder-name')).toBe('add-location');
    expect(backFromTuiScreen('add-review')).toBe('add-location');
    expect(backFromTuiScreen('adopt-candidate')).toBe('unmanaged');
    expect(backFromTuiScreen('adopt-review')).toBe('adopt-candidate');
    expect(backFromTuiScreen('setup-connect')).toBe('first-run');
    expect(backFromTuiScreen('setup-connect-review')).toBe('setup-connect');
    expect(backFromTuiScreen('setup-create')).toBe('first-run');
    expect(backFromTuiScreen('setup-create-review')).toBe('setup-create');
    expect(backFromTuiScreen('setup-diagnostics')).toBe('first-run');
    expect(backFromTuiScreen('setup-guide')).toBe('first-run');
    expect(backFromTuiScreen('first-run')).toBe('quit');
    expect(backFromTuiScreen('overview')).toBe('quit');
  });

  it('revalidates synchronization reviews before applying', async () => {
    const reviewed = syncPreview();
    const changed = syncPreview({
      fingerprint: `sync-review-v1-${'e'.repeat(64)}`,
      libraryRevision: 'b'.repeat(40),
      wouldChange: true,
    });
    const apply = vi.fn<() => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(success({ applied: true })),
    );

    await expect(
      confirmTuiSyncReview({
        apply,
        preview: () => Promise.resolve(success(changed)),
        reviewed,
      }),
    ).resolves.toEqual({ kind: 'changed', preview: changed });
    expect(apply).not.toHaveBeenCalled();

    await expect(
      confirmTuiSyncReview({
        apply,
        preview: () => Promise.resolve(success(reviewed)),
        reviewed,
      }),
    ).resolves.toMatchObject({ kind: 'applied', result: { ok: true } });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('builds one-level folder choices for each add location', () => {
    expect(
      tuiAddLocationItems(
        ['tools', 'workflows', 'workflows/shared', 'workflows/shared/frontend'],
        ['workflows/openspec', 'workflows/openspec/changes'],
        'workflows',
      ),
    ).toEqual([
      { kind: 'save' },
      { group: '', kind: 'parent' },
      { group: 'workflows/openspec', kind: 'group', pending: true },
      { group: 'workflows/shared', kind: 'group', pending: false },
      { kind: 'add-folder' },
    ]);
  });

  it('validates one portable folder segment at a time', () => {
    expect(validateTuiFolderName(' openspec ')).toEqual({ ok: true, value: 'openspec' });
    expect(validateTuiFolderName('nested/folder')).toMatchObject({ ok: false });
    expect(validateTuiFolderName('OpenSpec')).toMatchObject({ ok: false });
  });

  it('uses configured targets and provides a Codex fallback only when none are configured', () => {
    expect(tuiInstallTargetDefaults([])).toEqual(['codex']);
    expect(tuiInstallTargetDefaults(['claude'])).toEqual(['claude']);
    expect(tuiInstallTargetDefaults(['claude', 'codex'])).toEqual(['claude', 'codex']);
  });

  it('moves a populated setup into installation and keeps an empty library actionable', () => {
    expect(tuiSetupCompletion('connect', 3)).toEqual({
      notice:
        'Skill library connected. Press Space to select a skill, then i to review installation.',
      screen: 'catalog',
    });
    expect(tuiSetupCompletion('create', 0)).toEqual({
      notice:
        'Skill library initialized. It has no skills yet. Open Unmanaged inventory to add an on-disk skill, or run skill-sync add <path> --dry-run.',
      screen: 'overview',
    });
    const emptyRemote = tuiSetupCompletion('initialize-empty', 0);
    expect(emptyRemote.screen).toBe('overview');
    expect(emptyRemote.notice).toContain('skill-sync add <path> --dry-run');
  });

  it('validates first-run repository inputs before invoking setup actions', () => {
    expect(validateTuiSetupInput('connect', 'not-a-repository')).toEqual({
      error:
        'Use a valid HTTPS or SSH owner/repository URL. Example: https://github.com/you/ai-skills.git',
      ok: false,
    });
    expect(
      validateTuiSetupInput('connect', 'https://user:secret@github.com/acme/skills.git'),
    ).toEqual({
      error:
        'Remove credentials from the repository URL. Example: https://github.com/you/ai-skills.git',
      ok: false,
    });
    expect(validateTuiSetupInput('create', 'noslash')).toEqual({
      error: 'Use GitHub owner/name syntax. Example: you/ai-skills',
      ok: false,
    });
    expect(validateTuiSetupInput('connect', '  git@github.com:acme/skills.git  ')).toEqual({
      ok: true,
      value: 'git@github.com:acme/skills.git',
    });
    expect(validateTuiSetupInput('connect', 'http://GitHub.com/acme/skills')).toEqual({
      ok: true,
      value: 'https://github.com/acme/skills.git',
    });
    expect(validateTuiSetupInput('create', '  acme/skills  ')).toEqual({
      ok: true,
      value: 'acme/skills',
    });
  });

  it('keeps duplicate leaf names explicit when choosing a canonical adoption skill', () => {
    expect(
      compatibleAdoptionSkillIds(
        [
          { id: 'backend/review-ui', compatibleAgents: ['codex'] },
          { id: 'frontend/review-ui', compatibleAgents: ['codex', 'claude'] },
          { id: 'writing/edit', compatibleAgents: ['claude'] },
        ],
        'codex',
      ),
    ).toEqual(['backend/review-ui', 'frontend/review-ui']);
  });

  it('requires another confirmation when the revalidated plan changed', async () => {
    const reviewed = installPreview();
    const apply = vi.fn<(fingerprint: string) => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(success({ applied: true })),
    );
    const outcome = await confirmTuiInstallReview({
      apply,
      preview: () =>
        Promise.resolve(
          success(
            installPreview({
              fingerprint: `install-v1-${'e'.repeat(64)}`,
              libraryRevision: 'c'.repeat(40),
            }),
          ),
        ),
      reviewed,
    });

    expect(outcome).toMatchObject({
      kind: 'changed',
      preview: { libraryRevision: 'c'.repeat(40) },
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies only after an unchanged revalidation and stops on preview failure', async () => {
    const reviewed = installPreview();
    const apply = vi.fn<(fingerprint: string) => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(success({ applied: true })),
    );
    await expect(
      confirmTuiInstallReview({
        apply,
        preview: () => Promise.resolve(success(reviewed)),
        reviewed,
      }),
    ).resolves.toMatchObject({ kind: 'installed', result: { ok: true } });
    expect(apply).toHaveBeenCalledWith(reviewed.fingerprint);

    apply.mockClear();
    await expect(
      confirmTuiInstallReview({
        apply,
        preview: () =>
          Promise.resolve(
            failure(
              { code: 'PREVIEW_FAILED', message: 'Unable to inspect.' },
              EXIT_CODES.repository,
            ),
          ),
        reviewed,
      }),
    ).resolves.toMatchObject({ kind: 'preview-failed' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('refreshes and requires another confirmation when apply rejects a stale plan', async () => {
    const reviewed = installPreview();
    const refreshed = installPreview({ fingerprint: `install-v1-${'d'.repeat(64)}` });
    const preview = vi
      .fn<() => Promise<CommandResult<TuiInstallPreview>>>()
      .mockResolvedValueOnce(success(reviewed))
      .mockResolvedValueOnce(success(refreshed));
    const apply = vi.fn<(fingerprint: string) => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(
        failure(
          { code: 'INSTALL_PLAN_CHANGED', message: 'The reviewed install plan changed.' },
          EXIT_CODES.conflict,
        ),
      ),
    );

    await expect(confirmTuiInstallReview({ apply, preview, reviewed })).resolves.toEqual({
      kind: 'changed',
      preview: refreshed,
    });
    expect(apply).toHaveBeenCalledWith(reviewed.fingerprint);
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('requires another setup confirmation when revalidation finds a changed init plan', async () => {
    const reviewed = libraryInitPlan();
    const changed = libraryInitPlan({
      fingerprint: `init-v1-${'e'.repeat(64)}`,
      revision: 'c'.repeat(40),
    });
    const apply = vi.fn<(fingerprint: string) => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(success({ applied: true })),
    );

    await expect(
      confirmTuiSetupReview({
        apply,
        preview: () => Promise.resolve(success(changed)),
        reviewed,
      }),
    ).resolves.toEqual({ kind: 'changed', plan: changed });
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies an unchanged setup plan and refreshes a plan rejected as stale at commit time', async () => {
    const reviewed = libraryInitPlan();
    const applied = vi.fn<(fingerprint: string) => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(success({ applied: true })),
    );

    await expect(
      confirmTuiSetupReview({
        apply: applied,
        preview: () => Promise.resolve(success(reviewed)),
        reviewed,
      }),
    ).resolves.toMatchObject({ kind: 'applied', result: { ok: true } });
    expect(applied).toHaveBeenCalledWith(reviewed.fingerprint);

    const refreshed = libraryInitPlan({ fingerprint: `init-v1-${'d'.repeat(64)}` });
    const preview = vi
      .fn<() => Promise<CommandResult<TuiLibraryInitPlan>>>()
      .mockResolvedValueOnce(success(reviewed))
      .mockResolvedValueOnce(success(refreshed));
    const staleApply = vi.fn<(fingerprint: string) => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(
        failure(
          { code: 'INIT_PLAN_CHANGED', message: 'The reviewed setup plan changed.' },
          EXIT_CODES.conflict,
        ),
      ),
    );

    await expect(confirmTuiSetupReview({ apply: staleApply, preview, reviewed })).resolves.toEqual({
      kind: 'changed',
      plan: refreshed,
    });
    expect(staleApply).toHaveBeenCalledWith(reviewed.fingerprint);
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('requires a second removal confirmation when the canonical revision changed', async () => {
    const reviewed: TuiLibraryRemovePreview = {
      changed: true,
      dryRun: true,
      id: 'frontend/review-ui',
      revision: 'a'.repeat(40),
      warning: 'Installed copies remain orphaned.',
    };
    const changed = { ...reviewed, revision: 'b'.repeat(40) };
    const apply = vi.fn<() => Promise<CommandResult<unknown>>>(() =>
      Promise.resolve(success({ changed: true })),
    );

    await expect(
      confirmTuiLibraryRemoveReview({
        apply,
        preview: () => Promise.resolve(success(changed)),
        reviewed,
      }),
    ).resolves.toEqual({ kind: 'changed', preview: changed });
    expect(apply).not.toHaveBeenCalled();

    await expect(
      confirmTuiLibraryRemoveReview({
        apply,
        preview: () => Promise.resolve(success(reviewed)),
        reviewed,
      }),
    ).resolves.toMatchObject({ kind: 'removed', result: { ok: true } });
    expect(apply).toHaveBeenCalledOnce();
  });
});
