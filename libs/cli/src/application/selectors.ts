import { comparePortableStrings, parseSkillSelector, skillIdName } from '../domain/identifiers.js';

export interface SelectableSkill {
  readonly id: string;
  readonly name?: string;
}

export type SelectorResolutionIssueCode =
  'invalid-selector' | 'unknown-selector' | 'ambiguous-selector' | 'duplicate-candidate-id';

export interface SelectorResolutionIssue {
  readonly code: SelectorResolutionIssueCode;
  readonly selector: string;
  readonly message: string;
  readonly candidates: readonly string[];
}

export type SelectorResolution<T extends SelectableSkill> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly error: SelectorResolutionIssue };

export type SelectionResolution<T extends SelectableSkill> =
  | { readonly success: true; readonly values: readonly T[] }
  | {
      readonly success: false;
      /** Empty by design so a caller cannot accidentally consume a partial selection. */
      readonly values: readonly [];
      readonly errors: readonly SelectorResolutionIssue[];
    };

function sortedCandidates<T extends SelectableSkill>(candidates: readonly T[]): readonly T[] {
  return [...candidates].sort((left, right) => comparePortableStrings(left.id, right.id));
}

function leafName(candidate: SelectableSkill): string {
  return candidate.name ?? skillIdName(candidate.id);
}

export function resolveSkillSelector<T extends SelectableSkill>(
  candidates: readonly T[],
  selector: string,
): SelectorResolution<T> {
  try {
    parseSkillSelector(selector);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'invalid-selector',
        selector,
        message: error instanceof Error ? error.message : `Invalid selector "${selector}".`,
        candidates: [],
      },
    };
  }

  const ordered = sortedCandidates(candidates);
  const exact = ordered.filter((candidate) => candidate.id === selector);
  const exactMatch = exact.at(0);
  if (exact.length === 1 && exactMatch !== undefined) {
    return { success: true, value: exactMatch };
  }
  if (exact.length > 1) {
    return {
      success: false,
      error: {
        code: 'duplicate-candidate-id',
        selector,
        message: `The candidate catalog contains duplicate identifier "${selector}".`,
        candidates: exact.map((candidate) => candidate.id),
      },
    };
  }

  if (!selector.includes('/')) {
    const leafMatches = ordered.filter((candidate) => leafName(candidate) === selector);
    const leafMatch = leafMatches.at(0);
    if (leafMatches.length === 1 && leafMatch !== undefined) {
      return { success: true, value: leafMatch };
    }
    if (leafMatches.length > 1) {
      const candidateIds = leafMatches.map((candidate) => candidate.id);
      return {
        success: false,
        error: {
          code: 'ambiguous-selector',
          selector,
          message: `Selector "${selector}" is ambiguous; choose one of: ${candidateIds.join(', ')}.`,
          candidates: candidateIds,
        },
      };
    }
  }

  return {
    success: false,
    error: {
      code: 'unknown-selector',
      selector,
      message: `No catalog skill matches selector "${selector}".`,
      candidates: [],
    },
  };
}

function duplicateCandidateIssues(
  candidates: readonly SelectableSkill[],
): readonly SelectorResolutionIssue[] {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter((entry) => entry[1] > 1)
    .sort(([left], [right]) => comparePortableStrings(left, right))
    .map(([id]) => ({
      code: 'duplicate-candidate-id',
      selector: id,
      message: `The candidate catalog contains duplicate identifier "${id}".`,
      candidates: [id],
    }));
}

/**
 * Resolve every selector before returning any values. Repeated selectors and
 * aliases that resolve to the same qualified ID collapse to one logical skill.
 */
export function resolveSkillSelectors<T extends SelectableSkill>(
  candidates: readonly T[],
  selectors: readonly string[],
): SelectionResolution<T> {
  const errors = [...duplicateCandidateIssues(candidates)];
  const resolvedById = new Map<string, T>();

  for (const selector of selectors) {
    const result = resolveSkillSelector(candidates, selector);
    if (result.success) {
      resolvedById.set(result.value.id, result.value);
    } else {
      errors.push(result.error);
    }
  }

  if (errors.length > 0) {
    errors.sort((left, right) => {
      const selectorOrder = comparePortableStrings(left.selector, right.selector);
      return selectorOrder === 0 ? comparePortableStrings(left.code, right.code) : selectorOrder;
    });
    return { success: false, values: [], errors };
  }

  return {
    success: true,
    values: [...resolvedById.values()].sort((left, right) =>
      comparePortableStrings(left.id, right.id),
    ),
  };
}

/** Return the entire eligible set in the same deterministic order as explicit selection. */
export function selectAllSkills<T extends SelectableSkill>(
  candidates: readonly T[],
): SelectionResolution<T> {
  const duplicateErrors = duplicateCandidateIssues(candidates);
  if (duplicateErrors.length > 0) {
    return { success: false, values: [], errors: duplicateErrors };
  }
  return { success: true, values: sortedCandidates(candidates) };
}
