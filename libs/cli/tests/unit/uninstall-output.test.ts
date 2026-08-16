import { describe, expect, it } from 'vitest';

import { formatUninstallHuman, type UninstallHumanResult } from '../../src/ui/uninstall-output.js';

function skills(count: number, descending = false): UninstallHumanResult['skills'] {
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  if (descending) ids.reverse();
  return ids.map((number) => {
    const suffix = String(number).padStart(2, '0');
    return {
      id: `examples/skill-${suffix}`,
      projections: [
        {
          destination: `.codex/skills/skill-${suffix}`,
          target: 'codex',
          write: true,
        },
      ],
    };
  });
}

function result(
  overrides: Partial<UninstallHumanResult> = {},
  options: { readonly omitGitignore?: boolean } = {},
): UninstallHumanResult {
  const merged: UninstallHumanResult = {
    applied: false,
    backup: { paths: [], required: false },
    dryRun: true,
    gitignore: { changed: false, path: '/project/.gitignore' },
    libraryRevision: '1'.repeat(40),
    projectRoot: '/project',
    scope: 'project',
    skills: skills(1),
    writes: ['.codex/skills/skill-01', 'skill-sync.json', 'skill-sync.lock.json'],
    ...overrides,
  };
  if (options.omitGitignore === true) {
    const { gitignore, ...withoutGitignore } = merged;
    void gitignore;
    return withoutGitignore;
  }
  return merged;
}

describe('uninstall human output', () => {
  it('keeps every selected skill and destination in a large dry-run preview', () => {
    const selected = skills(25, true);
    const output = formatUninstallHuman(
      result({
        skills: selected,
        writes: selected.map((skill) => skill.projections[0]?.destination ?? ''),
      }),
    );

    expect(output).toContain('Uninstall preview (no changes made).');
    expect(output).toContain('Skills:');
    expect(output).not.toContain('skills omitted');
    for (const skill of selected) {
      const projection = skill.projections[0];
      if (projection === undefined) throw new Error('Expected a test projection.');
      expect(output).toContain(`  ${skill.id}`);
      expect(output).toContain(`    codex: ${projection.destination} (remove)`);
    }
    expect(output).not.toContain('--yes');
  });

  it('names the required confirmation flag for a destructive preview that cannot prompt', () => {
    const output = formatUninstallHuman(
      result({
        backup: { paths: ['/backups/skill-01'], required: true },
      }),
      { requiresYes: true },
    );

    expect(output).toContain(
      'Next: Re-run the same skill-sync uninstall command without --dry-run and add --yes to apply this preview.',
    );
  });

  it('sorts and bounds completed output while keeping global verification in global scope', () => {
    const output = formatUninstallHuman(
      result(
        {
          applied: true,
          backup: { paths: ['/backups/skill-01'], required: true },
          dryRun: false,
          scope: 'global',
          skills: skills(25, true),
          stateDirectory: '/state/global',
          writes: ['/state/global/skill-sync.json'],
        },
        { omitGitignore: true },
      ),
    );

    expect(output).toContain('Uninstall complete.');
    expect(output).toContain('Backup: created for /backups/skill-01');
    expect(output).toContain('Writes completed: /state/global/skill-sync.json');
    expect(output).not.toContain('Planned writes:');
    expect(output).toContain('Skills (showing 20 of 25):');
    expect(output).toContain('  examples/skill-20');
    expect(output).not.toContain('  examples/skill-21');
    expect(output).toContain('  … 5 more skills omitted');
    expect(output.indexOf('examples/skill-01')).toBeLessThan(output.indexOf('examples/skill-02'));
    expect(output).toContain(
      'Next: Run skill-sync --global status to verify remaining managed skills.',
    );
    expect(output).not.toContain('Next: Run skill-sync status to verify remaining managed skills.');
  });

  it('keeps a cancelled global uninstall in global scope', () => {
    const output = formatUninstallHuman(
      result(
        {
          message: 'Uninstall cancelled before mutation.',
          scope: 'global',
          stateDirectory: '/state/global',
        },
        { omitGitignore: true },
      ),
    );

    expect(output).toContain('Uninstall cancelled before mutation.');
    expect(output).toContain(
      'Next: Run skill-sync --global status to review managed copies before retrying.',
    );
  });

  it('preserves an explicit project in completed verification guidance', () => {
    const output = formatUninstallHuman(result({ applied: true, dryRun: false }), {
      explicitProject: true,
    });

    expect(output).toContain(
      'Next: Run skill-sync --project <project-path> status to verify remaining managed skills.',
    );
  });
});
