import { describe, expect, it } from 'vitest';

import {
  INIT_PLAN_FINGERPRINT_PATTERN,
  initPlanFingerprint,
  type InitPlanFingerprintInput,
} from '../../src/application/init-plan.js';

function input(overrides: Partial<InitPlanFingerprintInput> = {}): InitPlanFingerprintInput {
  return {
    action: 'connect',
    branch: 'main',
    configuration: {
      after: { library: { identity: 'github.com/acme/skills' }, schemaVersion: 1 },
      before: { schemaVersion: 1 },
    },
    effects: {
      cache: 'refresh',
      configuration: 'write',
      githubRepository: 'none',
      remoteLibrary: 'none',
    },
    remote: {
      cloneUrl: 'https://github.com/acme/skills.git',
      identity: 'github.com/acme/skills',
      transport: 'https',
    },
    repository: null,
    revision: 'a'.repeat(40),
    validation: { groups: 2, skills: 4 },
    visibility: null,
    ...overrides,
  };
}

describe('initialization plan fingerprints', () => {
  it('is deterministic across object key order', () => {
    const first = initPlanFingerprint(input());
    const second = initPlanFingerprint(
      input({
        configuration: {
          after: { schemaVersion: 1, library: { identity: 'github.com/acme/skills' } },
          before: { schemaVersion: 1 },
        },
      }),
    );

    expect(first).toBe(second);
    expect(first).toMatch(INIT_PLAN_FINGERPRINT_PATTERN);
  });

  it.each([
    ['remote revision', { revision: 'b'.repeat(40) }],
    ['branch', { branch: 'develop' }],
    ['configuration', { configuration: { before: null, after: { schemaVersion: 1 } } }],
    ['remote action', { action: 'initialize-empty', revision: null, validation: null }],
  ] as const)('changes when the reviewed %s changes', (_label, override) => {
    expect(initPlanFingerprint(input(override))).not.toBe(initPlanFingerprint(input()));
  });
});
