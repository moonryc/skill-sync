import { describe, expect, it } from 'vitest';

import {
  formatInstallApplyCommand,
  formatInstallHuman,
  type InstallHumanResult,
} from '../../src/ui/install-output.js';

function skills(count: number, descending = false): InstallHumanResult['skills'] {
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
      status: 'install',
    };
  });
}

function result(overrides: Partial<InstallHumanResult> = {}): InstallHumanResult {
  const common = {
    applied: false,
    dryRun: true,
    fingerprint: `install-v1-${'a'.repeat(64)}`,
    freshness: 'fetched',
    libraryRevision: '1'.repeat(40),
    skills: skills(1),
    stale: false,
    writes: ['.codex/skills/skill-01', 'skill-sync.json', 'skill-sync.lock.json'],
  };
  if (overrides.scope === 'global') {
    return {
      ...common,
      scope: 'global',
      stateDirectory: '/state/global',
      ...overrides,
    };
  }
  return {
    ...common,
    gitignore: { changed: false, path: '/project/.gitignore' },
    projectRoot: '/project',
    scope: 'project',
    ...overrides,
  };
}

describe('install human output', () => {
  it.each([
    {
      expected:
        'skill-sync install examples/alpha examples/zulu --target claude --target codex --gitignore --expect-plan install-v1-reviewed',
      options: {
        all: false,
        fingerprint: 'install-v1-reviewed',
        gitignore: 'managed',
        scope: 'project',
        selectors: ['examples/zulu', 'examples/alpha'],
        targets: ['codex', 'claude'],
      },
    },
    {
      expected:
        'skill-sync --global install --all --target codex --expect-plan install-v1-reviewed',
      options: {
        all: true,
        fingerprint: 'install-v1-reviewed',
        scope: 'global',
        selectors: [],
        targets: ['codex'],
      },
    },
    {
      expected:
        'skill-sync --project <project-path> install examples/alpha --target claude --no-gitignore --expect-plan install-v1-reviewed',
      options: {
        all: false,
        explicitProject: true,
        fingerprint: 'install-v1-reviewed',
        gitignore: 'unmanaged',
        scope: 'project',
        selectors: ['examples/alpha'],
        targets: ['claude'],
      },
    },
  ] as const)('builds the reviewed apply command: $expected', ({ expected, options }) => {
    expect(formatInstallApplyCommand(options)).toBe(expected);
  });

  it('prints a directly copyable reviewed apply command when one is provided', () => {
    const applyCommand =
      'skill-sync install examples/skill-01 --target codex --gitignore --expect-plan install-v1-reviewed';
    const output = formatInstallHuman(result(), { applyCommand });

    expect(output).toContain(`Next: ${applyCommand}`);
    expect(output).not.toContain('Re-run the same skill-sync install command');
  });

  it('explains the safe project placeholder in an explicit-project apply command', () => {
    const output = formatInstallHuman(result(), {
      applyCommand:
        'skill-sync --project <project-path> install examples/skill-01 --target codex --gitignore --expect-plan install-v1-reviewed',
      explicitProject: true,
    });

    expect(output).toContain('Replace <project-path> with the project path shown in Scope above.');
  });

  it('keeps every reviewed skill and destination in a large dry-run preview', () => {
    const selected = skills(25, true);
    const output = formatInstallHuman(
      result({
        skills: selected,
        writes: selected.map((skill) => skill.projections[0]?.destination ?? ''),
      }),
    );

    expect(output).toContain('Install preview (no changes made).');
    expect(output).toContain('Skills:');
    expect(output).not.toContain('skills omitted');
    for (const skill of selected) {
      const projection = skill.projections[0];
      if (projection === undefined) throw new Error(`Missing projection for ${skill.id}.`);
      expect(output).toContain(`  ${skill.id}: install`);
      expect(output).toContain(`    codex: ${projection.destination}`);
    }
    expect(output).toContain(`--expect-plan install-v1-${'a'.repeat(64)}`);
  });

  it('keeps an inline confirmation inside the current interactive command', () => {
    const output = formatInstallHuman(result(), { continuation: 'inline-confirmation' });

    expect(output).toContain(
      'Next: Confirm the prompt below to apply this exact reviewed plan; no second command is needed.',
    );
    expect(output).not.toContain('Re-run the same skill-sync install command');
    expect(output).not.toContain('--expect-plan');
  });

  it('sorts and bounds only completed output to 20 skills', () => {
    const output = formatInstallHuman(
      result({
        applied: true,
        dryRun: false,
        skills: skills(25, true),
        writes: ['skill-sync.json'],
      }),
    );

    expect(output).toContain('Install complete.');
    expect(output).toContain('Writes completed: skill-sync.json');
    expect(output).not.toContain('Planned writes:');
    expect(output).toContain('Skills (showing 20 of 25):');
    expect(output).toContain('  examples/skill-20: install');
    expect(output).not.toContain('  examples/skill-21: install');
    expect(output).toContain('  … 5 more skills omitted');
    expect(output.indexOf('examples/skill-01')).toBeLessThan(output.indexOf('examples/skill-02'));
  });

  it.each([
    ['project', 'Next: Run skill-sync status to verify managed copies.'],
    ['global', 'Next: Run skill-sync --global status to verify managed copies.'],
  ] as const)('routes a no-op %s preview to scope-correct status', (scope, next) => {
    const global = scope === 'global';
    const output = formatInstallHuman(
      result({
        scope,
        skills: [
          {
            id: 'examples/skill-01',
            projections: [
              {
                destination: global
                  ? '/home/user/.codex/skills/skill-01'
                  : '.codex/skills/skill-01',
                target: 'codex',
                write: false,
              },
            ],
            status: 'already-installed',
          },
        ],
        writes: [],
      }),
    );

    expect(output).toContain(
      'Install preview: everything selected is already installed (no changes planned).',
    );
    expect(output).toContain('Planned writes: none');
    expect(output).toContain(next);
    expect(output).not.toContain('--expect-plan');
  });

  it('preserves an explicit project in completed verification guidance', () => {
    const output = formatInstallHuman(result({ applied: true, dryRun: false }), {
      explicitProject: true,
    });

    expect(output).toContain(
      'Next: Run skill-sync --project <project-path> status to verify managed copies.',
    );
  });
});
