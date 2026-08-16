import { describe, expect, it } from 'vitest';

import { formatAdoptHuman, type AdoptHumanResult } from '../../src/ui/adopt-output.js';

function result(overrides: Partial<AdoptHumanResult> = {}): AdoptHumanResult {
  return {
    applied: false,
    dryRun: true,
    freshness: 'fetched',
    libraryRevision: '1'.repeat(40),
    projectRoot: '/project',
    scope: 'project',
    skill: {
      destination: '.codex/skills/hello',
      id: 'examples/hello',
      target: 'codex',
    },
    stale: false,
    writes: ['skill-sync.json', 'skill-sync.lock.json'],
    ...overrides,
  };
}

describe('adopt human output', () => {
  it('labels a project preview as write-free and leaves target files unchanged', () => {
    const output = formatAdoptHuman(result({ freshness: 'cache-only', stale: true }));

    expect(output).toContain('Adoption preview (no files or tracking state changed).');
    expect(output).toContain('Scope: project (/project)');
    expect(output).toContain('Warning: adoption was checked against stale cached library data.');
    expect(output).toContain('Planned tracking writes: skill-sync.json, skill-sync.lock.json');
    expect(output).toContain('Target files: unchanged');
    expect(output).toContain(
      'Next: Re-run the same skill-sync adopt command without --dry-run to track this exact copy.',
    );
  });

  it('keeps completed global adoption verification in global scope', () => {
    const output = formatAdoptHuman(
      result({
        applied: true,
        dryRun: false,
        scope: 'global',
        stateDirectory: '/state/global',
        writes: ['/state/global/skill-sync.json', '/state/global/skill-sync.lock.json'],
      }),
    );

    expect(output).toContain('Adoption complete; the existing copy is now tracked.');
    expect(output).toContain('Scope: global (/state/global)');
    expect(output).toContain('Tracking writes completed:');
    expect(output).toContain('Next: Run skill-sync --global status to verify the managed copy.');
    expect(output).not.toContain('Next: Run skill-sync status to verify the managed copy.');
  });

  it('preserves an explicit project in completed verification guidance', () => {
    const output = formatAdoptHuman(result({ applied: true, dryRun: false }), {
      explicitProject: true,
    });

    expect(output).toContain(
      'Next: Run skill-sync --project <project-path> status to verify the managed copy.',
    );
  });
});
