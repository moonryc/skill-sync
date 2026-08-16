import { describe, expect, it } from 'vitest';

import {
  formatEmptyGlobalStatusHuman,
  formatEmptyProjectStatusHuman,
  type EmptyGlobalStatusReport,
  type EmptyProjectStatusReport,
} from '../../src/ui/empty-status-output.js';

function projectReport(configured: boolean): EmptyProjectStatusReport {
  return {
    managed: false,
    nextAction: configured ? 'skill-sync list' : 'skill-sync init <repository-url> --dry-run',
    operation: 'status',
    projectRoot: '/work/selected-project',
    skills: [],
  };
}

function globalReport(configured: boolean): EmptyGlobalStatusReport {
  return {
    managed: false,
    nextAction: configured
      ? 'skill-sync list --global'
      : 'skill-sync init <repository-url> --dry-run',
    operation: 'status',
    scope: 'global',
    skills: [],
    stateDirectory: '/state/global',
  };
}

describe('empty status human output', () => {
  it('uses the current project implicitly for a configured project', () => {
    const output = formatEmptyProjectStatusHuman(projectReport(true));

    expect(output).toContain('Scope: project');
    expect(output).toContain('Project: /work/selected-project');
    expect(output).toContain(
      'Next: Run skill-sync list to browse available skills, then follow its preview-ready install command.',
    );
    expect(output).not.toContain('--project');
  });

  it.each([
    [true, 'Next: Run skill-sync --project <project-path> list'],
    [false, 'then run skill-sync --project <project-path> list'],
  ] as const)('preserves an explicit project when configured is %s', (configured, next) => {
    const output = formatEmptyProjectStatusHuman(projectReport(configured), {
      explicitProject: true,
    });

    expect(output).toContain(next);
    expect(output).toContain('using the Project path shown above');
    expect(output).not.toContain('skill-sync --project <project-path> init');
  });

  it.each([
    [
      true,
      'Next: Run skill-sync list --global to browse available skills, then follow its preview-ready global install command.',
    ],
    [
      false,
      'Next: Preview setup with skill-sync init <repository-url> --dry-run (or skill-sync init --create <owner/name> --dry-run), run the exact --expect-plan command it prints, then run skill-sync list --global.',
    ],
  ] as const)(
    'keeps global empty status guidance unchanged when configured is %s',
    (configured, next) => {
      expect(formatEmptyGlobalStatusHuman(globalReport(configured))).toContain(next);
    },
  );
});
