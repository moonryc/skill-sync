import { comparePortableStrings, parseSkillSelector, skillIdName } from '../domain/identifiers.js';

const MAX_SELECTOR_SUGGESTIONS = 3;
const MAX_SELECTOR_SUGGESTION_DISTANCE = 2;
const MAX_SELECTOR_SUGGESTION_LENGTH = 128;
const MIN_SELECTOR_SUGGESTION_SIMILARITY = 0.6;

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

function boundedEditDistance(left: string, right: string): number {
  if (
    left.length > MAX_SELECTOR_SUGGESTION_LENGTH ||
    right.length > MAX_SELECTOR_SUGGESTION_LENGTH ||
    Math.abs(left.length - right.length) > MAX_SELECTOR_SUGGESTION_DISTANCE
  ) {
    return MAX_SELECTOR_SUGGESTION_DISTANCE + 1;
  }

  let previousPrevious: readonly number[] | undefined;
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      let distance = Math.min(
        (previous[rightIndex] ?? Number.POSITIVE_INFINITY) + 1,
        (current[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[rightIndex - 1] ?? Number.POSITIVE_INFINITY) + substitutionCost,
      );
      if (
        previousPrevious !== undefined &&
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        distance = Math.min(
          distance,
          (previousPrevious[rightIndex - 2] ?? Number.POSITIVE_INFINITY) + 1,
        );
      }
      current[rightIndex] = distance;
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous[right.length] ?? MAX_SELECTOR_SUGGESTION_DISTANCE + 1;
}

function typoCandidates(
  candidates: readonly SelectableSkill[],
  selector: string,
): readonly string[] {
  if (selector.length <= 2 || selector.length > MAX_SELECTOR_SUGGESTION_LENGTH) return [];
  const qualified = selector.includes('/');
  const scored = new Map<string, number>();
  for (const candidate of candidates) {
    const comparable = qualified ? candidate.id : leafName(candidate);
    if (comparable.length <= 2 || comparable.length > MAX_SELECTOR_SUGGESTION_LENGTH) continue;
    const distance = boundedEditDistance(selector, comparable);
    const length = Math.max(selector.length, comparable.length);
    const similarity = (length - distance) / length;
    if (
      distance === 0 ||
      distance > MAX_SELECTOR_SUGGESTION_DISTANCE ||
      similarity < MIN_SELECTOR_SUGGESTION_SIMILARITY
    ) {
      continue;
    }
    const previous = scored.get(candidate.id);
    if (previous === undefined || distance < previous) scored.set(candidate.id, distance);
  }

  const ordered = [...scored.entries()].sort(([leftId, leftDistance], [rightId, rightDistance]) => {
    return leftDistance === rightDistance
      ? comparePortableStrings(leftId, rightId)
      : leftDistance - rightDistance;
  });
  const bestDistance = ordered[0]?.[1];
  if (bestDistance === undefined) return [];
  return ordered
    .filter((entry) => entry[1] === bestDistance)
    .slice(0, MAX_SELECTOR_SUGGESTIONS)
    .map(([id]) => id);
}

function unknownSelectorMessage(selector: string, candidates: readonly string[]): string {
  const unknown = `No catalog skill matches selector "${selector}".`;
  if (candidates.length === 0) return unknown;
  return candidates.length === 1
    ? `${unknown} Closest exact ID: ${candidates[0] ?? ''}.`
    : `${unknown} Closest exact IDs: ${candidates.join(', ')}.`;
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

  const suggestions = typoCandidates(ordered, selector);
  return {
    success: false,
    error: {
      code: 'unknown-selector',
      selector,
      message: unknownSelectorMessage(selector, suggestions),
      candidates: suggestions,
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
