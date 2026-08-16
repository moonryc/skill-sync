export interface EmptyProjectStatusReport {
  readonly managed: false;
  readonly nextAction: 'skill-sync init <repository-url> --dry-run' | 'skill-sync list';
  readonly operation: 'status';
  readonly projectRoot: string;
  readonly skills: readonly [];
}

export interface EmptyGlobalStatusReport {
  readonly managed: false;
  readonly nextAction: 'skill-sync init <repository-url> --dry-run' | 'skill-sync list --global';
  readonly operation: 'status';
  readonly scope: 'global';
  readonly skills: readonly [];
  readonly stateDirectory: string;
}

/** Render a write-free project status before managed state exists. */
export function formatEmptyProjectStatusHuman(
  report: EmptyProjectStatusReport,
  options: ScopedHumanOutputOptions = {},
): string {
  const list = `${scopedHumanCommand('project', 'list', options)}${
    options.explicitProject === true ? ', using the Project path shown above' : ''
  }`;
  const next =
    report.nextAction === 'skill-sync list'
      ? `Next: Run ${list} to browse available skills, then follow its preview-ready install command.`
      : `Next: Preview setup with skill-sync init <repository-url> --dry-run (or skill-sync init --create <owner/name> --dry-run), run the exact --expect-plan command it prints, then run ${list}.`;
  return [
    'Scope: project',
    `Project: ${report.projectRoot}`,
    'No managed skills are tracked in this project.',
    next,
  ].join('\n');
}

/** Render a write-free global status before managed state exists. */
export function formatEmptyGlobalStatusHuman(report: EmptyGlobalStatusReport): string {
  const next =
    report.nextAction === 'skill-sync list --global'
      ? 'Next: Run skill-sync list --global to browse available skills, then follow its preview-ready global install command.'
      : 'Next: Preview setup with skill-sync init <repository-url> --dry-run (or skill-sync init --create <owner/name> --dry-run), run the exact --expect-plan command it prints, then run skill-sync list --global.';
  return [
    'Scope: global',
    `State: no global manifest or lock in ${report.stateDirectory}`,
    'No managed skills are tracked globally.',
    next,
  ].join('\n');
}
import { scopedHumanCommand, type ScopedHumanOutputOptions } from './scope-output.js';
