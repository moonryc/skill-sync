import { describe, expect, it } from 'vitest';

import {
  resolveSkillSelector,
  resolveSkillSelectors,
  selectAllSkills,
} from '../../src/application/selectors.js';

const catalog = [
  { id: 'frontend/review-ui', name: 'review-ui' },
  { id: 'backend/review-ui', name: 'review-ui' },
  { id: 'testing/run-tests', name: 'run-tests' },
  { id: 'review-ui', name: 'review-ui' },
] as const;

describe('skill selector resolution', () => {
  it('prefers an exact qualified identifier before leaf matching', () => {
    expect(resolveSkillSelector(catalog, 'review-ui')).toEqual({
      success: true,
      value: { id: 'review-ui', name: 'review-ui' },
    });
    expect(resolveSkillSelector(catalog, 'run-tests')).toEqual({
      success: true,
      value: { id: 'testing/run-tests', name: 'run-tests' },
    });
  });

  it('reports every deterministic ambiguity candidate', () => {
    const groupedOnly = catalog.filter((candidate) => candidate.id !== 'review-ui');
    expect(resolveSkillSelector(groupedOnly, 'review-ui')).toMatchObject({
      success: false,
      error: {
        code: 'ambiguous-selector',
        candidates: ['backend/review-ui', 'frontend/review-ui'],
      },
    });
  });

  it('returns bounded deterministic typo candidates without resolving them', () => {
    expect(resolveSkillSelector(catalog, 'testing/run-tsets')).toEqual({
      success: false,
      error: {
        code: 'unknown-selector',
        selector: 'testing/run-tsets',
        message:
          'No catalog skill matches selector "testing/run-tsets". Closest exact ID: testing/run-tests.',
        candidates: ['testing/run-tests'],
      },
    });

    const tied = Array.from({ length: 5 }, (_value, index) => ({
      id: `group-${String(index)}/review-ui`,
      name: 'review-ui',
    }));
    expect(resolveSkillSelector(tied, 'revie-ui')).toMatchObject({
      success: false,
      error: {
        code: 'unknown-selector',
        candidates: ['group-0/review-ui', 'group-1/review-ui', 'group-2/review-ui'],
      },
    });
    expect(resolveSkillSelector(catalog, 'unrelated-name')).toMatchObject({
      success: false,
      error: { code: 'unknown-selector', candidates: [] },
    });
  });

  it('validates the whole explicit set before exposing values', () => {
    const result = resolveSkillSelectors(catalog, [
      'testing/run-tests',
      'missing-skill',
      'frontend/review-ui',
    ]);
    expect(result).toMatchObject({
      success: false,
      values: [],
      errors: [expect.objectContaining({ code: 'unknown-selector', selector: 'missing-skill' })],
    });

    const typo = resolveSkillSelectors(catalog, ['frontend/review-ui', 'run-tsets']);
    expect(typo).toMatchObject({
      success: false,
      values: [],
      errors: [
        expect.objectContaining({
          code: 'unknown-selector',
          selector: 'run-tsets',
          candidates: ['testing/run-tests'],
        }),
      ],
    });
  });

  it('deduplicates aliases and returns deterministic qualified-ID order', () => {
    expect(
      resolveSkillSelectors(catalog, [
        'testing/run-tests',
        'run-tests',
        'frontend/review-ui',
        'frontend/review-ui',
      ]),
    ).toMatchObject({
      success: true,
      values: [{ id: 'frontend/review-ui' }, { id: 'testing/run-tests' }],
    });
    expect(selectAllSkills(catalog)).toMatchObject({
      success: true,
      values: [
        { id: 'backend/review-ui' },
        { id: 'frontend/review-ui' },
        { id: 'review-ui' },
        { id: 'testing/run-tests' },
      ],
    });
  });
});
