import { describe, expect, it } from 'vitest';

import {
  findCaseFoldCollisions,
  isPortableSlug,
  parseGroupPath,
  parseQualifiedSkillId,
  qualifySkillId,
  skillIdGroup,
  skillIdName,
  validateQualifiedSkillId,
} from '../../src/domain/identifiers.js';

describe('portable identifiers', () => {
  it('builds stable root and nested qualified identifiers', () => {
    expect(qualifySkillId('', 'format-code')).toBe('format-code');
    expect(qualifySkillId(['frontend', 'react'], 'create-component')).toBe(
      'frontend/react/create-component',
    );
    expect(skillIdGroup('frontend/react/create-component')).toBe('frontend/react');
    expect(skillIdName('frontend/react/create-component')).toBe('create-component');
    expect(parseGroupPath('')).toBe('');
  });

  it('rejects nonportable, traversal, and platform-reserved segments', () => {
    expect(isPortableSlug('review-ui')).toBe(true);
    expect(isPortableSlug('Review-UI')).toBe(false);
    expect(isPortableSlug('two--hyphens')).toBe(false);
    expect(isPortableSlug('con')).toBe(false);
    expect(validateQualifiedSkillId('../review-ui')).not.toHaveLength(0);
    expect(validateQualifiedSkillId('frontend\\review-ui')).not.toHaveLength(0);
    expect(() => parseQualifiedSkillId('/frontend/review-ui')).toThrow();
  });

  it('reports deterministic portable case-fold collisions', () => {
    expect(findCaseFoldCollisions(['Frontend/review-ui', 'frontend/review-ui', 'other'])).toEqual([
      {
        folded: 'frontend/review-ui',
        values: ['Frontend/review-ui', 'frontend/review-ui'],
      },
    ]);
  });
});
