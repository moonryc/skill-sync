import { describe, expect, it } from 'vitest';

import { classifyReconciliation } from '../../src/domain/reconciliation.js';

const destination = (digest = 'base') => ({
  target: 'codex',
  path: '.codex/skills/hello',
  exists: true,
  digest,
});

describe('three-way reconciliation classification', () => {
  it.each([
    ['current', 'base', [destination('base')]],
    ['outdated', 'remote', [destination('base')]],
    ['locally-modified', 'base', [destination('local')]],
    ['conflicted', 'remote', [destination('local')]],
    ['missing', 'base', [{ target: 'codex', path: '.codex/skills/hello', exists: false }]],
    ['orphaned', undefined, [destination('base')]],
    ['unmanaged-collision', 'base', [{ ...destination(), unmanagedCollision: true }]],
  ] as const)('classifies %s', (state, libraryDigest, destinations) => {
    expect(classifyReconciliation({ baseDigest: 'base', libraryDigest, destinations }).state).toBe(
      state,
    );
  });

  it('treats divergent agent copies as a conflict', () => {
    const result = classifyReconciliation({
      baseDigest: 'base',
      libraryDigest: 'base',
      destinations: [
        destination('codex-change'),
        { target: 'claude', path: '.claude/skills/hello', exists: true, digest: 'claude-change' },
      ],
    });
    expect(result.state).toBe('conflicted');
    expect(result.divergentTargets).toEqual(['claude', 'codex']);
  });
});
