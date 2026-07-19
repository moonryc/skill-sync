const portableSlugBrand: unique symbol = Symbol('PortableSlug');
const groupPathBrand: unique symbol = Symbol('GroupPath');
const qualifiedSkillIdBrand: unique symbol = Symbol('QualifiedSkillId');
const skillSelectorBrand: unique symbol = Symbol('SkillSelector');

export type PortableSlug = string & { readonly [portableSlugBrand]: true };
export type GroupPath = string & { readonly [groupPathBrand]: true };
export type QualifiedSkillId = string & { readonly [qualifiedSkillIdBrand]: true };
export type SkillSelector = string & { readonly [skillSelectorBrand]: true };

export const PORTABLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const WINDOWS_RESERVED_BASENAMES = new Set([
  'aux',
  'con',
  'nul',
  'prn',
  'clock$',
  ...Array.from({ length: 9 }, (_, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${String(index + 1)}`),
]);

export type IdentifierIssueCode =
  | 'empty'
  | 'not-string'
  | 'invalid-slug'
  | 'reserved-slug'
  | 'invalid-path'
  | 'case-fold-collision';

export interface IdentifierIssue {
  readonly code: IdentifierIssueCode;
  readonly value: unknown;
  readonly message: string;
}

export interface CaseFoldCollision {
  readonly folded: string;
  readonly values: readonly string[];
}

export class IdentifierValidationError extends Error {
  public readonly issues: readonly IdentifierIssue[];

  public constructor(message: string, issues: readonly IdentifierIssue[]) {
    super(message);
    this.name = 'IdentifierValidationError';
    this.issues = issues;
  }
}

/**
 * The portable fold is deliberately locale-independent. Qualified identifiers
 * are ASCII after validation, while normalization also makes this helper safe
 * to use when reporting collisions among invalid candidate paths.
 */
export function portableCaseFold(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

export function validatePortableSlug(value: unknown): readonly IdentifierIssue[] {
  if (typeof value !== 'string') {
    return [{ code: 'not-string', value, message: 'A portable slug must be a string.' }];
  }

  if (value.length === 0) {
    return [{ code: 'empty', value, message: 'A portable slug must not be empty.' }];
  }

  if (!PORTABLE_SLUG_PATTERN.test(value)) {
    return [
      {
        code: 'invalid-slug',
        value,
        message:
          'A portable slug must contain lowercase ASCII letters or digits separated by single hyphens.',
      },
    ];
  }

  if (WINDOWS_RESERVED_BASENAMES.has(portableCaseFold(value))) {
    return [
      {
        code: 'reserved-slug',
        value,
        message: `The slug "${value}" is reserved on a supported platform.`,
      },
    ];
  }

  return [];
}

export function isPortableSlug(value: unknown): value is PortableSlug {
  return validatePortableSlug(value).length === 0;
}

export function parsePortableSlug(value: unknown): PortableSlug {
  const issues = validatePortableSlug(value);
  if (issues.length > 0) {
    throw new IdentifierValidationError('Invalid portable slug.', issues);
  }
  return value as PortableSlug;
}

function pathSegments(value: string): readonly string[] | undefined {
  if (
    value.includes('\\') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('//')
  ) {
    return undefined;
  }
  return value.split('/');
}

function validateSegmentedPath(value: unknown, allowEmpty: boolean): readonly IdentifierIssue[] {
  if (typeof value !== 'string') {
    return [{ code: 'not-string', value, message: 'A portable path must be a string.' }];
  }

  if (value.length === 0) {
    return allowEmpty
      ? []
      : [{ code: 'empty', value, message: 'A portable path must not be empty.' }];
  }

  const segments = pathSegments(value);
  if (segments === undefined) {
    return [
      {
        code: 'invalid-path',
        value,
        message: 'A portable path must use nonempty forward-slash-separated segments.',
      },
    ];
  }

  return segments.flatMap((segment) => validatePortableSlug(segment));
}

/** The empty string represents the root group. */
export function validateGroupPath(value: unknown): readonly IdentifierIssue[] {
  return validateSegmentedPath(value, true);
}

export function isGroupPath(value: unknown): value is GroupPath {
  return validateGroupPath(value).length === 0;
}

export function parseGroupPath(value: unknown): GroupPath {
  const normalized = Array.isArray(value) ? value.join('/') : value;
  const issues = validateGroupPath(normalized);
  if (issues.length > 0) {
    throw new IdentifierValidationError('Invalid group path.', issues);
  }
  return normalized as GroupPath;
}

export function groupPathSegments(group: GroupPath): readonly PortableSlug[] {
  return group.length === 0 ? [] : (group.split('/') as PortableSlug[]);
}

export function validateQualifiedSkillId(value: unknown): readonly IdentifierIssue[] {
  return validateSegmentedPath(value, false);
}

export function isQualifiedSkillId(value: unknown): value is QualifiedSkillId {
  return validateQualifiedSkillId(value).length === 0;
}

export function parseQualifiedSkillId(value: unknown): QualifiedSkillId {
  const issues = validateQualifiedSkillId(value);
  if (issues.length > 0) {
    throw new IdentifierValidationError('Invalid qualified skill identifier.', issues);
  }
  return value as QualifiedSkillId;
}

export function qualifySkillId(
  group: GroupPath | string | readonly string[],
  name: PortableSlug | string,
): QualifiedSkillId {
  const parsedGroup = parseGroupPath(group);
  const parsedName = parsePortableSlug(name);
  return parseQualifiedSkillId(
    parsedGroup.length === 0 ? parsedName : `${parsedGroup}/${parsedName}`,
  );
}

export function skillIdName(id: QualifiedSkillId | string): PortableSlug {
  const parsed = parseQualifiedSkillId(id);
  return parsePortableSlug(parsed.slice(parsed.lastIndexOf('/') + 1));
}

export function skillIdGroup(id: QualifiedSkillId | string): GroupPath {
  const parsed = parseQualifiedSkillId(id);
  const separator = parsed.lastIndexOf('/');
  return parseGroupPath(separator === -1 ? '' : parsed.slice(0, separator));
}

export function validateSkillSelector(value: unknown): readonly IdentifierIssue[] {
  return validateQualifiedSkillId(value);
}

export function parseSkillSelector(value: unknown): SkillSelector {
  const issues = validateSkillSelector(value);
  if (issues.length > 0) {
    throw new IdentifierValidationError('Invalid skill selector.', issues);
  }
  return value as SkillSelector;
}

export function findCaseFoldCollisions(values: Iterable<string>): readonly CaseFoldCollision[] {
  const byFold = new Map<string, string[]>();

  for (const value of values) {
    const folded = portableCaseFold(value);
    const current = byFold.get(folded);
    if (current === undefined) {
      byFold.set(folded, [value]);
    } else {
      current.push(value);
    }
  }

  return [...byFold.entries()]
    .filter((entry) => entry[1].length > 1)
    .map(([folded, entries]) => ({ folded, values: [...entries].sort(comparePortableStrings) }))
    .sort((left, right) => comparePortableStrings(left.folded, right.folded));
}

export function caseFoldCollisionIssues(values: Iterable<string>): readonly IdentifierIssue[] {
  return findCaseFoldCollisions(values).map((collision) => ({
    code: 'case-fold-collision',
    value: collision.values,
    message: `Identifiers collide under portable case folding: ${collision.values.join(', ')}.`,
  }));
}

export function comparePortableStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
