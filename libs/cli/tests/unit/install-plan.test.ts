import { describe, expect, it } from 'vitest';

import {
  INSTALL_PLAN_FINGERPRINT_PATTERN,
  installPlanFingerprint,
  type InstallPlanFingerprintInput,
} from '../../src/application/install-plan.js';

function reviewedInput(): InstallPlanFingerprintInput {
  return {
    libraryIdentity: 'github.com/acme/skills',
    libraryRevision: 'a'.repeat(40),
    location: '/workspace/project',
    originals: [
      { destination: 'skill-sync.json', digest: '1'.repeat(64) },
      { destination: '.codex/skills/hello', digest: null },
    ],
    scope: 'project',
    skills: [
      {
        digest: 'b'.repeat(64),
        id: 'examples/hello',
        projections: [
          { destination: '.claude/skills/hello', target: 'claude', write: true },
          { destination: '.codex/skills/hello', target: 'codex', write: true },
        ],
        status: 'install',
      },
    ],
    state: {
      after: {
        lock: { skills: [{ id: 'examples/hello' }] },
        manifest: { skills: [{ id: 'examples/hello' }] },
      },
      before: { lock: undefined, manifest: undefined },
    },
    writes: ['skill-sync.json', '.codex/skills/hello'],
  };
}

describe('reviewed install plan fingerprints', () => {
  it('uses a versioned digest and canonicalizes arrays and undefined inputs', () => {
    const input = reviewedInput();
    const reordered: InstallPlanFingerprintInput = {
      ...input,
      gitignore: null,
      originals: [...input.originals].reverse(),
      skills: input.skills.map((skill) => ({
        ...skill,
        projections: [...skill.projections].reverse(),
      })),
      state: {
        ...input.state,
        before: { lock: null, manifest: null },
      },
      writes: [...input.writes].reverse(),
    };

    const fingerprint = installPlanFingerprint(input);
    expect(fingerprint).toMatch(INSTALL_PLAN_FINGERPRINT_PATTERN);
    expect(installPlanFingerprint(reordered)).toBe(fingerprint);
  });

  it('changes when a review-bound input changes', () => {
    const input = reviewedInput();
    const fingerprint = installPlanFingerprint(input);
    const changedInputs: readonly InstallPlanFingerprintInput[] = [
      { ...input, libraryIdentity: 'github.com/other/skills' },
      { ...input, libraryRevision: 'c'.repeat(40) },
      { ...input, location: '/another/project' },
      {
        ...input,
        originals: [{ destination: '.codex/skills/hello', digest: 'd'.repeat(64) }],
      },
      { ...input, scope: 'global' },
      {
        ...input,
        skills: input.skills.map((skill) => ({ ...skill, digest: 'e'.repeat(64) })),
      },
      {
        ...input,
        state: {
          ...input.state,
          after: { ...input.state.after, lock: { skills: [] } },
        },
      },
      { ...input, gitignore: { after: '/managed/\n', before: '' } },
      { ...input, writes: [...input.writes, 'skill-sync.lock.json'] },
    ];

    for (const changed of changedInputs) {
      expect(installPlanFingerprint(changed)).not.toBe(fingerprint);
    }
  });
});
