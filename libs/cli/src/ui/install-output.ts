import { comparePortableStrings } from '../domain/identifiers.js';
import { scopedHumanCommand, type ScopedHumanOutputOptions } from './scope-output.js';

const HUMAN_INSTALL_SKILL_LIMIT = 20;

export interface InstallHumanProjection {
  readonly destination: string;
  readonly target: string;
  readonly write: boolean;
}

export interface InstallHumanResult {
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly fingerprint: string;
  readonly freshness: string;
  readonly gitignore?: { readonly changed: boolean; readonly path: string };
  readonly libraryRevision: string;
  readonly projectRoot?: string;
  readonly scope: 'global' | 'project';
  readonly skills: readonly {
    readonly id: string;
    readonly projections: readonly InstallHumanProjection[];
    readonly status: string;
  }[];
  readonly stale: boolean;
  readonly stateDirectory?: string;
  readonly writes: readonly string[];
}

export interface InstallHumanOutputOptions extends ScopedHumanOutputOptions {
  readonly applyCommand?: string;
  readonly continuation?: 'external-apply' | 'inline-confirmation';
}

export interface InstallApplyCommandOptions extends ScopedHumanOutputOptions {
  readonly all: boolean;
  readonly fingerprint: string;
  readonly gitignore?: 'managed' | 'unmanaged';
  readonly scope: 'global' | 'project';
  readonly selectors: readonly string[];
  readonly targets: readonly string[];
}

function commandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatInstallApplyCommand(options: InstallApplyCommandOptions): string {
  const selection = options.all ? ['--all'] : [...options.selectors].sort(comparePortableStrings);
  const targets = [...options.targets]
    .sort(comparePortableStrings)
    .flatMap((target) => ['--target', target]);
  const gitignore =
    options.scope === 'global' || options.gitignore === undefined
      ? []
      : [options.gitignore === 'managed' ? '--gitignore' : '--no-gitignore'];
  const arguments_ = [...selection, ...targets, ...gitignore, '--expect-plan', options.fingerprint];
  return [
    scopedHumanCommand(options.scope, 'install', options),
    ...arguments_.map(commandArgument),
  ].join(' ');
}

function scopeLine(result: InstallHumanResult): string {
  const location = result.scope === 'global' ? result.stateDirectory : result.projectRoot;
  return `Scope: ${result.scope}${location === undefined ? '' : ` (${location})`}`;
}

function summarizedPaths(paths: readonly string[], limit = 5): string {
  if (paths.length === 0) return 'none';
  const visible = paths.slice(0, limit).join(', ');
  return paths.length > limit ? `${visible}, … (+${String(paths.length - limit)} more)` : visible;
}

function gitignoreLine(
  gitignore: { readonly changed: boolean; readonly path: string } | undefined,
  dryRun: boolean,
): string {
  if (gitignore === undefined) return 'Gitignore: not applicable to global scope';
  if (!gitignore.changed) return 'Gitignore: unchanged';
  return `Gitignore: ${dryRun ? 'would update' : 'updated'} ${gitignore.path}`;
}

function projectionLines(skills: InstallHumanResult['skills']): string[] {
  return skills.flatMap((skill) => [
    `  ${skill.id}: ${skill.status}`,
    ...skill.projections.map((projection) => {
      const action = projection.write ? '' : ' (already present)';
      return `    ${projection.target}: ${projection.destination}${action}`;
    }),
  ]);
}

export function installPlanHasNoChanges(
  result: Pick<InstallHumanResult, 'gitignore' | 'skills' | 'writes'>,
): boolean {
  return (
    result.writes.length === 0 &&
    result.gitignore?.changed !== true &&
    result.skills.length > 0 &&
    result.skills.every(
      (skill) =>
        skill.status === 'already-installed' &&
        skill.projections.every((projection) => !projection.write),
    )
  );
}

function skillLines(result: InstallHumanResult): readonly string[] {
  if (result.dryRun) return ['Skills:', ...projectionLines(result.skills)];

  const ordered = [...result.skills].sort((left, right) =>
    comparePortableStrings(left.id, right.id),
  );
  const visible = ordered.slice(0, HUMAN_INSTALL_SKILL_LIMIT);
  const heading =
    visible.length === ordered.length
      ? `Skills (${String(ordered.length)}):`
      : `Skills (showing ${String(visible.length)} of ${String(ordered.length)}):`;
  return [
    heading,
    ...projectionLines(visible),
    ...(visible.length < ordered.length
      ? [`  … ${String(ordered.length - visible.length)} more skills omitted`]
      : []),
  ];
}

/** Render an install result without changing its complete structured JSON representation. */
export function formatInstallHuman(
  result: InstallHumanResult,
  options: InstallHumanOutputOptions = {},
): string {
  const noOpPreview = result.dryRun && installPlanHasNoChanges(result);
  const summary = result.dryRun
    ? noOpPreview
      ? 'Install preview: everything selected is already installed (no changes planned).'
      : 'Install preview (no changes made).'
    : result.applied
      ? 'Install complete.'
      : 'Install made no changes.';
  const next =
    result.dryRun && !noOpPreview
      ? options.continuation === 'inline-confirmation'
        ? 'Next: Confirm the prompt below to apply this exact reviewed plan; no second command is needed.'
        : options.applyCommand === undefined
          ? `Next: Re-run the same skill-sync install command without --dry-run and add --expect-plan ${result.fingerprint}.`
          : `Next: ${options.applyCommand}`
      : `Next: Run ${scopedHumanCommand(result.scope, 'status', options)} to verify managed copies.`;
  const explicitProjectHandoff =
    result.dryRun &&
    !noOpPreview &&
    options.continuation !== 'inline-confirmation' &&
    options.explicitProject === true &&
    options.applyCommand?.includes('<project-path>') === true
      ? ['Replace <project-path> with the project path shown in Scope above.']
      : [];
  return [
    summary,
    scopeLine(result),
    `Library source: ${result.libraryRevision} (${result.freshness}${result.stale ? ', stale' : ''})`,
    ...(result.stale
      ? [
          'Warning: this preview uses cached library data. Apply refreshes it and stops if the plan changed.',
        ]
      : []),
    `Plan fingerprint: ${result.fingerprint}`,
    gitignoreLine(result.gitignore, result.dryRun),
    `${result.dryRun ? 'Planned writes' : 'Writes completed'}: ${summarizedPaths(result.writes)}`,
    ...skillLines(result),
    next,
    ...explicitProjectHandoff,
  ].join('\n');
}
