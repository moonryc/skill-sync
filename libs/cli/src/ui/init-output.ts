import type { LibraryInitPlan, LibraryInitResult } from '../application/library-lifecycle.js';

export function formatInitHuman(result: LibraryInitResult): string {
  const summary = result.initialized
    ? `Initialized skill library ${result.remote.identity}.`
    : result.changed
      ? `Connected to skill library ${result.remote.identity}.`
      : `Skill library ${result.remote.identity} is already connected.`;
  return [
    summary,
    `Branch: ${result.branch}`,
    `Revision: ${result.revision}`,
    'Next: Run skill-sync list to browse available skills.',
  ].join('\n');
}

function commandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function initCommandArguments(plan: LibraryInitPlan): readonly string[] {
  return plan.action === 'create'
    ? [
        '--create',
        plan.repository ?? '',
        '--visibility',
        plan.visibility ?? 'private',
        '--transport',
        plan.remote.transport,
        '--branch',
        plan.branch,
      ]
    : [plan.remote.cloneUrl, '--branch', plan.branch];
}

export function formatInitPreviewCommand(plan: LibraryInitPlan): string {
  return ['skill-sync', 'init', ...initCommandArguments(plan), '--dry-run']
    .map(commandArgument)
    .join(' ');
}

export function formatInitApplyCommand(plan: LibraryInitPlan): string {
  return ['skill-sync', 'init', ...initCommandArguments(plan), '--expect-plan', plan.fingerprint]
    .map(commandArgument)
    .join(' ');
}

export function formatInitPlanHuman(plan: LibraryInitPlan): string {
  const action =
    plan.action === 'connect'
      ? 'connect to the validated library'
      : plan.action === 'create'
        ? 'create and initialize a GitHub repository'
        : 'initialize the empty repository';
  const effects = [
    plan.effects.githubRepository === 'create' ? 'create the GitHub repository' : undefined,
    plan.effects.remoteLibrary === 'initialize' ? 'push the initial library commit' : undefined,
    'refresh the local library cache',
    plan.effects.configuration === 'write'
      ? 'save this repository as the default library'
      : 'leave the already-matching configuration unchanged',
  ].filter((effect): effect is string => effect !== undefined);
  const lines = [
    `Initialization preview: ${action}.`,
    'No changes were made.',
    `Remote: ${plan.remote.identity}`,
    `URL: ${plan.remote.cloneUrl}`,
    `Branch: ${plan.branch}`,
    `Remote state: ${plan.remoteState}`,
    ...(plan.revision === null ? [] : [`Revision: ${plan.revision}`]),
    ...(plan.validation === null
      ? []
      : [
          `Validated library: ${String(plan.validation.skills)} skill(s), ${String(plan.validation.groups)} group(s)`,
        ]),
    `Configuration: ${plan.configuration.changed ? 'will change' : 'already matches'}`,
    'Planned effects:',
    ...effects.map((effect) => `- ${effect}`),
    `Plan fingerprint: ${plan.fingerprint}`,
  ];
  if (plan.effects.githubRepository === 'create' || plan.effects.remoteLibrary === 'initialize') {
    lines.push('Warning: applying this plan creates content on a remote Git provider.');
  }
  if (plan.effects.githubRepository === 'create') {
    lines.push(
      'If a later setup step fails, the newly created repository may remain; inspect it with GitHub before retrying or deleting it.',
    );
  }
  lines.push(`Next: ${formatInitApplyCommand(plan)}`);
  return lines.join('\n');
}
