import type { DoctorCheck, DoctorCheckStatus, DoctorReport } from '../application/doctor.js';
import { scopedHumanCommand, type ScopedHumanOutputOptions } from './scope-output.js';

export interface DoctorReportFormatOptions extends ScopedHumanOutputOptions {
  readonly color?: boolean;
}

const HUMAN_DOCTOR_CHECK_LIMIT = 20;

const CHECK_LABELS: Readonly<Record<string, string>> = {
  cache: 'Library cache',
  config: 'Configuration',
  git: 'Git',
  'github-auth': 'GitHub authentication',
  'github-cli': 'GitHub CLI',
  'global-recovery': 'Global recovery paths',
  'global-state': 'Global managed state',
  'global-target-permissions': 'Global target permissions',
  'library-access': 'Library access',
  'library-schema': 'Library schema',
  'library-url': 'Library URL',
  node: 'Node.js',
  'project-root': 'Project root',
  'project-state': 'Project managed state',
  'recovery-state': 'Application recovery state',
  'target-permissions': 'Target permissions',
};

const STATUS_ORDER: readonly DoctorCheckStatus[] = ['fail', 'warning', 'skipped', 'pass'];

const STATUS_DETAILS: Readonly<
  Record<
    DoctorCheckStatus,
    { readonly color: number; readonly glyph: string; readonly label: string }
  >
> = {
  fail: { color: 31, glyph: '✕', label: 'BLOCKED' },
  warning: { color: 33, glyph: '!', label: 'ATTENTION' },
  skipped: { color: 36, glyph: '•', label: 'SKIPPED' },
  pass: { color: 32, glyph: '✓', label: 'PASS' },
};

function colour(value: string, code: number, enabled: boolean): string {
  return enabled ? `\u001B[${String(code)}m${value}\u001B[0m` : value;
}

function formattedStatus(status: DoctorCheckStatus, color: boolean): string {
  const detail = STATUS_DETAILS[status];
  return color ? colour(detail.glyph, detail.color, true) : detail.label;
}

function checkLabel(check: DoctorCheck): string {
  return CHECK_LABELS[check.id] ?? check.id.replaceAll('-', ' ');
}

function reportScope(report: DoctorReport): string {
  if (report.scope === 'global') {
    return `global${report.globalStateDirectory === undefined ? '' : ` (${report.globalStateDirectory})`}`;
  }
  if (report.scope === 'project' || report.projectRoot !== undefined) {
    return `project${report.projectRoot === undefined ? '' : ` (${report.projectRoot})`}`;
  }
  return 'current environment';
}

function overallStatus(checks: readonly DoctorCheck[]): DoctorCheckStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'pass';
}

function overallLabel(status: DoctorCheckStatus): string {
  if (status === 'fail') return 'Doctor found blocking issues';
  if (status === 'warning') return 'Doctor found items that need attention';
  return 'Your skill-sync setup looks healthy';
}

function statusCounts(checks: readonly DoctorCheck[]): Record<DoctorCheckStatus, number> {
  const counts: Record<DoctorCheckStatus, number> = {
    fail: 0,
    warning: 0,
    skipped: 0,
    pass: 0,
  };
  for (const check of checks) counts[check.status] += 1;
  return counts;
}

function orderedChecks(checks: readonly DoctorCheck[]): readonly DoctorCheck[] {
  return STATUS_ORDER.flatMap((status) => checks.filter((check) => check.status === status));
}

function sectionCount(visible: number, total: number): string {
  return visible === total
    ? `(${String(total)})`
    : `(showing ${String(visible)} of ${String(total)})`;
}

function nextAction(
  report: DoctorReport,
  overall: DoctorCheckStatus,
  remediationCount: number,
  options: DoctorReportFormatOptions,
): string {
  if (remediationCount > 0) {
    return 'Next: Complete action 1 above, then rerun the same skill-sync doctor command.';
  }
  if (overall === 'fail') {
    return 'Next: Resolve the first blocked check above, then rerun the same skill-sync doctor command.';
  }
  if (overall === 'warning') {
    return 'Next: Resolve the first attention check above, then rerun the same skill-sync doctor command.';
  }
  if (report.offline && report.checks.some((check) => check.status === 'skipped')) {
    return 'Next: Re-run the same skill-sync doctor command without --offline when remote access is available.';
  }
  if (report.scope === 'global') {
    return 'Next: Run skill-sync list --global to browse available skills.';
  }
  return `Next: Run ${scopedHumanCommand('project', 'list', options)} to browse available skills.`;
}

/** Render the structured doctor report without changing its JSON contract. */
export function formatDoctorReport(
  report: DoctorReport,
  options: DoctorReportFormatOptions = {},
): string {
  const color = options.color === true;
  const overall = overallStatus(report.checks);
  const counts = statusCounts(report.checks);
  const ordered = orderedChecks(report.checks);
  const visible = ordered.slice(0, HUMAN_DOCTOR_CHECK_LIMIT);
  const omitted = ordered.length - visible.length;
  const lines = [
    colour(`skill-sync doctor · ${overallLabel(overall)}`, STATUS_DETAILS[overall].color, color),
    `Scope: ${reportScope(report)}`,
    report.offline ? 'Remote checks: skipped (--offline)' : 'Remote checks: included',
    `Checks: pass ${String(counts.pass)}; warning ${String(counts.warning)}; fail ${String(counts.fail)}; skipped ${String(counts.skipped)}`,
  ];

  for (const status of STATUS_ORDER) {
    const checks = visible.filter((check) => check.status === status);
    if (checks.length === 0) continue;
    const heading = color
      ? `${formattedStatus(status, true)} ${STATUS_DETAILS[status].label}`
      : STATUS_DETAILS[status].label;
    lines.push('', `${heading} ${sectionCount(checks.length, counts[status])}`);
    for (const check of checks) {
      lines.push(`  ${checkLabel(check)}${check.scope === 'remote' ? ' · remote' : ''}`);
      lines.push(`    ${check.message}`);
    }
  }

  if (omitted > 0) lines.push('', `  … ${String(omitted)} more checks omitted`);

  const remediations = visible.filter(
    (check): check is DoctorCheck & { readonly remediation: string } =>
      (check.status === 'fail' || check.status === 'warning') && check.remediation !== undefined,
  );
  if (remediations.length > 0) {
    lines.push('', colour('Next actions', 35, color));
    for (const [index, check] of remediations.entries()) {
      lines.push(`${String(index + 1)}. ${checkLabel(check)} — ${check.remediation}`);
    }
  }

  lines.push('', nextAction(report, overall, remediations.length, options));
  return lines.join('\n');
}
