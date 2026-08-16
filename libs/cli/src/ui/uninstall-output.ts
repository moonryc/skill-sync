import { comparePortableStrings } from '../domain/identifiers.js';
import { scopedHumanCommand, type ScopedHumanOutputOptions } from './scope-output.js';

const HUMAN_UNINSTALL_SKILL_LIMIT = 20;

export interface UninstallHumanProjection {
  readonly destination: string;
  readonly target: string;
  readonly write: boolean;
}

export interface UninstallHumanResult {
  readonly applied: boolean;
  readonly backup: { readonly paths: readonly string[]; readonly required: boolean };
  readonly dryRun: boolean;
  readonly gitignore?: { readonly changed: boolean; readonly path: string };
  readonly libraryRevision: string;
  readonly message?: string;
  readonly projectRoot?: string;
  readonly scope?: 'global' | 'project';
  readonly skills: readonly {
    readonly id: string;
    readonly projections: readonly UninstallHumanProjection[];
  }[];
  readonly stateDirectory?: string;
  readonly writes: readonly string[];
}

export interface UninstallHumanOutputOptions extends ScopedHumanOutputOptions {
  readonly requiresYes?: boolean;
}

function scopeLine(result: UninstallHumanResult): string {
  const scope = result.scope ?? 'project';
  const location = scope === 'global' ? result.stateDirectory : result.projectRoot;
  return `Scope: ${scope}${location === undefined ? '' : ` (${location})`}`;
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

function projectionLines(skills: UninstallHumanResult['skills']): string[] {
  return skills.flatMap((skill) => [
    `  ${skill.id}`,
    ...skill.projections.map((projection) => {
      const action = projection.write ? ' (remove)' : ' (already missing)';
      return `    ${projection.target}: ${projection.destination}${action}`;
    }),
  ]);
}

function skillLines(result: UninstallHumanResult): readonly string[] {
  if (result.dryRun) return ['Skills:', ...projectionLines(result.skills)];

  const ordered = [...result.skills].sort((left, right) =>
    comparePortableStrings(left.id, right.id),
  );
  const visible = ordered.slice(0, HUMAN_UNINSTALL_SKILL_LIMIT);
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

function nextAction(result: UninstallHumanResult, options: UninstallHumanOutputOptions): string {
  const status = scopedHumanCommand(result.scope ?? 'project', 'status', options);
  if (result.message !== undefined) {
    return `Next: Run ${status} to review managed copies before retrying.`;
  }
  if (result.dryRun) {
    const confirmation =
      result.backup.required && options.requiresYes === true ? ' and add --yes' : '';
    return `Next: Re-run the same skill-sync uninstall command without --dry-run${confirmation} to apply this preview.`;
  }
  return `Next: Run ${status} to verify remaining managed skills.`;
}

/** Render an uninstall result without changing its complete structured JSON representation. */
export function formatUninstallHuman(
  result: UninstallHumanResult,
  options: UninstallHumanOutputOptions = {},
): string {
  const summary =
    result.message ??
    (result.dryRun
      ? 'Uninstall preview (no changes made).'
      : result.applied
        ? 'Uninstall complete.'
        : 'Uninstall made no changes.');
  const backup = result.backup.required
    ? `${result.dryRun ? 'required' : 'created'} for ${summarizedPaths(result.backup.paths)}`
    : 'not required';
  return [
    summary,
    scopeLine(result),
    `Library revision: ${result.libraryRevision}`,
    gitignoreLine(result.gitignore, result.dryRun),
    `Backup: ${backup}`,
    `${result.dryRun ? 'Planned writes' : 'Writes completed'}: ${summarizedPaths(result.writes)}`,
    ...skillLines(result),
    nextAction(result, options),
  ].join('\n');
}
