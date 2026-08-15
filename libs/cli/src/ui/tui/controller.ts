import { isValidGitHubRepositoryName } from '../../application/library-lifecycle.js';
import type { CommandResult } from '../../domain/result.js';
import { GitRemoteUrlError, normalizeGitRemote } from '../../infrastructure/git.js';
import type { TuiInstallPreview, TuiLibraryInitPlan, TuiTarget } from './types.js';

export type TuiScreen =
  | 'adopt-candidate'
  | 'adopt-review'
  | 'catalog'
  | 'detail'
  | 'first-run'
  | 'install-review'
  | 'managed'
  | 'overview'
  | 'setup-connect'
  | 'setup-connect-review'
  | 'setup-create'
  | 'setup-create-review'
  | 'setup-diagnostics'
  | 'setup-guide'
  | 'sync-review'
  | 'unmanaged';

export interface TuiNavigationState {
  readonly cursor: number;
  readonly screen: TuiScreen;
}

export type TuiSetupInputKind = 'connect' | 'create';

export type TuiSetupInputValidation =
  { readonly error: string; readonly ok: false } | { readonly ok: true; readonly value: string };

export const TUI_CONNECT_REPOSITORY_EXAMPLE = 'https://github.com/you/ai-skills.git';
export const TUI_CREATE_REPOSITORY_EXAMPLE = 'you/ai-skills';

export function tuiSetupReviewScreen(
  kind: TuiSetupInputKind,
): 'setup-connect-review' | 'setup-create-review' {
  return kind === 'connect' ? 'setup-connect-review' : 'setup-create-review';
}

export function validateTuiSetupInput(
  kind: TuiSetupInputKind,
  input: string,
): TuiSetupInputValidation {
  const value = input.trim();
  if (kind === 'create') {
    return isValidGitHubRepositoryName(value)
      ? { ok: true, value }
      : {
          error: `Use GitHub owner/name syntax. Example: ${TUI_CREATE_REPOSITORY_EXAMPLE}`,
          ok: false,
        };
  }

  try {
    return { ok: true, value: normalizeGitRemote(value).cloneUrl };
  } catch (error) {
    return {
      error:
        error instanceof GitRemoteUrlError && error.code === 'REMOTE_CREDENTIALS_FORBIDDEN'
          ? `Remove credentials from the repository URL. Example: ${TUI_CONNECT_REPOSITORY_EXAMPLE}`
          : `Use a valid HTTPS or SSH owner/repository URL. Example: ${TUI_CONNECT_REPOSITORY_EXAMPLE}`,
      ok: false,
    };
  }
}

export const TUI_ROW_LIMITS = {
  compact: 9,
  normal: 16,
} as const;

export const TUI_LIST_RESERVED_ROWS = 12;
export const TUI_INSTALL_REVIEW_RESERVED_ROWS = 18;
export const TUI_DIAGNOSTIC_RESERVED_ROWS = 8;
export const TUI_DIAGNOSTIC_MAX_ISSUES = 6;

export interface TuiItemWindow<T> {
  readonly activeIndex: number | null;
  readonly end: number;
  readonly items: readonly T[];
  readonly start: number;
  readonly total: number;
  readonly truncated: boolean;
}

export function tuiRowLimit(compact: boolean, terminalRows = Number.POSITIVE_INFINITY): number {
  const widthLimit = compact ? TUI_ROW_LIMITS.compact : TUI_ROW_LIMITS.normal;
  if (!Number.isFinite(terminalRows)) return widthLimit;
  const heightLimit = Math.max(
    1,
    Math.floor((Math.floor(terminalRows) - TUI_LIST_RESERVED_ROWS) / 2),
  );
  return Math.min(widthLimit, heightLimit);
}

export interface TuiInstallReviewLimits {
  readonly destinations: number;
  readonly writes: number;
}

export function tuiInstallReviewLimits(terminalRows: number): TuiInstallReviewLimits {
  const available = Math.max(2, Math.floor(terminalRows) - TUI_INSTALL_REVIEW_RESERVED_ROWS);
  const destinations = Math.max(1, Math.min(12, available - 1, Math.ceil((available * 2) / 3)));
  const writes = Math.max(1, Math.min(8, available - destinations));
  return { destinations, writes };
}

export function tuiDiagnosticIssueLimit(terminalRows: number): number {
  if (!Number.isFinite(terminalRows)) return TUI_DIAGNOSTIC_MAX_ISSUES;
  const available = Math.max(3, Math.floor(terminalRows) - TUI_DIAGNOSTIC_RESERVED_ROWS);
  return Math.max(1, Math.min(TUI_DIAGNOSTIC_MAX_ISSUES, Math.floor(available / 3)));
}

export function windowTuiItems<T>(
  items: readonly T[],
  cursor: number,
  rowLimit: number,
): TuiItemWindow<T> {
  const total = items.length;
  if (total === 0) {
    return { activeIndex: null, end: 0, items: [], start: 0, total, truncated: false };
  }

  const limit = Math.max(1, Math.floor(rowLimit));
  const activeIndex = Math.max(0, Math.min(total - 1, cursor));
  const start = Math.min(Math.max(0, activeIndex - limit + 1), Math.max(0, total - limit));
  const end = Math.min(total, start + limit);
  return {
    activeIndex,
    end,
    items: items.slice(start, end),
    start,
    total,
    truncated: total > limit,
  };
}

export function describeTuiItemWindow(window: TuiItemWindow<unknown>): string | undefined {
  if (!window.truncated || window.activeIndex === null) return undefined;
  return `Rows ${String(window.start + 1)}–${String(window.end)} of ${String(window.total)} · active ${String(window.activeIndex + 1)}`;
}

export function initialTuiNavigation(): TuiNavigationState {
  return { cursor: 0, screen: 'overview' };
}

export function moveTuiCursor(
  state: TuiNavigationState,
  amount: number,
  itemCount: number,
): TuiNavigationState {
  if (itemCount <= 0) return state;
  return {
    ...state,
    cursor: Math.max(0, Math.min(itemCount - 1, state.cursor + amount)),
  };
}

export function overviewDestination(cursor: number): TuiScreen | 'quit' {
  return (['catalog', 'managed', 'unmanaged', 'quit'] as const)[cursor] ?? 'overview';
}

export function firstRunDestination(cursor: number): TuiScreen | 'quit' {
  return (
    (['setup-connect', 'setup-create', 'setup-diagnostics', 'setup-guide', 'quit'] as const)[
      cursor
    ] ?? 'first-run'
  );
}

export function tuiInstallTargetDefaults(
  configuredTargets: readonly TuiTarget[],
): readonly TuiTarget[] {
  return configuredTargets.length === 0 ? ['codex'] : configuredTargets;
}

export interface TuiSetupCompletion {
  readonly notice: string;
  readonly screen: 'catalog' | 'overview';
}

export function tuiSetupCompletion(
  action: TuiLibraryInitPlan['action'],
  skillCount: number,
): TuiSetupCompletion {
  const result = action === 'connect' ? 'Skill library connected.' : 'Skill library initialized.';
  if (skillCount > 0) {
    return {
      notice: `${result} Press Space to select a skill, then i to review installation.`,
      screen: 'catalog',
    };
  }
  return {
    notice: `${result} It has no skills yet. Exit and run skill-sync add <path> --dry-run, then reopen skill-sync.`,
    screen: 'overview',
  };
}

export function backFromTuiScreen(screen: TuiScreen): TuiScreen | 'quit' {
  if (screen === 'overview' || screen === 'first-run') return 'quit';
  if (screen === 'setup-connect-review') return 'setup-connect';
  if (screen === 'setup-create-review') return 'setup-create';
  if (
    screen === 'setup-connect' ||
    screen === 'setup-create' ||
    screen === 'setup-diagnostics' ||
    screen === 'setup-guide'
  ) {
    return 'first-run';
  }
  if (screen === 'detail' || screen === 'install-review') return 'catalog';
  if (screen === 'adopt-candidate') return 'unmanaged';
  if (screen === 'adopt-review') return 'adopt-candidate';
  if (screen === 'sync-review') return 'managed';
  return 'overview';
}

/** Always return exact IDs; leaf names are deliberately not used to choose a canonical skill. */
export function compatibleAdoptionSkillIds(
  skills: readonly { readonly compatibleAgents: readonly string[]; readonly id: string }[],
  target: string,
): readonly string[] {
  return skills
    .filter((skill) => skill.compatibleAgents.includes(target))
    .map((skill) => skill.id)
    .sort((left, right) => left.localeCompare(right));
}

type TuiCommandFailure = Extract<CommandResult<unknown>, { readonly ok: false }>;

export type TuiInstallReviewOutcome =
  | { readonly kind: 'changed'; readonly preview: TuiInstallPreview }
  | { readonly kind: 'installed'; readonly result: CommandResult<unknown> }
  | { readonly kind: 'preview-failed'; readonly result: TuiCommandFailure };

/** Re-check the reviewed dry-run immediately before crossing the mutation boundary. */
export async function confirmTuiInstallReview(options: {
  readonly apply: (expectedPlanFingerprint: string) => Promise<CommandResult<unknown>>;
  readonly preview: () => Promise<CommandResult<TuiInstallPreview>>;
  readonly reviewed: TuiInstallPreview;
}): Promise<TuiInstallReviewOutcome> {
  const current = await options.preview();
  if (!current.ok) return { kind: 'preview-failed', result: current };
  if (current.data.fingerprint !== options.reviewed.fingerprint) {
    return { kind: 'changed', preview: current.data };
  }
  const result = await options.apply(current.data.fingerprint);
  if (!result.ok && result.errors.some((error) => error.code === 'INSTALL_PLAN_CHANGED')) {
    const refreshed = await options.preview();
    return refreshed.ok
      ? { kind: 'changed', preview: refreshed.data }
      : { kind: 'preview-failed', result: refreshed };
  }
  return { kind: 'installed', result };
}

export type TuiSetupReviewOutcome =
  | { readonly kind: 'applied'; readonly result: CommandResult<unknown> }
  | { readonly kind: 'changed'; readonly plan: TuiLibraryInitPlan }
  | { readonly kind: 'preview-failed'; readonly result: TuiCommandFailure };

/** Re-check setup facts immediately before applying the reviewed initialization plan. */
export async function confirmTuiSetupReview(options: {
  readonly apply: (expectedPlanFingerprint: string) => Promise<CommandResult<unknown>>;
  readonly preview: () => Promise<CommandResult<TuiLibraryInitPlan>>;
  readonly reviewed: TuiLibraryInitPlan;
}): Promise<TuiSetupReviewOutcome> {
  const current = await options.preview();
  if (!current.ok) return { kind: 'preview-failed', result: current };
  if (current.data.fingerprint !== options.reviewed.fingerprint) {
    return { kind: 'changed', plan: current.data };
  }
  const result = await options.apply(current.data.fingerprint);
  if (!result.ok && result.errors.some((error) => error.code === 'INIT_PLAN_CHANGED')) {
    const refreshed = await options.preview();
    return refreshed.ok
      ? { kind: 'changed', plan: refreshed.data }
      : { kind: 'preview-failed', result: refreshed };
  }
  return { kind: 'applied', result };
}
