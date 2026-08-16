import type {
  RecoveryPrunePlanEntry,
  RecoveryRecord,
  RecoveryRecordInspection,
  RecoveryUnlockPlan,
} from '../application/recovery.js';
import type {
  RecoveryRestoreAction,
  RecoveryResumeAction,
} from '../infrastructure/transactions.js';

const RECOVERY_HUMAN_LIMIT = 20;

export interface RecoveryRecordsHumanOptions {
  readonly scope?: string;
}

export interface RecoveryActionHumanEntry {
  readonly actions: readonly (RecoveryRestoreAction | RecoveryResumeAction)[];
  readonly destination: string;
  readonly index: number;
}

export interface RecoveryActionHumanResult {
  readonly applied: boolean;
  readonly entries: readonly RecoveryActionHumanEntry[];
  readonly fingerprint: string;
  readonly id: string;
  readonly operationId: string;
  readonly root: string;
  readonly status: string;
}

export interface RecoveryActionHumanContext {
  readonly dryRun: boolean;
  readonly requiresYes?: boolean;
  readonly scopeKind: string | undefined;
}

export interface RecoveryPruneHumanResult {
  readonly applied: boolean;
  readonly entries: readonly RecoveryPrunePlanEntry[];
  readonly fingerprint: string;
  readonly ids: readonly string[];
}

export interface RecoveryPruneHumanContext {
  readonly dryRun: boolean;
  readonly requiresYes?: boolean;
  readonly root: string;
  readonly scopeKind: 'global' | 'project';
}

export interface RecoveryUnlockHumanResult extends RecoveryUnlockPlan {
  readonly applied: boolean;
}

export interface RecoveryUnlockHumanContext {
  readonly dryRun: boolean;
  readonly requiresYes?: boolean;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function recoveryMode(record: RecoveryRecord): 'cleanup-only' | 'inspect-only' | 'recoverable' {
  if (
    (record.kind === 'journal' && ['committed', 'rolled-back'].includes(record.status)) ||
    (record.kind === 'backup' && record.status === 'available')
  ) {
    return 'cleanup-only';
  }
  return record.inspectOnly ? 'inspect-only' : 'recoverable';
}

export function formatRecoveryRecordsHuman(
  records: readonly RecoveryRecord[],
  options: RecoveryRecordsHumanOptions = {},
): string {
  const scopeSuffix = options.scope === undefined ? '' : ` for scope filter ${options.scope}`;
  if (records.length === 0) {
    return [
      `No recovery records found${scopeSuffix}.`,
      'Read-only: no changes made.',
      'Next: Run skill-sync doctor if another command still reports recovery evidence.',
    ].join('\n');
  }

  const ordered = [...records].sort((left, right) => compareText(left.id, right.id));
  const visible = ordered.slice(0, RECOVERY_HUMAN_LIMIT);
  const firstId = ordered[0]?.id ?? '<id>';
  return [
    `Recovery records (${String(ordered.length)})${scopeSuffix}:`,
    ...visible.flatMap((record) => [
      `  ${record.id}`,
      `    Type: ${record.kind} | Status: ${record.status} | Scope: ${record.scope} | Mode: ${recoveryMode(record)}`,
    ]),
    ...(visible.length < ordered.length
      ? [`  … ${String(ordered.length - visible.length)} more recovery records omitted`]
      : []),
    'Read-only: no changes made.',
    `Next: Run skill-sync recovery inspect ${firstId}.`,
  ].join('\n');
}

function recoveryDestinations(inspection: RecoveryRecordInspection): readonly string[] {
  if (inspection.record.kind !== 'journal') return [];
  const entries: unknown = Reflect.get(inspection.evidence, 'entries');
  if (!Array.isArray(entries)) return [];
  return [
    ...new Set(
      entries.flatMap((entry): readonly string[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const destination: unknown = Reflect.get(entry, 'destination');
        return typeof destination === 'string' ? [destination] : [];
      }),
    ),
  ].sort(compareText);
}

function recoveryDestinationLines(inspection: RecoveryRecordInspection): readonly string[] {
  const destinations = recoveryDestinations(inspection);
  if (destinations.length === 0) return [];
  const visible = destinations.slice(0, RECOVERY_HUMAN_LIMIT);
  return [
    `Affected destinations (${String(destinations.length)}):`,
    ...visible.map((destination) => `  ${destination}`),
    ...(visible.length < destinations.length
      ? [`  … ${String(destinations.length - visible.length)} more destinations omitted`]
      : []),
  ];
}

interface LibraryInitializationEvidence {
  readonly branch: string;
  readonly configuration: string;
  readonly expectedRevision: string | null;
  readonly planFingerprint: string;
  readonly provider: string;
  readonly push: string;
  readonly remote: { readonly cloneUrl: string; readonly identity: string };
}

function libraryInitializationEvidence(
  inspection: RecoveryRecordInspection,
): LibraryInitializationEvidence | undefined {
  if (inspection.record.operationKind !== 'library-initialization') return undefined;
  const note = 'note' in inspection.evidence ? inspection.evidence.note : undefined;
  if (typeof note !== 'string') return undefined;
  try {
    const value = JSON.parse(note) as unknown;
    if (typeof value !== 'object' || value === null) return undefined;
    const remote = 'remote' in value ? value.remote : undefined;
    if (typeof remote !== 'object' || remote === null) return undefined;
    const branch = 'branch' in value ? value.branch : undefined;
    const configuration = 'configuration' in value ? value.configuration : undefined;
    const expectedRevision = 'expectedRevision' in value ? value.expectedRevision : undefined;
    const planFingerprint = 'planFingerprint' in value ? value.planFingerprint : undefined;
    const provider = 'provider' in value ? value.provider : undefined;
    const push = 'push' in value ? value.push : undefined;
    const cloneUrl = 'cloneUrl' in remote ? remote.cloneUrl : undefined;
    const identity = 'identity' in remote ? remote.identity : undefined;
    if (
      typeof branch !== 'string' ||
      typeof configuration !== 'string' ||
      (expectedRevision !== null && typeof expectedRevision !== 'string') ||
      typeof planFingerprint !== 'string' ||
      typeof provider !== 'string' ||
      typeof push !== 'string' ||
      typeof cloneUrl !== 'string' ||
      typeof identity !== 'string'
    ) {
      return undefined;
    }
    return {
      branch,
      configuration,
      expectedRevision,
      planFingerprint,
      provider,
      push,
      remote: { cloneUrl, identity },
    };
  } catch {
    return undefined;
  }
}

function commandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function libraryInitializationEvidenceLines(
  inspection: RecoveryRecordInspection,
): readonly string[] {
  const evidence = libraryInitializationEvidence(inspection);
  if (evidence === undefined) return [];
  return [
    'Initialization evidence:',
    `  Remote: ${evidence.remote.identity}`,
    `  URL: ${evidence.remote.cloneUrl}`,
    `  Branch: ${evidence.branch}`,
    `  GitHub repository creation: ${evidence.provider}`,
    `  Initial remote push: ${evidence.push}`,
    `  Saved configuration: ${evidence.configuration}`,
    ...(evidence.expectedRevision === null
      ? []
      : [`  Expected revision: ${evidence.expectedRevision}`]),
    `  Reviewed plan: ${evidence.planFingerprint}`,
  ];
}

function advisoryLockEvidenceLines(inspection: RecoveryRecordInspection): readonly string[] {
  if (inspection.record.kind !== 'lock' || !('hostname' in inspection.evidence)) return [];
  const owner = inspection.evidence;
  return [
    'Lock owner:',
    `  Operation: ${owner.operationId}`,
    `  Process: PID ${String(owner.pid)} on ${owner.hostname}`,
    `  Created: ${owner.createdAt}`,
    `  Scope: ${owner.scope.kind}:${owner.scope.id}`,
  ];
}

function recoveryActionPrefix(record: RecoveryRecord): string {
  return record.scopeKind === 'project' ? 'skill-sync --project <affected-project>' : 'skill-sync';
}

function recoveryActionLines(inspection: RecoveryRecordInspection): readonly string[] {
  const { record } = inspection;
  const prefix = recoveryActionPrefix(record);
  if (record.kind === 'journal') {
    const initialization = libraryInitializationEvidence(inspection);
    if (initialization !== undefined) {
      const preview = [
        'skill-sync',
        'init',
        initialization.remote.cloneUrl,
        '--branch',
        initialization.branch,
        '--dry-run',
      ]
        .map(commandArgument)
        .join(' ');
      return [
        'Recovery is manual: external repository changes are never replayed or deleted automatically.',
        `Next: Inspect ${initialization.remote.identity} at branch ${initialization.branch}, then review current state with ${preview}.`,
        'If that preview matches the intended repository, run the exact --expect-plan command it prints; a successful setup clears this evidence.',
      ];
    }
    if (record.inspectOnly) {
      return [
        'Available actions: inspection only; this legacy or incomplete record cannot be replayed.',
        'Next: Preserve this evidence and run skill-sync doctor.',
      ];
    }
    if (record.status === 'committed' || record.status === 'rolled-back') {
      return [
        'Available action: remove verified terminal recovery evidence after checking managed state.',
        `Next: Preview cleanup with ${prefix} recovery prune ${record.id} --dry-run.`,
      ];
    }
    return [
      ...(record.scopeKind === 'project'
        ? [
            'Root: run from the affected project, or replace <affected-project> below with its path.',
          ]
        : []),
      'Choose one direction (preview first):',
      `  Finish the interrupted operation: ${prefix} recovery resume ${record.id} --dry-run`,
      `  Return to the state before the operation: ${prefix} recovery restore ${record.id} --dry-run`,
      'Next: Run one preview above, review every destination, then apply only the direction you intend.',
    ];
  }
  if (record.kind === 'backup' && record.status === 'available') {
    return [
      'Available action: remove this verified backup after checking managed state.',
      `Next: Preview cleanup with ${prefix} recovery prune ${record.id} --dry-run.`,
    ];
  }
  if (record.kind === 'lock' && record.problem === undefined) {
    return [
      'Available action: verify that the recorded local process is gone, then remove only this lock.',
      `Next: Preview safe removal with skill-sync recovery unlock ${record.id} --dry-run.`,
    ];
  }
  return [
    'Available actions: none automated for this record.',
    'Next: Preserve this evidence and run skill-sync doctor.',
  ];
}

export function formatRecoveryRecordHuman(inspection: RecoveryRecordInspection): string {
  const { record } = inspection;
  return [
    `Recovery record: ${record.id}`,
    `Type: ${record.kind}`,
    `Status: ${record.status}`,
    `Scope: ${record.scope}`,
    `Evidence path: ${record.path}`,
    `Mode: ${recoveryMode(record)}`,
    ...(record.problem === undefined ? [] : [`Problem: ${record.problem}`]),
    ...recoveryDestinationLines(inspection),
    ...libraryInitializationEvidenceLines(inspection),
    ...advisoryLockEvidenceLines(inspection),
    'Read-only: no changes made.',
    ...recoveryActionLines(inspection),
  ].join('\n');
}

const recoveryActionLabels: Readonly<Record<RecoveryRestoreAction | RecoveryResumeAction, string>> =
  {
    'commit-candidate': 'install the prepared replacement',
    'mark-committed': 'record the destination as committed',
    'mark-restored': 'record the destination as restored',
    'move-original': 'move the current destination to rollback storage',
    'remove-candidate': 'remove the prepared replacement',
    'remove-committed': 'remove the committed replacement',
    'restore-original': 'restore the original destination',
  };

function recoveryEntryLines(entries: readonly RecoveryActionHumanEntry[]): readonly string[] {
  const ordered = [...entries].sort(
    (left, right) => compareText(left.destination, right.destination) || left.index - right.index,
  );
  const visible = ordered.slice(0, RECOVERY_HUMAN_LIMIT);
  return [
    `Affected destinations (${String(ordered.length)}):`,
    ...visible.map((entry) => {
      const actions = entry.actions.map((action) => recoveryActionLabels[action]);
      return `  ${entry.destination}: ${actions.join('; ') || 'no filesystem changes required'}`;
    }),
    ...(visible.length < ordered.length
      ? [`  … ${String(ordered.length - visible.length)} more destinations omitted`]
      : []),
  ];
}

function recoveryScopeLine(
  result: RecoveryActionHumanResult,
  scopeKind: string | undefined,
): string {
  return `Scope: ${scopeKind === 'global' ? 'global' : 'project'} (${result.root})`;
}

function recoveryApplyPrefix(scopeKind: string | undefined): string {
  return scopeKind === 'project' ? 'skill-sync --project <affected-project>' : 'skill-sync';
}

function recoveryStatusCommand(scopeKind: string | undefined): string {
  return scopeKind === 'global'
    ? 'skill-sync --global status'
    : 'skill-sync --project <affected-project> status';
}

function formatRecoveryActionHuman(
  operation: 'resume' | 'restore',
  result: RecoveryActionHumanResult,
  context: RecoveryActionHumanContext,
): string {
  const terminalStatus = operation === 'resume' ? 'committed' : 'rolled-back';
  const alreadyComplete = !result.applied && result.status === terminalStatus;
  const label = operation === 'resume' ? 'resume' : 'restore';
  const summary = result.applied
    ? `Recovery ${label} complete.`
    : alreadyComplete
      ? `Recovery ${label} is already complete.`
      : `Recovery ${label} preview (no changes made).`;
  const stateLabel = result.applied || alreadyComplete ? 'Final state' : 'Current state';
  const next =
    !result.applied && !alreadyComplete && context.dryRun
      ? `Next: Apply this preview with ${recoveryApplyPrefix(context.scopeKind)} recovery ${operation} ${result.id}${context.requiresYes === true ? ' --yes' : ''}.`
      : `Next: Run ${recoveryStatusCommand(context.scopeKind)} to verify managed state.`;

  return [
    summary,
    recoveryScopeLine(result, context.scopeKind),
    `Record: ${result.id}`,
    `Operation: ${result.operationId}`,
    `${stateLabel}: ${result.status}`,
    ...recoveryEntryLines(result.entries),
    `Plan fingerprint: ${result.fingerprint}`,
    next,
  ].join('\n');
}

export function formatRecoveryResumeHuman(
  result: RecoveryActionHumanResult,
  context: RecoveryActionHumanContext,
): string {
  return formatRecoveryActionHuman('resume', result, context);
}

export function formatRecoveryRestoreHuman(
  result: RecoveryActionHumanResult,
  context: RecoveryActionHumanContext,
): string {
  return formatRecoveryActionHuman('restore', result, context);
}

function recoveryPrunePathLines(entries: readonly RecoveryPrunePlanEntry[]): readonly string[] {
  const paths = entries
    .flatMap((entry) => entry.paths.map((path) => ({ id: entry.id, kind: entry.kind, path })))
    .sort((left, right) => compareText(left.id, right.id) || compareText(left.path, right.path));
  const visible = paths.slice(0, RECOVERY_HUMAN_LIMIT);
  return [
    `Owned paths (${String(paths.length)}):`,
    ...visible.map((entry) => `  ${entry.id} (${entry.kind}): ${entry.path}`),
    ...(visible.length < paths.length
      ? [`  … ${String(paths.length - visible.length)} more owned paths omitted`]
      : []),
  ];
}

function recoveryPrunePrefix(scopeKind: 'global' | 'project'): string {
  return scopeKind === 'global' ? 'skill-sync --global' : 'skill-sync --project <affected-project>';
}

export function formatRecoveryPruneHuman(
  result: RecoveryPruneHumanResult,
  context: RecoveryPruneHumanContext,
): string {
  const summary = result.applied
    ? 'Recovery prune complete.'
    : 'Recovery prune preview (no changes made).';
  const next =
    !result.applied && context.dryRun
      ? result.ids.length <= 5
        ? `Next: Apply this preview with ${recoveryPrunePrefix(context.scopeKind)} recovery prune ${result.ids.join(' ')}${context.requiresYes === true ? ' --yes' : ''}.`
        : `Next: Re-run the same recovery prune selection without --dry-run${context.requiresYes === true ? ' and add --yes' : ''} to apply this preview.`
      : 'Next: Run skill-sync recovery list --include-terminal to verify remaining recovery records.';
  return [
    summary,
    `Scope: ${context.scopeKind} (${context.root})`,
    `Selected records: ${String(result.ids.length)}`,
    ...recoveryPrunePathLines(result.entries),
    `Plan fingerprint: ${result.fingerprint}`,
    next,
  ].join('\n');
}

export function formatRecoveryUnlockHuman(
  result: RecoveryUnlockHumanResult,
  context: RecoveryUnlockHumanContext,
): string {
  const summary = result.applied
    ? 'Abandoned recovery lock removed.'
    : 'Recovery unlock preview (no changes made).';
  const next = result.applied
    ? 'Next: Run skill-sync recovery list, then retry the command that was blocked.'
    : `Next: Apply this preview with skill-sync recovery unlock ${result.id}${context.requiresYes === true ? ' --yes' : ''}.`;
  return [
    summary,
    `Record: ${result.id}`,
    `Lock: ${result.path}`,
    `Owner: ${result.owner.operationId} (PID ${String(result.owner.pid)} on ${result.owner.hostname})`,
    `Scope: ${result.owner.scope.kind}:${result.owner.scope.id}`,
    `Created: ${result.owner.createdAt}`,
    `Last heartbeat: ${result.lastHeartbeatAt}`,
    'Proof: the recorded owner process is absent on this host and 60 seconds elapsed after its last heartbeat.',
    `Plan fingerprint: ${result.fingerprint}`,
    next,
  ].join('\n');
}
