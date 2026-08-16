import { describe, expect, it } from 'vitest';

import type { RecoveryRecord, RecoveryRecordInspection } from '../../src/application/recovery.js';
import {
  formatRecoveryPruneHuman,
  formatRecoveryRecordHuman,
  formatRecoveryRecordsHuman,
  formatRecoveryRestoreHuman,
  formatRecoveryResumeHuman,
  formatRecoveryUnlockHuman,
  type RecoveryActionHumanResult,
} from '../../src/ui/recovery-output.js';

function record(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    id: 'journal-abc123-install-example',
    inspectOnly: false,
    kind: 'journal',
    operationId: 'install-example',
    path: '/state/journals/project-alpha/install-example.json',
    scope: 'project:alpha',
    scopeKind: 'project',
    status: 'prepared',
    ...overrides,
  };
}

function actionResult(
  overrides: Partial<RecoveryActionHumanResult> = {},
): RecoveryActionHumanResult {
  return {
    applied: false,
    entries: [
      {
        actions: ['move-original', 'commit-candidate'],
        destination: '.codex/skills/example',
        index: 0,
      },
    ],
    fingerprint: 'resume-fingerprint',
    id: 'journal-abc123-install-example',
    operationId: 'install-example',
    root: '/workspace/project',
    status: 'prepared',
    ...overrides,
  };
}

describe('recovery human output', () => {
  it('turns an empty list into a read-only diagnostic next step', () => {
    expect(formatRecoveryRecordsHuman([])).toBe(
      [
        'No recovery records found.',
        'Read-only: no changes made.',
        'Next: Run skill-sync doctor if another command still reports recovery evidence.',
      ].join('\n'),
    );
  });

  it('summarizes records deterministically and bounds the visible list', () => {
    const records = Array.from({ length: 22 }, (_, index) =>
      record({
        id: `journal-${String(index).padStart(2, '0')}`,
        inspectOnly: index === 0,
        status: index === 0 ? 'preparing' : 'prepared',
      }),
    ).reverse();
    const output = formatRecoveryRecordsHuman(records, { scope: 'project' });

    expect(output.split('\n').slice(0, 5).join('\n')).toBe(
      [
        'Recovery records (22) for scope filter project:',
        '  journal-00',
        '    Type: journal | Status: preparing | Scope: project:alpha | Mode: inspect-only',
        '  journal-01',
        '    Type: journal | Status: prepared | Scope: project:alpha | Mode: recoverable',
      ].join('\n'),
    );
    expect(output).toContain('  … 2 more recovery records omitted');
    expect(output).not.toContain('journal-20');
    expect(output.endsWith('Next: Run skill-sync recovery inspect journal-00.')).toBe(true);
  });

  it('explains the two recoverable inspection choices with scope-correct previews', () => {
    const inspection: RecoveryRecordInspection = {
      evidence: {
        entries: [{ destination: '.codex/skills/zeta' }, { destination: '.codex/skills/alpha' }],
      } as unknown as RecoveryRecordInspection['evidence'],
      record: record(),
    };

    expect(formatRecoveryRecordHuman(inspection)).toBe(
      [
        'Recovery record: journal-abc123-install-example',
        'Type: journal',
        'Status: prepared',
        'Scope: project:alpha',
        'Evidence path: /state/journals/project-alpha/install-example.json',
        'Mode: recoverable',
        'Affected destinations (2):',
        '  .codex/skills/alpha',
        '  .codex/skills/zeta',
        'Read-only: no changes made.',
        'Root: run from the affected project, or replace <affected-project> below with its path.',
        'Choose one direction (preview first):',
        '  Finish the interrupted operation: skill-sync --project <affected-project> recovery resume journal-abc123-install-example --dry-run',
        '  Return to the state before the operation: skill-sync --project <affected-project> recovery restore journal-abc123-install-example --dry-run',
        'Next: Run one preview above, review every destination, then apply only the direction you intend.',
      ].join('\n'),
    );
  });

  it('turns interrupted initialization evidence into a manual remote check and fresh preview', () => {
    const inspection: RecoveryRecordInspection = {
      evidence: {
        note: JSON.stringify({
          branch: 'main',
          configuration: 'prepared',
          expectedRevision: 'a'.repeat(40),
          planFingerprint: `init-v1-${'b'.repeat(64)}`,
          provider: 'confirmed',
          push: 'attempted',
          remote: {
            cloneUrl: 'git@github.com:acme/skills.git',
            identity: 'github.com/acme/skills',
          },
        }),
      } as unknown as RecoveryRecordInspection['evidence'],
      record: record({
        id: 'journal-init-example',
        inspectOnly: true,
        operationId: 'init-example',
        operationKind: 'library-initialization',
        scope: `library:${'c'.repeat(64)}`,
        scopeKind: 'library',
        status: 'failed',
      }),
    };

    const output = formatRecoveryRecordHuman(inspection);

    expect(output).toContain('Mode: inspect-only');
    expect(output).toContain('Initialization evidence:');
    expect(output).toContain('GitHub repository creation: confirmed');
    expect(output).toContain('Initial remote push: attempted');
    expect(output).toContain('external repository changes are never replayed or deleted');
    expect(output).toContain(
      'skill-sync init git@github.com:acme/skills.git --branch main --dry-run',
    );
    expect(output).toContain('a successful setup clears this evidence');
  });

  it('labels terminal journals and verified backups as cleanup-only', () => {
    const terminal = formatRecoveryRecordHuman({
      evidence: {} as RecoveryRecordInspection['evidence'],
      record: record({ status: 'committed' }),
    });
    const backup = formatRecoveryRecordHuman({
      evidence: {} as RecoveryRecordInspection['evidence'],
      record: record({
        id: 'backup-abc123-install-example',
        inspectOnly: true,
        kind: 'backup',
        status: 'available',
      }),
    });

    expect(terminal).toContain('Mode: cleanup-only');
    expect(terminal).toContain('Next: Preview cleanup with');
    expect(backup).toContain('Mode: cleanup-only');
    expect(backup).toContain('Next: Preview cleanup with');
  });

  it('shows lock ownership and routes a valid lock to a safe unlock preview', () => {
    const output = formatRecoveryRecordHuman({
      evidence: {
        createdAt: '2026-08-15T12:00:00.000Z',
        hostname: 'workstation',
        operationId: 'cache-refresh',
        pid: 4242,
        schemaVersion: 1,
        scope: { id: 'library-key', kind: 'library' },
      },
      record: record({
        id: 'lock-abc123-cache-refresh',
        kind: 'lock',
        operationId: 'cache-refresh',
        path: '/state/locks/cache-key.lock',
        scope: 'library:library-key',
        scopeKind: 'library',
        status: 'locked',
      }),
    });

    expect(output).toContain('Mode: recoverable');
    expect(output).toContain('Process: PID 4242 on workstation');
    expect(output).toContain('Created: 2026-08-15T12:00:00.000Z');
    expect(output).toContain(
      'Next: Preview safe removal with skill-sync recovery unlock lock-abc123-cache-refresh --dry-run.',
    );
    expect(output).not.toContain('00000000-0000-4000-8000-000000000000');
  });

  it('renders a bounded plain-language resume preview and exact apply step', () => {
    const entries = Array.from({ length: 22 }, (_, index) => ({
      actions: ['move-original', 'commit-candidate'] as const,
      destination: `.codex/skills/example-${String(index).padStart(2, '0')}`,
      index,
    }));
    const output = formatRecoveryResumeHuman(actionResult({ entries }), {
      dryRun: true,
      scopeKind: 'project',
    });

    expect(output.split('\n').slice(0, 8).join('\n')).toBe(
      [
        'Recovery resume preview (no changes made).',
        'Scope: project (/workspace/project)',
        'Record: journal-abc123-install-example',
        'Operation: install-example',
        'Current state: prepared',
        'Affected destinations (22):',
        '  .codex/skills/example-00: move the current destination to rollback storage; install the prepared replacement',
        '  .codex/skills/example-01: move the current destination to rollback storage; install the prepared replacement',
      ].join('\n'),
    );
    expect(output).toContain('  … 2 more destinations omitted');
    expect(output).not.toContain('move-original');
    expect(output).not.toContain('commit-candidate');
    expect(output).toContain(
      'Next: Apply this preview with skill-sync --project <affected-project> recovery resume journal-abc123-install-example.',
    );
  });

  it('adds explicit confirmation to recovery apply guidance when prompting is unavailable', () => {
    const resume = formatRecoveryResumeHuman(actionResult(), {
      dryRun: true,
      requiresYes: true,
      scopeKind: 'project',
    });
    const prune = formatRecoveryPruneHuman(
      {
        applied: false,
        entries: [],
        fingerprint: 'prune-fingerprint',
        ids: ['journal-terminal'],
      },
      {
        dryRun: true,
        requiresYes: true,
        root: '/workspace',
        scopeKind: 'project',
      },
    );

    expect(resume).toContain('recovery resume journal-abc123-install-example --yes.');
    expect(prune).toContain('recovery prune journal-terminal --yes.');
  });

  it('renders restore completion with plain-language actions and verification guidance', () => {
    expect(
      formatRecoveryRestoreHuman(
        actionResult({
          applied: true,
          entries: [
            {
              actions: ['remove-committed', 'restore-original', 'mark-restored'],
              destination: '.codex/skills/example',
              index: 0,
            },
          ],
          fingerprint: 'restore-fingerprint',
          status: 'rolled-back',
        }),
        { dryRun: false, scopeKind: 'project' },
      ),
    ).toBe(
      [
        'Recovery restore complete.',
        'Scope: project (/workspace/project)',
        'Record: journal-abc123-install-example',
        'Operation: install-example',
        'Final state: rolled-back',
        'Affected destinations (1):',
        '  .codex/skills/example: remove the committed replacement; restore the original destination; record the destination as restored',
        'Plan fingerprint: restore-fingerprint',
        'Next: Run skill-sync --project <affected-project> status to verify managed state.',
      ].join('\n'),
    );
  });

  it('summarizes exact prune paths and keeps the apply command scope-correct', () => {
    expect(
      formatRecoveryPruneHuman(
        {
          applied: false,
          entries: [
            {
              id: 'journal-terminal',
              kind: 'journal',
              paths: ['/workspace/.rollback/example', '/state/journals/example.json'],
            },
          ],
          fingerprint: 'prune-fingerprint',
          ids: ['journal-terminal'],
        },
        { dryRun: true, root: '/workspace', scopeKind: 'project' },
      ),
    ).toBe(
      [
        'Recovery prune preview (no changes made).',
        'Scope: project (/workspace)',
        'Selected records: 1',
        'Owned paths (2):',
        '  journal-terminal (journal): /state/journals/example.json',
        '  journal-terminal (journal): /workspace/.rollback/example',
        'Plan fingerprint: prune-fingerprint',
        'Next: Apply this preview with skill-sync --project <affected-project> recovery prune journal-terminal.',
      ].join('\n'),
    );
  });

  it('renders an abandoned-lock preview and explicit noninteractive apply step', () => {
    expect(
      formatRecoveryUnlockHuman(
        {
          applied: false,
          fingerprint: 'unlock-fingerprint',
          id: 'lock-abc123-cache-refresh',
          lastHeartbeatAt: '2026-08-15T12:00:15.000Z',
          owner: {
            createdAt: '2026-08-15T12:00:00.000Z',
            hostname: 'workstation',
            operationId: 'cache-refresh',
            pid: 4242,
            scope: { id: 'library-key', kind: 'library' },
          },
          path: '/state/locks/cache-key.lock',
          status: 'abandoned',
        },
        { dryRun: true, requiresYes: true },
      ),
    ).toBe(
      [
        'Recovery unlock preview (no changes made).',
        'Record: lock-abc123-cache-refresh',
        'Lock: /state/locks/cache-key.lock',
        'Owner: cache-refresh (PID 4242 on workstation)',
        'Scope: library:library-key',
        'Created: 2026-08-15T12:00:00.000Z',
        'Last heartbeat: 2026-08-15T12:00:15.000Z',
        'Proof: the recorded owner process is absent on this host and 60 seconds elapsed after its last heartbeat.',
        'Plan fingerprint: unlock-fingerprint',
        'Next: Apply this preview with skill-sync recovery unlock lock-abc123-cache-refresh --yes.',
      ].join('\n'),
    );
  });

  it('keeps a large prune retry bounded without inventing a literal record placeholder', () => {
    const output = formatRecoveryPruneHuman(
      {
        applied: false,
        entries: [
          {
            id: 'journal-0',
            kind: 'journal',
            paths: Array.from(
              { length: 22 },
              (_, index) => `/state/path-${String(index).padStart(2, '0')}`,
            ),
          },
        ],
        fingerprint: 'prune-fingerprint',
        ids: Array.from({ length: 6 }, (_, index) => `journal-${String(index)}`),
      },
      { dryRun: true, root: '/workspace', scopeKind: 'project' },
    );

    expect(output).toContain(
      'Next: Re-run the same recovery prune selection without --dry-run to apply this preview.',
    );
    expect(output).toContain('Owned paths (22):');
    expect(output).toContain('  … 2 more owned paths omitted');
    expect(output).not.toContain('/state/path-20');
    expect(output).not.toContain('<same-record-ids>');
  });
});
