export interface AdoptHumanResult {
  readonly applied: boolean;
  readonly dryRun: boolean;
  readonly freshness: string;
  readonly libraryRevision: string;
  readonly projectRoot?: string;
  readonly scope: 'global' | 'project';
  readonly skill: {
    readonly destination: string;
    readonly id: string;
    readonly target: string;
  };
  readonly stale: boolean;
  readonly stateDirectory?: string;
  readonly writes: readonly string[];
}

function scopeLine(result: AdoptHumanResult): string {
  const location = result.scope === 'global' ? result.stateDirectory : result.projectRoot;
  return `Scope: ${result.scope}${location === undefined ? '' : ` (${location})`}`;
}

function summarizedPaths(paths: readonly string[], limit = 5): string {
  if (paths.length === 0) return 'none';
  const visible = paths.slice(0, limit).join(', ');
  return paths.length > limit ? `${visible}, … (+${String(paths.length - limit)} more)` : visible;
}

/** Render an adoption result without changing its complete structured JSON representation. */
export function formatAdoptHuman(
  result: AdoptHumanResult,
  options: ScopedHumanOutputOptions = {},
): string {
  const summary = result.dryRun
    ? 'Adoption preview (no files or tracking state changed).'
    : result.applied
      ? 'Adoption complete; the existing copy is now tracked.'
      : 'Adoption made no changes.';
  const next = result.dryRun
    ? 'Next: Re-run the same skill-sync adopt command without --dry-run to track this exact copy.'
    : `Next: Run ${scopedHumanCommand(result.scope, 'status', options)} to verify the managed copy.`;
  return [
    summary,
    scopeLine(result),
    `Skill: ${result.skill.id}`,
    `Existing copy: ${result.skill.target}: ${result.skill.destination}`,
    `Library source: ${result.libraryRevision} (${result.freshness}${result.stale ? ', stale' : ''})`,
    ...(result.stale ? ['Warning: adoption was checked against stale cached library data.'] : []),
    `${result.dryRun ? 'Planned tracking writes' : 'Tracking writes completed'}: ${summarizedPaths(result.writes)}`,
    'Target files: unchanged',
    next,
  ].join('\n');
}
import { scopedHumanCommand, type ScopedHumanOutputOptions } from './scope-output.js';
