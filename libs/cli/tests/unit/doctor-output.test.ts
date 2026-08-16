import { describe, expect, it } from 'vitest';

import type { DoctorCheck, DoctorReport } from '../../src/application/doctor.js';
import { EXIT_CODES } from '../../src/domain/result.js';
import { formatDoctorReport } from '../../src/ui/doctor-output.js';

function report(
  checks: readonly DoctorCheck[],
  overrides: Partial<DoctorReport> = {},
): DoctorReport {
  return {
    checks,
    exitCode: EXIT_CODES.success,
    offline: false,
    projectRoot: '/project',
    scope: 'project',
    ...overrides,
  };
}

describe('doctor human output', () => {
  it('renders a scannable healthy report with counts and an actionable next step', () => {
    const formatted = formatDoctorReport(
      report([
        { id: 'node', status: 'pass', scope: 'local', message: 'Node.js is ready.' },
        {
          id: 'library-access',
          status: 'pass',
          scope: 'remote',
          message: 'Library is reachable.',
        },
      ]),
    );

    expect(formatted).toContain('skill-sync doctor · Your skill-sync setup looks healthy');
    expect(formatted).toContain('Scope: project (/project)');
    expect(formatted).toContain('Remote checks: included');
    expect(formatted).toContain('Checks: pass 2; warning 0; fail 0; skipped 0');
    expect(formatted).toContain('\nPASS (2)');
    expect(formatted).not.toContain('PASS PASS');
    expect(formatted).toContain('Node.js');
    expect(formatted).toContain('Library access · remote');
    expect(formatted).not.toContain('Next actions');
    expect(formatted).toContain('Next: Run skill-sync list to browse available skills.');
    expect(formatted).not.toContain('\u001B[');

    const explicitProject = formatDoctorReport(
      report([{ id: 'node', status: 'pass', scope: 'local', message: 'Node.js is ready.' }]),
      { explicitProject: true },
    );
    expect(explicitProject).toContain(
      'Next: Run skill-sync --project <project-path> list to browse available skills.',
    );
  });

  it('preserves colour and numbered remediation for a blocked offline report', () => {
    const formatted = formatDoctorReport(
      report(
        [
          {
            id: 'project-state',
            status: 'fail',
            scope: 'local',
            message: 'State is invalid.',
            remediation: 'Restore the manifest and lock pair.',
          },
          {
            id: 'github-cli',
            status: 'warning',
            scope: 'local',
            message: 'GitHub CLI is unavailable.',
            remediation: 'Install gh before using init --create.',
          },
          {
            id: 'library-access',
            status: 'skipped',
            scope: 'remote',
            message: 'Skipped while offline.',
            remediation: 'Run without --offline to check access.',
          },
        ],
        {
          exitCode: EXIT_CODES.validation,
          globalStateDirectory: '/state/global',
          offline: true,
          scope: 'global',
        },
      ),
      { color: true },
    );

    expect(formatted).toContain('Doctor found blocking issues');
    expect(formatted).toContain('Scope: global (/state/global)');
    expect(formatted).toContain('Remote checks: skipped (--offline)');
    expect(formatted).toContain('Checks: pass 0; warning 1; fail 1; skipped 1');
    expect(formatted).toContain('Next actions');
    expect(formatted).toContain('1. Project managed state — Restore the manifest and lock pair.');
    expect(formatted).toContain('2. GitHub CLI — Install gh before using init --create.');
    expect(formatted).toContain(
      'Next: Complete action 1 above, then rerun the same skill-sync doctor command.',
    );
    expect(formatted).toContain('\u001B[');
  });

  it('prioritizes findings within a deterministic 20-check detail bound', () => {
    const checks: DoctorCheck[] = [
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `pass-${String(index).padStart(2, '0')}`,
        message: `Pass detail ${String(index)}`,
        scope: 'local' as const,
        status: 'pass' as const,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `skipped-${String(index).padStart(2, '0')}`,
        message: `Skipped detail ${String(index)}`,
        remediation: `Inspect skipped check ${String(index)}.`,
        scope: 'local' as const,
        status: 'skipped' as const,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `warning-${String(index).padStart(2, '0')}`,
        message: `Warning detail ${String(index)}`,
        remediation: `Fix warning ${String(index)}.`,
        scope: 'local' as const,
        status: 'warning' as const,
      })),
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `fail-${String(index).padStart(2, '0')}`,
        message: `Fail detail ${String(index)}`,
        remediation: `Fix failure ${String(index)}.`,
        scope: 'local' as const,
        status: 'fail' as const,
      })),
    ];

    const formatted = formatDoctorReport(report(checks, { exitCode: EXIT_CODES.validation }));

    expect(formatted).toContain('Checks: pass 6; warning 6; fail 7; skipped 6');
    expect(formatted.indexOf('BLOCKED (7)')).toBeLessThan(formatted.indexOf('ATTENTION (6)'));
    expect(formatted.indexOf('ATTENTION (6)')).toBeLessThan(formatted.indexOf('SKIPPED (6)'));
    expect(formatted).toContain('PASS (showing 1 of 6)');
    expect(formatted).toContain('Pass detail 0');
    expect(formatted).not.toContain('Pass detail 1');
    expect(formatted).toContain('… 5 more checks omitted');
    expect(formatted.match(/ {4}(?:Fail|Warning|Skipped|Pass) detail /gu)).toHaveLength(20);
  });

  it('renders recovery evidence with the exact read-only handoff', () => {
    const formatted = formatDoctorReport(
      report([
        {
          id: 'recovery-state',
          status: 'warning',
          scope: 'local',
          message: 'Application recovery evidence needs review: 1 lock.',
          remediation:
            'Run skill-sync recovery list to get a stable record ID, then skill-sync recovery inspect <id>.',
        },
      ]),
    );

    expect(formatted).toContain('\n  Application recovery state\n');
    expect(formatted).toContain(
      '1. Application recovery state — Run skill-sync recovery list to get a stable record ID, then skill-sync recovery inspect <id>.',
    );
    expect(formatted).toContain(
      'Next: Complete action 1 above, then rerun the same skill-sync doctor command.',
    );
  });

  it('guides an otherwise healthy offline report back to complete diagnostics', () => {
    const formatted = formatDoctorReport(
      report(
        [
          { id: 'node', status: 'pass', scope: 'local', message: 'Node.js is ready.' },
          {
            id: 'library-access',
            status: 'skipped',
            scope: 'remote',
            message: 'Remote access was skipped.',
            remediation: 'Run without --offline.',
          },
        ],
        { offline: true },
      ),
    );

    expect(formatted).toContain(
      'Next: Re-run the same skill-sync doctor command without --offline when remote access is available.',
    );
  });
});
