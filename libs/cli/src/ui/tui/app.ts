import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';

import type { CommandResult } from '../../domain/result.js';
import {
  backFromTuiScreen,
  compatibleAdoptionSkillIds,
  confirmTuiInstallReview,
  confirmTuiLibraryRemoveReview,
  confirmTuiSetupReview,
  describeTuiItemWindow,
  firstRunDestination,
  moveTuiCursor,
  overviewDestination,
  tuiAddLocationItems,
  tuiDiagnosticIssueLimit,
  tuiGroupParent,
  tuiInstallTargetDefaults,
  tuiInstallReviewLimits,
  tuiRowLimit,
  tuiSetupCompletion,
  tuiSetupReviewScreen,
  validateTuiFolderName,
  validateTuiSetupInput,
  windowTuiItems,
  type TuiAddLocationItem,
  type TuiItemWindow,
  type TuiInstallReviewLimits,
  type TuiScreen,
  type TuiSetupInputKind,
} from './controller.js';
import { terminalSafe } from './sanitize.js';
import type {
  TuiActionPort,
  TuiDashboard,
  TuiDoctorIssue,
  TuiDoctorSummary,
  TuiInstallPreview,
  TuiInventorySkill,
  TuiLibraryAddPreview,
  TuiLibraryInitPlan,
  TuiLibraryRemovePreview,
  TuiLibrarySetupIntent,
  TuiReleaseUpdate,
  TuiSkill,
} from './types.js';

export const TUI_SETUP_GUIDE_URL =
  'https://github.com/moonryc/skill-sync/tree/main/apps/wiki/src/content/docs';

const palette = {
  accent: 'magenta',
  muted: 'gray',
  negative: 'red',
  positive: 'green',
  warning: 'yellow',
} as const;

function badgeColor(state: string): 'green' | 'red' | 'yellow' | 'gray' {
  if (state === 'current' || state === 'managed') return 'green';
  if (state.includes('modified') || state.includes('conflict') || state === 'invalid') return 'red';
  if (state.includes('outdated') || state === 'unmanaged' || state === 'unknown') return 'yellow';
  return 'gray';
}

function operationMessage(result: CommandResult<unknown>): string {
  if (result.ok) {
    return typeof result.data === 'string'
      ? terminalSafe(result.data)
      : 'Operation completed. Refreshing dashboard…';
  }
  return result.errors.map((error) => terminalSafe(`${error.code}: ${error.message}`)).join('\n');
}

function isSetupScreen(screen: TuiScreen): boolean {
  return (
    screen === 'first-run' ||
    screen === 'setup-connect' ||
    screen === 'setup-connect-review' ||
    screen === 'setup-create' ||
    screen === 'setup-create-review' ||
    screen === 'setup-diagnostics' ||
    screen === 'setup-guide'
  );
}

function visibleSkills(
  skills: readonly TuiSkill[],
  query: string,
  activeGroup: string | null,
): readonly TuiSkill[] {
  const normalized = query.toLocaleLowerCase('en-US');
  return skills.filter((skill) => {
    const inGroup =
      activeGroup === null ||
      skill.group === activeGroup ||
      skill.group?.startsWith(`${activeGroup}/`) === true;
    const matchesQuery =
      normalized === '' ||
      `${skill.id}\n${skill.description}`.toLocaleLowerCase('en-US').includes(normalized);
    return inGroup && matchesQuery;
  });
}

function withColor(color: string | undefined): Readonly<Record<string, string>> {
  return color === undefined ? {} : { color };
}

function boundedTerminalLine(value: string, columns: number, indent = 0): string {
  const safe = terminalSafe(value);
  const width = Math.max(12, Math.floor(columns) - indent - 2);
  return safe.length <= width ? safe : `${safe.slice(0, Math.max(1, width - 1))}…`;
}

function Header(props: {
  readonly color: boolean;
  readonly compact: boolean;
  readonly scope: string;
}): ReactElement {
  return createElement(
    Box,
    {
      ...(props.color ? { borderColor: palette.accent } : {}),
      borderStyle: 'round',
      paddingX: 1,
    },
    createElement(
      Text,
      { bold: props.color, ...withColor(props.color ? palette.accent : undefined) },
      props.compact
        ? `skill-sync · ${props.scope}`
        : `✦ skill-sync command center · ${props.scope} scope`,
    ),
  );
}

function StatusBadge(props: { readonly color: boolean; readonly state: string }): ReactElement {
  return createElement(
    Text,
    withColor(props.color ? badgeColor(props.state) : undefined),
    `[${props.state}]`,
  );
}

export function TuiWindowIndicator(props: {
  readonly color: boolean;
  readonly window: TuiItemWindow<unknown>;
}): ReactElement | null {
  const description = describeTuiItemWindow(props.window);
  if (description === undefined) return null;
  return createElement(Text, withColor(props.color ? palette.muted : undefined), description);
}

export function TuiGitignorePolicy(props: {
  readonly applicable: boolean;
  readonly color: boolean;
  readonly managed: boolean;
}): ReactElement {
  if (!props.applicable) {
    return createElement(
      Text,
      withColor(props.color ? palette.muted : undefined),
      'Gitignore: not applicable to global installs',
    );
  }
  return createElement(
    Text,
    withColor(props.color && props.managed ? palette.positive : undefined),
    props.managed
      ? 'Gitignore: g ◉ Manage exact skill paths in .gitignore'
      : 'Gitignore: g ○ Do not manage skill paths in .gitignore',
  );
}

export function TuiReleaseUpdateIndicator(props: {
  readonly color: boolean;
  readonly update: TuiReleaseUpdate | undefined;
}): ReactElement | null {
  if (props.update === undefined) return null;
  return createElement(
    Text,
    withColor(props.color ? palette.muted : undefined),
    `CLI update available: ${props.update.installedVersion} → ${props.update.availableVersion} · Run skill-sync self-update`,
  );
}

export function TuiFirstRunMenu(props: {
  readonly color: boolean;
  readonly cursor: number;
}): ReactElement {
  const items = [
    'Connect existing library',
    'Create GitHub library (starts empty)',
    'Run diagnostics',
    'Show setup guide',
    'Quit',
  ];
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, { bold: props.color }, 'Set up your skill library'),
    createElement(
      Text,
      null,
      'skill-sync needs one Git-backed library before it can browse or install skills.',
    ),
    ...items.map((item, index) =>
      createElement(
        Text,
        {
          key: item,
          ...withColor(props.cursor === index && props.color ? palette.accent : undefined),
        },
        `${props.cursor === index ? '❯' : ' '} ${item}`,
      ),
    ),
    createElement(
      Text,
      withColor(props.color ? palette.muted : undefined),
      '↑↓ move · Enter choose · r retry setup detection · q quit',
    ),
  );
}

export function TuiSetupForm(props: {
  readonly color: boolean;
  readonly error?: string;
  readonly input: string;
  readonly kind: TuiSetupInputKind;
}): ReactElement {
  const connect = props.kind === 'connect';
  const muted = props.color ? palette.muted : undefined;
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(
      Text,
      { bold: props.color },
      connect ? 'Connect an existing skill library' : 'Create a GitHub skill library',
    ),
    createElement(
      Text,
      null,
      connect
        ? 'Enter an HTTPS or SSH URL for an existing compatible skill-sync repository.'
        : 'Enter owner/name. Setup creates a private HTTPS repository on main. The new library starts empty.',
    ),
    createElement(
      Text,
      null,
      `${connect ? 'Repository URL' : 'GitHub repository'}: ${terminalSafe(props.input) || '▏'}`,
    ),
    props.error === undefined
      ? null
      : createElement(
          Text,
          withColor(props.color ? palette.negative : undefined),
          terminalSafe(props.error),
        ),
    createElement(
      Text,
      withColor(muted),
      connect
        ? 'Equivalent preview: skill-sync init <repository-url> --dry-run'
        : 'Equivalent preview: skill-sync init --create <owner/name> --dry-run',
    ),
    createElement(
      Text,
      withColor(muted),
      connect
        ? 'Enter review · Esc back'
        : 'Enter review · Esc back · Run gh auth login first if needed',
    ),
  );
}

function addLocationLabel(item: TuiAddLocationItem, currentGroup: string): string {
  if (item.kind === 'save') return `Save in ${currentGroup === '' ? 'library root' : currentGroup}`;
  if (item.kind === 'parent')
    return `.. Back to ${item.group === '' ? 'library root' : item.group}`;
  if (item.kind === 'add-folder') return '+ Add folder';
  const name = item.group.split('/').at(-1) ?? item.group;
  return `${name}/ ${item.pending ? '[new]' : ''}`.trimEnd();
}

export function TuiAddLocationBrowser(props: {
  readonly color: boolean;
  readonly currentGroup: string;
  readonly cursor: number;
  readonly entry: TuiInventorySkill | undefined;
  readonly window: TuiItemWindow<TuiAddLocationItem>;
}): ReactElement {
  const muted = props.color ? palette.muted : undefined;
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, { bold: props.color }, 'Choose library location'),
    createElement(
      Text,
      null,
      props.entry === undefined
        ? 'No unmanaged skill is selected.'
        : `Local skill: ${props.entry.target} · ${props.entry.path}`,
    ),
    createElement(Text, null, `Location: ${props.currentGroup || 'library root'}`),
    ...props.window.items.map((item, offset) => {
      const index = props.window.start + offset;
      return createElement(
        Text,
        {
          key: `${item.kind}:${'group' in item ? item.group : ''}`,
          ...withColor(props.cursor === index && props.color ? palette.accent : undefined),
        },
        `${props.cursor === index ? '❯' : ' '} ${addLocationLabel(item, props.currentGroup)}`,
      );
    }),
    createElement(TuiWindowIndicator, { color: props.color, window: props.window }),
    createElement(Text, withColor(muted), '↑↓ move · Enter choose · Esc parent/cancel'),
  );
}

export function TuiAddFolderForm(props: {
  readonly color: boolean;
  readonly currentGroup: string;
  readonly error: string | undefined;
  readonly input: string;
}): ReactElement {
  const muted = props.color ? palette.muted : undefined;
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, { bold: props.color }, 'Add folder'),
    createElement(Text, null, `Inside: ${props.currentGroup || 'library root'}`),
    createElement(Text, null, `Folder name: ${terminalSafe(props.input) || '▏'}`),
    props.error === undefined
      ? null
      : createElement(
          Text,
          withColor(props.color ? palette.negative : undefined),
          terminalSafe(props.error),
        ),
    createElement(
      Text,
      withColor(muted),
      'Use one portable folder name, such as openspec or code-review.',
    ),
    createElement(Text, withColor(muted), 'Enter create and open · Esc location'),
  );
}

export function TuiAddReview(props: {
  readonly color: boolean;
  readonly entry: TuiInventorySkill | undefined;
  readonly preview: TuiLibraryAddPreview;
}): ReactElement {
  const muted = props.color ? palette.muted : undefined;
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, { bold: props.color }, 'Review add to library'),
    createElement(Text, null, `Local source: ${props.entry?.path ?? 'unknown'}`),
    createElement(Text, null, `Canonical skill: ${props.preview.id}`),
    createElement(Text, null, `Content digest: ${props.preview.digest}`),
    createElement(
      Text,
      withColor(props.color ? palette.warning : undefined),
      'This will commit and push the local skill to the Git library, then track this existing local copy.',
    ),
    createElement(Text, withColor(muted), 'y add and track · Esc change location'),
  );
}

export function TuiSetupReview(props: {
  readonly color: boolean;
  readonly plan: TuiLibraryInitPlan;
}): ReactElement {
  const muted = props.color ? palette.muted : undefined;
  const warning = props.color ? palette.warning : undefined;
  const { plan } = props;
  const title =
    plan.action === 'connect'
      ? 'Review library connection'
      : plan.action === 'create'
        ? 'Review GitHub library creation'
        : 'Review empty remote initialization';
  const effects = [
    plan.effects.githubRepository === 'create' ? 'Create the GitHub repository' : undefined,
    plan.effects.remoteLibrary === 'initialize'
      ? 'Initialize an empty library with no skills'
      : undefined,
    plan.effects.remoteLibrary === 'initialize' ? 'Push the initial library commit' : undefined,
    'Refresh the local library cache',
    plan.configurationChanged
      ? 'Save it as the user-wide default library'
      : 'Keep the already-matching user configuration',
  ].filter((effect): effect is string => effect !== undefined);
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, { bold: props.color }, title),
    createElement(Text, null, `Remote: ${terminalSafe(plan.remote.identity)}`),
    createElement(Text, null, `URL: ${terminalSafe(plan.remote.cloneUrl)}`),
    createElement(Text, null, `Branch: ${terminalSafe(plan.branch)}`),
    plan.revision === null
      ? null
      : createElement(Text, null, `Revision: ${terminalSafe(plan.revision)}`),
    plan.visibility === null
      ? null
      : createElement(
          Text,
          null,
          `Visibility: ${plan.visibility} · Transport: ${plan.remote.transport.toUpperCase()}`,
        ),
    plan.validation === null
      ? null
      : createElement(
          Text,
          withColor(muted),
          `Validated: ${String(plan.validation.skills)} skill(s), ${String(plan.validation.groups)} group(s)`,
        ),
    createElement(Text, { bold: props.color }, 'Exact effects:'),
    ...effects.map((effect) => createElement(Text, { key: effect }, `  ${effect}`)),
    plan.effects.githubRepository === 'create' || plan.effects.remoteLibrary === 'initialize'
      ? createElement(
          Text,
          withColor(warning),
          'Warning: this creates content on a remote Git provider.',
        )
      : createElement(Text, withColor(muted), 'Existing remote content will not be changed.'),
    plan.effects.githubRepository === 'create'
      ? createElement(
          Text,
          withColor(warning),
          'If a later step fails, the repository may remain; inspect it with GitHub before retrying or deleting it.',
        )
      : null,
    createElement(Text, withColor(muted), `Plan: ${terminalSafe(plan.fingerprint)}`),
    createElement(Text, withColor(muted), 'y apply · Esc edit'),
  );
}

export function TuiCatalogEmptyState(props: {
  readonly color: boolean;
  readonly filtered: boolean;
}): ReactElement {
  return createElement(
    Text,
    withColor(props.color ? (props.filtered ? palette.muted : palette.warning) : undefined),
    props.filtered
      ? 'No skills match the current search and group filter.'
      : 'This library has no skills yet. Open Unmanaged inventory to add an on-disk skill, or run skill-sync add <path> --dry-run.',
  );
}

function doctorIssueLabel(issue: TuiDoctorIssue): string {
  return issue.id.replaceAll('-', ' ');
}

function doctorIssueStatus(issue: TuiDoctorIssue): string {
  if (issue.status === 'fail') return 'FAIL';
  if (issue.status === 'warning') return 'WARN';
  return 'SKIP';
}

function doctorIssueColor(issue: TuiDoctorIssue): string {
  if (issue.status === 'fail') return palette.negative;
  if (issue.status === 'warning') return palette.warning;
  return palette.muted;
}

export function TuiSetupDiagnostics(props: {
  readonly color: boolean;
  readonly columns: number;
  readonly cursor: number;
  readonly error?: string;
  readonly rows: number;
  readonly summary?: TuiDoctorSummary;
}): ReactElement {
  const muted = props.color ? palette.muted : undefined;
  const issueWindow = windowTuiItems(
    props.summary?.issues ?? [],
    props.cursor,
    tuiDiagnosticIssueLimit(props.rows),
  );
  const counts = props.summary?.counts;
  const compactHeight = props.rows < 16;
  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(Text, { bold: props.color }, 'Setup diagnostics'),
    counts === undefined
      ? null
      : createElement(
          Text,
          withColor(
            props.color
              ? counts.fail > 0
                ? palette.negative
                : counts.warning > 0
                  ? palette.warning
                  : palette.positive
              : undefined,
          ),
          `Pass ${String(counts.pass)} · Warning ${String(counts.warning)} · Fail ${String(counts.fail)}${counts.skipped > 0 ? ` · Skipped ${String(counts.skipped)}` : ''}`,
        ),
    props.summary === undefined || compactHeight
      ? null
      : createElement(
          Text,
          withColor(muted),
          `Scope: ${props.summary.scope}${props.summary.location === undefined ? '' : ` (${boundedTerminalLine(props.summary.location, props.columns, 9)})`} · Remote checks: ${props.summary.offline ? 'skipped' : 'included'}`,
        ),
    props.error === undefined
      ? null
      : createElement(
          Text,
          withColor(props.color ? palette.negative : undefined),
          boundedTerminalLine(props.error, props.columns),
        ),
    props.summary?.issues.length === 0
      ? createElement(
          Text,
          withColor(props.color ? palette.positive : undefined),
          'No diagnostic action is required.',
        )
      : null,
    ...issueWindow.items.flatMap((issue, offset) => {
      const index = issueWindow.start + offset;
      const remote = issue.scope === 'remote' ? ' · remote' : '';
      return [
        createElement(
          Text,
          {
            key: `${issue.id}:message`,
            ...withColor(props.color ? doctorIssueColor(issue) : undefined),
          },
          `${props.cursor === index ? '❯' : ' '} ${doctorIssueStatus(issue)} · ${doctorIssueLabel(issue)}${remote}: ${boundedTerminalLine(issue.message, props.columns, 4)}`,
        ),
        createElement(
          Text,
          { key: `${issue.id}:remediation`, ...withColor(muted) },
          `    Next: ${boundedTerminalLine(issue.remediation, props.columns, 10)}`,
        ),
      ];
    }),
    createElement(TuiWindowIndicator, { color: props.color, window: issueWindow }),
    createElement(
      Text,
      withColor(muted),
      `${issueWindow.total > 1 ? '↑↓ issues · ' : ''}r run again · Enter/Esc back`,
    ),
  );
}

export function TuiSetupGuide(props: { readonly color: boolean }): ReactElement {
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, { bold: props.color }, 'Setup guide'),
    createElement(
      Text,
      null,
      'Open this wiki URL in your browser for installation, library setup, and first-skill instructions:',
    ),
    createElement(Text, null, TUI_SETUP_GUIDE_URL),
    createElement(Text, withColor(props.color ? palette.muted : undefined), 'Enter/Esc back'),
  );
}

export function TuiInstallPreviewReview(props: {
  readonly color: boolean;
  readonly limits?: TuiInstallReviewLimits;
  readonly preview: TuiInstallPreview;
}): ReactElement {
  const muted = props.color ? palette.muted : undefined;
  const safe = terminalSafe;
  const { preview } = props;
  const limits = props.limits ?? {
    destinations: Number.POSITIVE_INFINITY,
    writes: Number.POSITIVE_INFINITY,
  };
  const destinations = preview.skills.flatMap((skill) =>
    skill.projections.map((projection) => ({
      key: `${skill.id}:${projection.target}:${projection.destination}`,
      text: `${safe(skill.id)} [${safe(skill.status)}; digest ${safe(skill.digest.slice(0, 12))}…] · ${safe(projection.target)} → ${safe(projection.destination)} · ${projection.write ? 'write' : 'no write'}`,
    })),
  );
  const visibleDestinations = destinations.slice(0, limits.destinations);
  const visibleWrites = preview.writes.slice(0, limits.writes);
  const gitignore = preview.gitignore.applicable
    ? preview.gitignore.changed
      ? `Gitignore file: would update ${safe(preview.gitignore.path)}`
      : `Gitignore file: no content change (${safe(preview.gitignore.path)})`
    : 'Gitignore file: not applicable to global installs';
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, null, `Scope: ${preview.scope} (${safe(preview.location)})`),
    createElement(Text, null, `Library revision: ${safe(preview.libraryRevision)}`),
    createElement(Text, null, `Reviewed plan: ${safe(preview.fingerprint)}`),
    createElement(
      Text,
      withColor(props.color && preview.stale ? palette.warning : undefined),
      `Freshness: ${safe(preview.freshness)} · ${preview.stale ? 'stale' : 'current'}`,
    ),
    preview.stale
      ? createElement(
          Text,
          withColor(props.color ? palette.warning : undefined),
          'Warning: this review uses cached library data. Apply refreshes it and stops if the plan changed.',
        )
      : null,
    createElement(
      Text,
      null,
      `Manifest state: ${preview.state.manifestChanged ? 'would update' : 'no change'}`,
    ),
    createElement(
      Text,
      null,
      `Lock state: ${preview.state.lockChanged ? 'would update' : 'no change'}`,
    ),
    createElement(Text, null, gitignore),
    createElement(Text, { bold: props.color }, 'Skill destinations:'),
    ...visibleDestinations.map((destination) =>
      createElement(Text, { key: destination.key }, `  ${destination.text}`),
    ),
    destinations.length > visibleDestinations.length
      ? createElement(
          Text,
          withColor(muted),
          `  … ${String(destinations.length - visibleDestinations.length)} more destinations omitted for this terminal`,
        )
      : null,
    createElement(Text, { bold: props.color }, 'Exact planned writes:'),
    ...(preview.writes.length === 0
      ? [createElement(Text, { key: 'none', ...withColor(muted) }, '  none')]
      : visibleWrites.map((write) => createElement(Text, { key: write }, `  ${safe(write)}`))),
    preview.writes.length > visibleWrites.length
      ? createElement(
          Text,
          withColor(muted),
          `  … ${String(preview.writes.length - visibleWrites.length)} more writes omitted for this terminal`,
        )
      : null,
  );
}

export function TuiLibraryRemoveReview(props: {
  readonly color: boolean;
  readonly preview: TuiLibraryRemovePreview;
}): ReactElement {
  const muted = props.color ? palette.muted : undefined;
  return createElement(
    Box,
    { flexDirection: 'column', gap: 1 },
    createElement(Text, { bold: props.color }, 'Review canonical skill removal'),
    createElement(Text, null, `Skill: ${terminalSafe(props.preview.id)}`),
    createElement(Text, null, `Reviewed library revision: ${terminalSafe(props.preview.revision)}`),
    createElement(
      Text,
      withColor(props.color ? palette.warning : undefined),
      terminalSafe(props.preview.warning),
    ),
    createElement(
      Text,
      null,
      'This will commit and push deletion of the canonical skill. Installed copies are not removed.',
    ),
    createElement(Text, withColor(muted), 'y revalidate and remove · Esc cancel'),
  );
}

export function TuiApp(props: {
  readonly actions: TuiActionPort;
  readonly color: boolean;
  readonly implicit: boolean;
}): ReactElement {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const compact = columns < 78;
  const [dashboard, setDashboard] = useState<TuiDashboard | undefined>();
  const [screen, setScreen] = useState<TuiScreen>('overview');
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [targets, setTargets] = useState<ReadonlySet<string>>(() => new Set(['codex']));
  const [manageGitignore, setManageGitignore] = useState(false);
  const [discardLocal, setDiscardLocal] = useState(false);
  const [adoptionEntry, setAdoptionEntry] = useState<TuiInventorySkill | undefined>();
  const [adoptionSkillId, setAdoptionSkillId] = useState<string | undefined>();
  const [additionEntry, setAdditionEntry] = useState<TuiInventorySkill | undefined>();
  const [additionGroup, setAdditionGroup] = useState('');
  const [additionPendingGroups, setAdditionPendingGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [additionFolderInput, setAdditionFolderInput] = useState('');
  const [additionFolderError, setAdditionFolderError] = useState<string | undefined>();
  const [additionPreview, setAdditionPreview] = useState<TuiLibraryAddPreview | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [setupInput, setSetupInput] = useState('');
  const [setupError, setSetupError] = useState<string | undefined>();
  const [setupPlan, setSetupPlan] = useState<TuiLibraryInitPlan | undefined>();
  const [releaseUpdate, setReleaseUpdate] = useState<TuiReleaseUpdate | undefined>();
  const [installPreview, setInstallPreview] = useState<TuiInstallPreview | undefined>();
  const [libraryRemovePreview, setLibraryRemovePreview] = useState<
    TuiLibraryRemovePreview | undefined
  >();
  const [diagnostics, setDiagnostics] = useState<TuiDoctorSummary | undefined>();
  const [diagnosticsError, setDiagnosticsError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const targetsRef = useRef(targets);
  const manageGitignoreRef = useRef(manageGitignore);
  const installPreviewRef = useRef<TuiInstallPreview | undefined>(undefined);
  const libraryRemovePreviewRef = useRef<TuiLibraryRemovePreview | undefined>(undefined);
  const setupPlanRef = useRef<TuiLibraryInitPlan | undefined>(undefined);
  const setupIntentRef = useRef<TuiLibrarySetupIntent | undefined>(undefined);
  const previewSequence = useRef(0);

  const clearDiagnostics = (): void => {
    setDiagnostics(undefined);
    setDiagnosticsError(undefined);
    setNotice(undefined);
  };

  const reload = async (): Promise<TuiDashboard | undefined> => {
    setBusy(true);
    try {
      const next = await props.actions.load();
      setDashboard(next);
      const nextTargets = new Set(tuiInstallTargetDefaults(next.defaultTargets));
      setTargets(nextTargets);
      targetsRef.current = nextTargets;
      setManageGitignore(next.manageGitignore);
      manageGitignoreRef.current = next.manageGitignore;
      if (next.firstRun) {
        setScreen('first-run');
        setCursor(0);
      } else if (isSetupScreen(screen)) {
        setScreen('overview');
        setCursor(0);
        clearDiagnostics();
      }
      setNotice(next.errors.length === 0 ? undefined : next.errors.join('\n'));
      return next;
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to load the dashboard.'),
      );
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    void props.actions
      .checkForUpdate()
      .then((update) => setReleaseUpdate(update))
      .catch(() => undefined);
  }, []);

  const skills = useMemo(
    () => visibleSkills(dashboard?.skills ?? [], query, activeGroup),
    [activeGroup, dashboard?.skills, query],
  );
  const selectedSkill = skills[cursor];
  const groups = useMemo(
    () =>
      [
        ...new Set(
          (dashboard?.skills ?? []).flatMap((skill) => (skill.group === null ? [] : [skill.group])),
        ),
      ].sort(),
    [dashboard?.skills],
  );
  const eligibleTargets = useMemo(() => {
    const chosenSkills = (dashboard?.skills ?? []).filter((skill) => selected.has(skill.id));
    if (chosenSkills.length === 0) return new Set(['codex', 'claude']);
    return new Set(
      ['codex', 'claude'].filter((target) =>
        chosenSkills.every((skill) => skill.compatibleAgents.includes(target)),
      ),
    );
  }, [dashboard?.skills, selected]);
  const adoptionCandidates = useMemo(() => {
    if (adoptionEntry === undefined) return [];
    const byId = new Map((dashboard?.skills ?? []).map((skill) => [skill.id, skill]));
    return compatibleAdoptionSkillIds(dashboard?.skills ?? [], adoptionEntry.target).flatMap(
      (id) => {
        const skill = byId.get(id);
        return skill === undefined ? [] : [skill];
      },
    );
  }, [adoptionEntry, dashboard?.skills]);
  const selectedAdoptionCandidate = adoptionCandidates[cursor];
  const additionLocationItems = useMemo(
    () => tuiAddLocationItems(dashboard?.groups ?? [], [...additionPendingGroups], additionGroup),
    [additionGroup, additionPendingGroups, dashboard?.groups],
  );
  const selectedAdditionLocation = additionLocationItems[cursor];
  const rowLimit = tuiRowLimit(compact, rows);
  const installReviewLimits = tuiInstallReviewLimits(rows);
  const catalogWindow = windowTuiItems(skills, cursor, rowLimit);
  const managedWindow = windowTuiItems(dashboard?.managed ?? [], cursor, rowLimit);
  const unmanagedWindow = windowTuiItems(dashboard?.inventory ?? [], cursor, rowLimit);
  const adoptionWindow = windowTuiItems(adoptionCandidates, cursor, rowLimit);
  const additionLocationWindow = windowTuiItems(additionLocationItems, cursor, rowLimit);
  const move = (amount: number): void => {
    const nextLength =
      screen === 'catalog'
        ? skills.length
        : screen === 'managed'
          ? (dashboard?.managed.length ?? 0)
          : screen === 'unmanaged'
            ? (dashboard?.inventory.length ?? 0)
            : screen === 'adopt-candidate'
              ? adoptionCandidates.length
              : screen === 'add-location'
                ? additionLocationItems.length
                : screen === 'setup-diagnostics'
                  ? (diagnostics?.issues.length ?? 0)
                  : screen === 'first-run'
                    ? 5
                    : 4;
    setCursor((value) => moveTuiCursor({ cursor: value, screen }, amount, nextLength).cursor);
  };

  const selectedInstallTargets = (nextTargets: ReadonlySet<string>): readonly string[] =>
    [...nextTargets].filter((target) => eligibleTargets.has(target)).sort();

  const refreshInstallPreview = async (
    nextTargets: ReadonlySet<string> = targetsRef.current,
    nextManageGitignore = manageGitignoreRef.current,
  ): Promise<void> => {
    const sequence = ++previewSequence.current;
    const chosenTargets = selectedInstallTargets(nextTargets);
    setInstallPreview(undefined);
    installPreviewRef.current = undefined;
    if (selected.size === 0 || chosenTargets.length === 0) {
      setNotice('Select at least one skill and target to create an install review.');
      return;
    }
    setBusy(true);
    try {
      const result = await props.actions.previewInstall(
        [...selected],
        chosenTargets,
        nextManageGitignore,
      );
      if (sequence !== previewSequence.current) return;
      if (result.ok) {
        setInstallPreview(result.data);
        installPreviewRef.current = result.data;
        setNotice(undefined);
      } else {
        setNotice(operationMessage(result));
      }
    } catch (error) {
      if (sequence === previewSequence.current) {
        setNotice(
          terminalSafe(error instanceof Error ? error.message : 'Unable to preview installation.'),
        );
      }
    } finally {
      if (sequence === previewSequence.current) setBusy(false);
    }
  };

  const openInstallReview = (): void => {
    setScreen('install-review');
    void refreshInstallPreview();
  };

  const install = async (): Promise<void> => {
    const chosenTargets = selectedInstallTargets(targetsRef.current);
    if (selected.size === 0 || chosenTargets.length === 0) {
      setNotice('Select at least one skill and target before installing.');
      return;
    }
    const reviewed = installPreviewRef.current;
    if (reviewed === undefined) {
      setNotice('Create and review the dry-run plan before installing.');
      await refreshInstallPreview();
      return;
    }
    setBusy(true);
    try {
      const outcome = await confirmTuiInstallReview({
        apply: (expectedPlanFingerprint) =>
          props.actions.install(
            [...selected],
            chosenTargets,
            manageGitignoreRef.current,
            expectedPlanFingerprint,
          ),
        preview: () =>
          props.actions.previewInstall([...selected], chosenTargets, manageGitignoreRef.current),
        reviewed,
      });
      if (outcome.kind === 'changed') {
        setInstallPreview(outcome.preview);
        installPreviewRef.current = outcome.preview;
        setNotice('The install plan changed. Review the updated plan and press y again.');
        return;
      }
      if (outcome.kind === 'preview-failed') {
        setNotice(operationMessage(outcome.result));
        return;
      }
      setNotice(operationMessage(outcome.result));
      if (outcome.result.ok) {
        setInstallPreview(undefined);
        installPreviewRef.current = undefined;
        setScreen('overview');
        await reload();
      }
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to install selected skills.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const openLibraryRemoveReview = async (): Promise<void> => {
    if (selectedSkill === undefined) {
      setNotice('Choose a canonical skill before reviewing removal.');
      return;
    }
    const id = selectedSkill.id;
    setLibraryRemovePreview(undefined);
    libraryRemovePreviewRef.current = undefined;
    setNotice(undefined);
    setScreen('library-remove-review');
    setBusy(true);
    try {
      const result = await props.actions.previewLibraryRemove(id);
      if (result.ok) {
        setLibraryRemovePreview(result.data);
        libraryRemovePreviewRef.current = result.data;
      } else {
        setNotice(operationMessage(result));
      }
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to preview skill removal.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const removeLibrarySkill = async (): Promise<void> => {
    const reviewed = libraryRemovePreviewRef.current;
    if (reviewed === undefined) {
      setNotice('Create and review the removal preview before deleting the canonical skill.');
      return;
    }
    setBusy(true);
    try {
      const outcome = await confirmTuiLibraryRemoveReview({
        apply: () => props.actions.removeLibrarySkill(reviewed.id),
        preview: () => props.actions.previewLibraryRemove(reviewed.id),
        reviewed,
      });
      if (outcome.kind === 'changed') {
        setLibraryRemovePreview(outcome.preview);
        libraryRemovePreviewRef.current = outcome.preview;
        setNotice('The library revision changed. Review the updated removal and press y again.');
        return;
      }
      if (outcome.kind === 'preview-failed') {
        setNotice(operationMessage(outcome.result));
        return;
      }
      if (!outcome.result.ok) {
        setNotice(operationMessage(outcome.result));
        return;
      }
      const removedId = reviewed.id;
      setSelected((ids) => {
        const next = new Set(ids);
        next.delete(removedId);
        return next;
      });
      setLibraryRemovePreview(undefined);
      libraryRemovePreviewRef.current = undefined;
      setScreen('catalog');
      setCursor(0);
      await reload();
      setNotice(
        `Removed ${removedId} from the canonical library. Installed copies remain orphaned.`,
      );
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to remove the skill.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const sync = async (): Promise<void> => {
    setBusy(true);
    const result = await props.actions.sync(discardLocal);
    setNotice(operationMessage(result));
    setBusy(false);
    setScreen('managed');
    if (result.ok) await reload();
  };

  const adopt = async (): Promise<void> => {
    if (adoptionEntry === undefined || adoptionSkillId === undefined) {
      setNotice('Choose an unmanaged entry and an exact canonical skill ID before adoption.');
      return;
    }
    setBusy(true);
    const result = await props.actions.adopt(adoptionSkillId, adoptionEntry.target);
    setNotice(operationMessage(result));
    setBusy(false);
    if (result.ok) {
      setScreen('unmanaged');
      setCursor(0);
      setAdoptionEntry(undefined);
      setAdoptionSkillId(undefined);
      await reload();
    }
  };

  const reviewAdd = async (): Promise<void> => {
    if (additionEntry === undefined) {
      setNotice('Choose an unmanaged skill before adding it to the library.');
      return;
    }
    setBusy(true);
    try {
      const result = await props.actions.previewAdd(additionEntry.path, additionGroup.trim());
      if (!result.ok) {
        setNotice(operationMessage(result));
        return;
      }
      setAdditionGroup(additionGroup.trim());
      setAdditionPreview(result.data);
      setNotice(undefined);
      setScreen('add-review');
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to preview library add.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const createAndOpenAdditionFolder = (): void => {
    const validation = validateTuiFolderName(additionFolderInput);
    if (!validation.ok) {
      setAdditionFolderError(validation.error);
      return;
    }
    const nextGroup =
      additionGroup === '' ? validation.value : `${additionGroup}/${validation.value}`;
    if ((dashboard?.groups ?? []).includes(nextGroup) || additionPendingGroups.has(nextGroup)) {
      setAdditionFolderError(`The folder ${nextGroup} already exists. Choose it from the list.`);
      return;
    }
    setAdditionPendingGroups((groups) => new Set([...groups, nextGroup]));
    setAdditionGroup(nextGroup);
    setAdditionFolderInput('');
    setAdditionFolderError(undefined);
    setCursor(0);
    setScreen('add-location');
  };

  const addAndTrack = async (): Promise<void> => {
    if (additionEntry === undefined || additionPreview === undefined) {
      setNotice('Preview the library add before applying it.');
      return;
    }
    setBusy(true);
    try {
      const added = await props.actions.add(additionEntry.path, additionGroup);
      if (!added.ok) {
        setNotice(operationMessage(added));
        return;
      }
      const adopted = await props.actions.adopt(additionPreview.id, additionEntry.target);
      if (!adopted.ok) {
        const addedId = additionPreview.id;
        setAdditionEntry(undefined);
        setAdditionGroup('');
        setAdditionPendingGroups(new Set());
        setAdditionPreview(undefined);
        setScreen('unmanaged');
        setCursor(0);
        await reload();
        setNotice(
          `Added ${addedId} to the library, but tracking the local copy failed. Press d to retry adoption.\n${operationMessage(adopted)}`,
        );
        return;
      }
      setAdditionEntry(undefined);
      setAdditionGroup('');
      setAdditionPendingGroups(new Set());
      setAdditionPreview(undefined);
      setScreen('unmanaged');
      setCursor(0);
      await reload();
      setNotice(`Added ${additionPreview.id} to the library and started tracking the local copy.`);
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to add the local skill.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const reviewLibrarySetup = async (kind: TuiSetupInputKind): Promise<void> => {
    const validation = validateTuiSetupInput(kind, setupInput);
    if (!validation.ok) {
      setSetupError(validation.error);
      setNotice(undefined);
      return;
    }
    const intent: TuiLibrarySetupIntent = { kind, value: validation.value };
    setSetupInput(validation.value);
    setSetupError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const result = await props.actions.previewLibrarySetup(intent);
      if (!result.ok) {
        setNotice(operationMessage(result));
        return;
      }
      setupIntentRef.current = intent;
      setupPlanRef.current = result.data;
      setSetupPlan(result.data);
      setScreen(tuiSetupReviewScreen(kind));
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to preview library setup.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const applyLibrarySetup = async (): Promise<void> => {
    const reviewed = setupPlanRef.current;
    const intent = setupIntentRef.current;
    if (reviewed === undefined || intent === undefined) {
      setNotice('Create and review the setup plan before applying it.');
      return;
    }
    setBusy(true);
    try {
      const outcome = await confirmTuiSetupReview({
        apply: (expectedPlanFingerprint) =>
          props.actions.applyLibrarySetup(intent, expectedPlanFingerprint),
        preview: () => props.actions.previewLibrarySetup(intent),
        reviewed,
      });
      if (outcome.kind === 'changed') {
        setSetupPlan(outcome.plan);
        setupPlanRef.current = outcome.plan;
        setNotice('The setup plan changed. Review the updated plan and press y again.');
        return;
      }
      if (outcome.kind === 'preview-failed') {
        setNotice(operationMessage(outcome.result));
        return;
      }
      setNotice(operationMessage(outcome.result));
      if (!outcome.result.ok) return;
      const completedAction = reviewed.action;
      setSetupInput('');
      setSetupError(undefined);
      setSetupPlan(undefined);
      setupPlanRef.current = undefined;
      setupIntentRef.current = undefined;
      const next = await reload();
      if (next !== undefined && !next.firstRun && next.errors.length === 0) {
        const completion = tuiSetupCompletion(completedAction, next.skills.length);
        setScreen(completion.screen);
        setCursor(0);
        setNotice(completion.notice);
      } else if (next?.firstRun === true) {
        setNotice('The library is still unavailable. Run diagnostics for the next safe action.');
      }
    } catch (error) {
      setNotice(
        terminalSafe(error instanceof Error ? error.message : 'Unable to apply library setup.'),
      );
    } finally {
      setBusy(false);
    }
  };

  const diagnose = async (): Promise<void> => {
    setScreen('setup-diagnostics');
    setCursor(0);
    setNotice(undefined);
    setDiagnostics(undefined);
    setDiagnosticsError(undefined);
    setBusy(true);
    try {
      const result = await props.actions.diagnose();
      if (result.ok) setDiagnostics(result.data);
      else setDiagnosticsError(operationMessage(result));
    } catch (error) {
      setDiagnosticsError(
        terminalSafe(error instanceof Error ? error.message : 'Unable to run setup diagnostics.'),
      );
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) return;
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (screen === 'setup-connect' || screen === 'setup-create') {
      if (key.escape) {
        setScreen('first-run');
        setCursor(0);
        setSetupInput('');
        setSetupError(undefined);
        setNotice(undefined);
        return;
      }
      if (key.return) {
        void reviewLibrarySetup(screen === 'setup-connect' ? 'connect' : 'create');
        return;
      }
      if (key.backspace || key.delete) {
        setSetupInput((value) => value.slice(0, -1));
        setSetupError(undefined);
        setNotice(undefined);
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        setSetupInput((value) => value + terminalSafe(input));
        setSetupError(undefined);
        setNotice(undefined);
      }
      return;
    }
    if (screen === 'add-folder-name') {
      if (key.escape) {
        setScreen('add-location');
        setCursor(0);
        setAdditionFolderInput('');
        setAdditionFolderError(undefined);
        setNotice(undefined);
        return;
      }
      if (key.return) {
        createAndOpenAdditionFolder();
        return;
      }
      if (key.backspace || key.delete) {
        setAdditionFolderInput((value) => value.slice(0, -1));
        setAdditionFolderError(undefined);
        setNotice(undefined);
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        setAdditionFolderInput((value) => value + terminalSafe(input));
        setAdditionFolderError(undefined);
        setNotice(undefined);
      }
      return;
    }
    if (screen === 'add-location' && key.escape) {
      if (additionGroup !== '') {
        setAdditionGroup(tuiGroupParent(additionGroup));
        setCursor(0);
      } else {
        setScreen('unmanaged');
        setCursor(0);
        setAdditionEntry(undefined);
        setAdditionPendingGroups(new Set());
        setAdditionPreview(undefined);
        setNotice(undefined);
      }
      return;
    }
    if (input === 'q') {
      exit();
      return;
    }
    if (key.upArrow) {
      move(-1);
      return;
    }
    if (key.downArrow) {
      move(1);
      return;
    }
    if (key.escape) {
      const destination = backFromTuiScreen(screen);
      if (destination === 'quit') exit();
      else {
        if (screen === 'install-review') {
          previewSequence.current += 1;
          setInstallPreview(undefined);
          installPreviewRef.current = undefined;
        }
        if (screen === 'library-remove-review') {
          setLibraryRemovePreview(undefined);
          libraryRemovePreviewRef.current = undefined;
        }
        if (screen === 'setup-connect-review' || screen === 'setup-create-review') {
          setSetupPlan(undefined);
          setupPlanRef.current = undefined;
          setupIntentRef.current = undefined;
        }
        if (screen === 'add-review') setAdditionPreview(undefined);
        if (screen === 'setup-diagnostics') clearDiagnostics();
        setScreen(destination);
        setCursor(0);
      }
      return;
    }
    if (input === 'r') {
      if (screen === 'setup-diagnostics') {
        void diagnose();
        return;
      }
      void reload();
      return;
    }
    if (screen === 'first-run' && key.return) {
      const destination = firstRunDestination(cursor);
      if (destination === 'quit') {
        exit();
      } else if (destination === 'setup-diagnostics') {
        void diagnose();
      } else {
        setScreen(destination);
        setSetupInput('');
        setSetupError(undefined);
        clearDiagnostics();
      }
      setCursor(0);
      return;
    }
    if ((screen === 'setup-diagnostics' || screen === 'setup-guide') && key.return) {
      if (screen === 'setup-diagnostics') clearDiagnostics();
      setScreen('first-run');
      setCursor(0);
      if (screen === 'setup-guide') setNotice(undefined);
      return;
    }
    if (screen === 'setup-connect-review' || screen === 'setup-create-review') {
      if (input === 'y') void applyLibrarySetup();
      return;
    }
    if (screen === 'overview' && key.return) {
      const destination = overviewDestination(cursor);
      if (destination === 'quit') exit();
      else setScreen(destination);
      setCursor(0);
      return;
    }
    if (screen === 'catalog') {
      if (key.return && selectedSkill !== undefined) {
        setScreen('detail');
        return;
      }
      if (input === ' ') {
        if (selectedSkill === undefined) return;
        setSelected((value) => {
          const next = new Set(value);
          if (next.has(selectedSkill.id)) next.delete(selectedSkill.id);
          else next.add(selectedSkill.id);
          return next;
        });
        return;
      }
      if (input === 'i') {
        openInstallReview();
        return;
      }
      if (input === 'x') {
        void openLibraryRemoveReview();
        return;
      }
      if (input === 'g') {
        setActiveGroup((value) => {
          const index = value === null ? -1 : groups.indexOf(value);
          return index >= groups.length - 1 ? null : (groups[index + 1] ?? null);
        });
        setCursor(0);
        return;
      }
      if (key.backspace) {
        setQuery((value) => value.slice(0, -1));
        setCursor(0);
        return;
      }
      if (!key.ctrl && !key.meta && input.length === 1 && input !== ' ') {
        setQuery((value) => value + terminalSafe(input));
        setCursor(0);
      }
      return;
    }
    if (screen === 'detail') {
      if (input === ' ') {
        if (selectedSkill === undefined) return;
        setSelected((value) => {
          const next = new Set(value);
          if (next.has(selectedSkill.id)) next.delete(selectedSkill.id);
          else next.add(selectedSkill.id);
          return next;
        });
        return;
      }
      if (input === 'i') openInstallReview();
      if (input === 'x') void openLibraryRemoveReview();
      return;
    }
    if (screen === 'install-review') {
      if (input === '1' || input === '2') {
        const target = input === '1' ? 'codex' : 'claude';
        if (!eligibleTargets.has(target)) return;
        const next = new Set(targetsRef.current);
        if (next.has(target)) next.delete(target);
        else next.add(target);
        setTargets(next);
        targetsRef.current = next;
        void refreshInstallPreview(next, manageGitignoreRef.current);
        return;
      }
      if (input === 'g') {
        if (dashboard?.scope !== 'global') {
          const next = !manageGitignoreRef.current;
          setManageGitignore(next);
          manageGitignoreRef.current = next;
          void refreshInstallPreview(targetsRef.current, next);
        }
        return;
      }
      if (input === 'y') void install();
      return;
    }
    if (screen === 'library-remove-review') {
      if (input === 'y') void removeLibrarySkill();
      return;
    }
    if (screen === 'managed') {
      if (input === 's') setScreen('sync-review');
      return;
    }
    if (screen === 'sync-review') {
      if (input === 'd') setDiscardLocal((value) => !value);
      if (input === 'y') void sync();
      return;
    }
    if (screen === 'unmanaged') {
      if (key.return || input === 'a' || input === 'd') {
        const entry = dashboard?.inventory[cursor];
        if (entry === undefined) return;
        if (!entry.adoptable) {
          setNotice(
            entry.issues.length > 0
              ? entry.issues.join('\n')
              : `${entry.name} cannot be changed until its selected-scope state is reliable.`,
          );
          return;
        }
        if (key.return || input === 'a') {
          setAdditionEntry(entry);
          setAdditionGroup('');
          setAdditionPendingGroups(new Set());
          setAdditionFolderInput('');
          setAdditionFolderError(undefined);
          setAdditionPreview(undefined);
          setNotice(undefined);
          setCursor(0);
          setScreen('add-location');
          return;
        }
        setAdoptionEntry(entry);
        setAdoptionSkillId(undefined);
        setCursor(0);
        setScreen('adopt-candidate');
      }
      return;
    }
    if (screen === 'adopt-candidate') {
      if (key.return && selectedAdoptionCandidate !== undefined) {
        setAdoptionSkillId(selectedAdoptionCandidate.id);
        setScreen('adopt-review');
      }
      return;
    }
    if (screen === 'add-location') {
      if (!key.return || selectedAdditionLocation === undefined) return;
      if (selectedAdditionLocation.kind === 'save') {
        void reviewAdd();
        return;
      }
      if (selectedAdditionLocation.kind === 'add-folder') {
        setAdditionFolderInput('');
        setAdditionFolderError(undefined);
        setScreen('add-folder-name');
        return;
      }
      setAdditionGroup(selectedAdditionLocation.group);
      setCursor(0);
      return;
    }
    if (screen === 'add-review') {
      if (input === 'y') void addAndTrack();
      return;
    }
    if (input === 'y') {
      void adopt();
    }
  });

  const muted = props.color ? palette.muted : undefined;
  const content = (() => {
    if (dashboard === undefined) {
      return createElement(Text, withColor(muted), 'Loading your skill library…');
    }
    if (screen === 'first-run') {
      return createElement(TuiFirstRunMenu, { color: props.color, cursor });
    }
    if (screen === 'setup-connect') {
      return createElement(TuiSetupForm, {
        color: props.color,
        input: setupInput,
        kind: 'connect',
        ...(setupError === undefined ? {} : { error: setupError }),
      });
    }
    if (screen === 'add-location') {
      return createElement(TuiAddLocationBrowser, {
        color: props.color,
        currentGroup: additionGroup,
        cursor,
        entry: additionEntry,
        window: additionLocationWindow,
      });
    }
    if (screen === 'add-folder-name') {
      return createElement(TuiAddFolderForm, {
        color: props.color,
        currentGroup: additionGroup,
        error: additionFolderError,
        input: additionFolderInput,
      });
    }
    if (screen === 'add-review') {
      return additionPreview === undefined
        ? createElement(Text, withColor(muted), 'Preparing the add review…')
        : createElement(TuiAddReview, {
            color: props.color,
            entry: additionEntry,
            preview: additionPreview,
          });
    }
    if (screen === 'setup-connect-review') {
      return setupPlan === undefined
        ? createElement(Text, withColor(muted), 'Preparing the setup review…')
        : createElement(TuiSetupReview, { color: props.color, plan: setupPlan });
    }
    if (screen === 'setup-create') {
      return createElement(TuiSetupForm, {
        color: props.color,
        input: setupInput,
        kind: 'create',
        ...(setupError === undefined ? {} : { error: setupError }),
      });
    }
    if (screen === 'setup-create-review') {
      return setupPlan === undefined
        ? createElement(Text, withColor(muted), 'Preparing the setup review…')
        : createElement(TuiSetupReview, { color: props.color, plan: setupPlan });
    }
    if (screen === 'setup-diagnostics') {
      return createElement(TuiSetupDiagnostics, {
        color: props.color,
        columns,
        cursor,
        ...(diagnosticsError === undefined ? {} : { error: diagnosticsError }),
        rows,
        ...(diagnostics === undefined ? {} : { summary: diagnostics }),
      });
    }
    if (screen === 'setup-guide') {
      return createElement(TuiSetupGuide, { color: props.color });
    }
    if (screen === 'overview') {
      const items = [
        `Browse library (${String(dashboard.skills.length)} skills)`,
        `Managed skills (${String(dashboard.managed.length)})`,
        `Unmanaged inventory (${String(dashboard.inventory.filter((item) => item.status === 'unmanaged').length)})`,
        'Quit',
      ];
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'What would you like to do?'),
        ...items.map((item, index) =>
          createElement(
            Text,
            {
              key: item,
              ...withColor(cursor === index && props.color ? palette.accent : undefined),
            },
            `${cursor === index ? '❯' : ' '} ${item}`,
          ),
        ),
        createElement(Text, withColor(muted), '↑↓ move · Enter open · r refresh · q quit'),
      );
    }
    if (screen === 'catalog') {
      const group = (skill: TuiSkill): string => skill.group ?? 'root';
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Library browser'),
        createElement(
          Text,
          withColor(muted),
          `Group: ${activeGroup ?? 'all'} · Search: ${query || 'all skills'} · ${String(selected.size)} selected`,
        ),
        skills.length === 0
          ? createElement(TuiCatalogEmptyState, {
              color: props.color,
              filtered: dashboard.skills.length > 0,
            })
          : null,
        ...catalogWindow.items.map((skill, offset) => {
          const index = catalogWindow.start + offset;
          return createElement(
            Text,
            {
              key: skill.id,
              ...withColor(cursor === index && props.color ? palette.accent : undefined),
            },
            `${cursor === index ? '❯' : ' '} ${selected.has(skill.id) ? '◉' : '○'} ${skill.id} · ${group(skill)} · ${skill.description} [${skill.installationState}]`,
          );
        }),
        createElement(TuiWindowIndicator, { color: props.color, window: catalogWindow }),
        createElement(
          Text,
          withColor(muted),
          dashboard.skills.length === 0
            ? 'r refresh · Esc back · q quit'
            : '↑↓ move · g group · Type search · Space toggle · Enter details · i install · x remove · Esc back',
        ),
      );
    }
    if (screen === 'detail') {
      if (selectedSkill === undefined) {
        return createElement(
          Text,
          withColor(muted),
          'No skill is selected. Press Esc to return to the catalog.',
        );
      }
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, selectedSkill.id),
        createElement(Text, null, selectedSkill.description),
        createElement(Text, null, `Group: ${selectedSkill.group ?? 'root'}`),
        createElement(
          Text,
          null,
          `Compatible targets: ${selectedSkill.compatibleAgents.join(', ') || 'none declared'}`,
        ),
        createElement(StatusBadge, { color: props.color, state: selectedSkill.installationState }),
        createElement(
          Text,
          withColor(muted),
          'Space toggle selection · i review install · x remove from library · Esc catalog',
        ),
      );
    }
    if (screen === 'install-review') {
      return createElement(
        Box,
        { flexDirection: 'column' },
        createElement(Text, { bold: props.color }, 'Review installation'),
        createElement(Text, null, `Skills: ${[...selected].join(', ') || 'none selected'}`),
        createElement(
          Text,
          null,
          `Targets: 1 ${targets.has('codex') ? '◉' : '○'} Codex${eligibleTargets.has('codex') ? '' : ' (incompatible)'}   2 ${targets.has('claude') ? '◉' : '○'} Claude${eligibleTargets.has('claude') ? '' : ' (incompatible)'}`,
        ),
        createElement(TuiGitignorePolicy, {
          applicable: dashboard.scope !== 'global',
          color: props.color,
          managed: manageGitignore,
        }),
        createElement(
          Text,
          withColor(props.color ? palette.warning : undefined),
          'No files change until you confirm.',
        ),
        createElement(
          Text,
          withColor(muted),
          dashboard.scope === 'global'
            ? '1/2 toggle targets · y revalidate and install · Esc cancel'
            : '1/2 toggle targets · g toggle .gitignore · y revalidate and install · Esc cancel',
        ),
        installPreview === undefined
          ? createElement(
              Text,
              withColor(props.color ? palette.warning : undefined),
              'No current dry-run plan is available. Change an option or press y to retry.',
            )
          : createElement(TuiInstallPreviewReview, {
              color: props.color,
              limits: installReviewLimits,
              preview: installPreview,
            }),
      );
    }
    if (screen === 'library-remove-review') {
      return libraryRemovePreview === undefined
        ? createElement(Text, withColor(muted), 'Preparing the removal review…')
        : createElement(TuiLibraryRemoveReview, {
            color: props.color,
            preview: libraryRemovePreview,
          });
    }
    if (screen === 'managed') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Managed skills'),
        ...(dashboard.managed.length === 0
          ? [
              createElement(
                Text,
                { key: 'empty', ...withColor(muted) },
                'No managed skills in this scope.',
              ),
            ]
          : managedWindow.items.map((skill, offset) => {
              const index = managedWindow.start + offset;
              return createElement(
                Text,
                {
                  key: skill.id,
                  ...withColor(cursor === index && props.color ? palette.accent : undefined),
                },
                `${cursor === index ? '❯' : ' '} ${skill.id} `,
                createElement(StatusBadge, { color: props.color, state: skill.state }),
              );
            })),
        createElement(TuiWindowIndicator, { color: props.color, window: managedWindow }),
        createElement(Text, withColor(muted), '↑↓ move · s review sync · r refresh · Esc back'),
      );
    }
    if (screen === 'sync-review') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Review synchronization'),
        createElement(
          Text,
          null,
          'The existing reconciliation safeguards will check every tracked skill.',
        ),
        createElement(
          Text,
          withColor(props.color && discardLocal ? palette.warning : undefined),
          `d ${discardLocal ? '◉' : '○'} Allow discard-local (requires backup and confirmation)`,
        ),
        createElement(Text, withColor(muted), 'y sync · d toggle discard-local · Esc cancel'),
      );
    }
    if (screen === 'unmanaged') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Unmanaged skill inventory'),
        ...(dashboard.inventory.length === 0
          ? [
              createElement(
                Text,
                { key: 'empty', ...withColor(muted) },
                'No on-disk skills found in supported target roots.',
              ),
            ]
          : unmanagedWindow.items.map((skill, offset) => {
              const index = unmanagedWindow.start + offset;
              return createElement(
                Text,
                {
                  key: `${skill.target}:${skill.path}`,
                  ...withColor(cursor === index && props.color ? palette.accent : undefined),
                },
                `${cursor === index ? '❯' : ' '} ${skill.target} · ${skill.name} `,
                createElement(StatusBadge, { color: props.color, state: skill.status }),
                skill.adoptable ? ' · [actionable]' : ' · [read-only]',
                ` · ${skill.path}`,
              );
            })),
        createElement(TuiWindowIndicator, { color: props.color, window: unmanagedWindow }),
        ...dashboard.inventoryIssues.map((issue) =>
          createElement(
            Text,
            { key: issue, ...withColor(props.color ? palette.warning : undefined) },
            issue,
          ),
        ),
        createElement(
          Text,
          withColor(muted),
          '↑↓ move · Enter/a add to library · d adopt existing · r refresh · Esc back',
        ),
      );
    }
    if (screen === 'adopt-candidate') {
      return createElement(
        Box,
        { flexDirection: 'column', gap: 1 },
        createElement(Text, { bold: props.color }, 'Choose canonical skill to adopt'),
        createElement(
          Text,
          null,
          adoptionEntry === undefined
            ? 'No unmanaged target skill is selected.'
            : `Local copy: ${adoptionEntry.target} · ${adoptionEntry.path}`,
        ),
        ...(adoptionCandidates.length === 0
          ? [
              createElement(
                Text,
                { key: 'empty', ...withColor(props.color ? palette.warning : undefined) },
                `No catalog skills declare compatibility with ${adoptionEntry?.target ?? 'this target'}.`,
              ),
            ]
          : adoptionWindow.items.map((skill, offset) => {
              const index = adoptionWindow.start + offset;
              return createElement(
                Text,
                {
                  key: skill.id,
                  ...withColor(cursor === index && props.color ? palette.accent : undefined),
                },
                `${cursor === index ? '❯' : ' '} ${skill.id} · ${skill.description}`,
              );
            })),
        createElement(TuiWindowIndicator, { color: props.color, window: adoptionWindow }),
        createElement(
          Text,
          withColor(muted),
          '↑↓ move · Choose one exact qualified ID · Enter review · Esc inventory',
        ),
      );
    }
    return createElement(
      Box,
      { flexDirection: 'column', gap: 1 },
      createElement(Text, { bold: props.color }, 'Review unmanaged-skill adoption'),
      createElement(Text, null, `Scope: ${dashboard.scope}`),
      createElement(
        Text,
        null,
        `Local target: ${adoptionEntry?.target ?? 'unknown'} · ${adoptionEntry?.path ?? 'unknown'}`,
      ),
      createElement(Text, null, `Canonical skill: ${adoptionSkillId ?? 'none selected'}`),
      createElement(
        Text,
        withColor(props.color ? palette.warning : undefined),
        'Adoption only succeeds if the local directory exactly matches this canonical skill. Target files will not be replaced.',
      ),
      createElement(Text, withColor(muted), 'y adopt · Esc cancel'),
    );
  })();

  const compactDiagnostics = screen === 'setup-diagnostics' && rows < 16;
  return createElement(
    Box,
    {
      flexDirection: 'column',
      gap: compactDiagnostics ? 0 : 1,
      padding: compactDiagnostics ? 0 : 1,
    },
    compactDiagnostics
      ? null
      : createElement(Header, {
          color: props.color,
          compact,
          scope: dashboard?.scope ?? 'project',
        }),
    busy ? createElement(Text, withColor(muted), 'Working safely…') : content,
    notice === undefined || screen === 'setup-diagnostics'
      ? null
      : createElement(Text, withColor(props.color ? palette.warning : undefined), notice),
    compactDiagnostics
      ? null
      : createElement(TuiReleaseUpdateIndicator, { color: props.color, update: releaseUpdate }),
    compactDiagnostics
      ? null
      : createElement(
          Text,
          withColor(muted),
          props.implicit ? 'Started from skill-sync' : 'Started from skill-sync tui',
        ),
  );
}
