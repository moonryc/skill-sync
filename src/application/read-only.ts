import { isPortableSlug, parseGroupPath, comparePortableStrings } from '../domain/identifiers.js';
import {
  type LibraryValidationIssue,
  type SkillValidationResult,
  validateLibrary,
  validateSkillDirectory,
} from '../domain/library.js';
import type { RegularFileInventoryEntry } from '../domain/digest.js';
import {
  type CatalogInstallationState,
  type CatalogScanResult,
  type CatalogSkillRecord,
} from './catalog.js';
import { resolveSkillSelector, type SelectorResolutionIssue } from './selectors.js';

export interface CatalogFilters {
  readonly groups?: readonly string[];
  readonly queries?: readonly string[];
  readonly agents?: readonly string[];
  readonly states?: readonly string[];
}

export type CatalogQueryIssueCode =
  | 'invalid-catalog'
  | 'invalid-group-filter'
  | 'invalid-agent-filter'
  | 'invalid-state-filter'
  | 'invalid-selector'
  | 'unknown-selector'
  | 'ambiguous-selector'
  | 'duplicate-candidate-id';

export interface CatalogQueryIssue {
  readonly code: CatalogQueryIssueCode;
  readonly message: string;
  readonly value: string | null;
  readonly candidates: readonly string[];
}

export interface CatalogListItem {
  readonly id: string;
  readonly name: string;
  readonly group: string | null;
  readonly description: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly compatibleAgents: readonly string[];
  readonly installationState: CatalogInstallationState;
}

export type CatalogListResult =
  | { readonly ok: true; readonly items: readonly CatalogListItem[] }
  | {
      readonly ok: false;
      readonly items: readonly [];
      readonly errors: readonly CatalogQueryIssue[];
    };

export interface CatalogSkillInfo extends CatalogListItem {
  readonly sourceRevision: string | null;
  readonly digest: string;
  readonly inventory: readonly RegularFileInventoryEntry[];
}

export type CatalogInfoResult =
  | { readonly ok: true; readonly info: CatalogSkillInfo }
  | { readonly ok: false; readonly errors: readonly CatalogQueryIssue[] };

const INSTALLATION_STATES: ReadonlySet<string> = new Set<CatalogInstallationState>([
  'not-installed',
  'current',
  'outdated',
  'locally-modified',
  'conflicted',
  'missing',
  'orphaned',
  'unmanaged-collision',
]);

function libraryIssueToCatalogIssue(issue: LibraryValidationIssue): CatalogQueryIssue {
  return {
    code: 'invalid-catalog',
    message: `${issue.path}: ${issue.message}`,
    value: issue.path,
    candidates: [],
  };
}

function selectorIssueToCatalogIssue(issue: SelectorResolutionIssue): CatalogQueryIssue {
  return {
    code: issue.code,
    message: issue.message,
    value: issue.selector,
    candidates: issue.candidates,
  };
}

function listItem(record: CatalogSkillRecord): CatalogListItem {
  return {
    id: record.id,
    name: record.name,
    group: record.group,
    description: record.description,
    metadata: record.metadata,
    compatibleAgents: record.compatibleAgents,
    installationState: record.installationState,
  };
}

function infoItem(record: CatalogSkillRecord): CatalogSkillInfo {
  return {
    ...listItem(record),
    sourceRevision: record.sourceRevision,
    digest: record.digest,
    inventory: record.inventory,
  };
}

function validateFilters(filters: CatalogFilters): readonly CatalogQueryIssue[] {
  const errors: CatalogQueryIssue[] = [];

  for (const group of filters.groups ?? []) {
    try {
      parseGroupPath(group);
    } catch (error) {
      errors.push({
        code: 'invalid-group-filter',
        message: error instanceof Error ? error.message : `Invalid group filter "${group}".`,
        value: group,
        candidates: [],
      });
    }
  }

  for (const agent of filters.agents ?? []) {
    if (!isPortableSlug(agent)) {
      errors.push({
        code: 'invalid-agent-filter',
        message: `Agent filter "${agent}" must be a portable lowercase slug.`,
        value: agent,
        candidates: [],
      });
    }
  }

  for (const state of filters.states ?? []) {
    if (!INSTALLATION_STATES.has(state)) {
      errors.push({
        code: 'invalid-state-filter',
        message: `Unknown installation-state filter "${state}".`,
        value: state,
        candidates: [],
      });
    }
  }

  return errors.sort((left, right) => {
    const codeOrder = comparePortableStrings(left.code, right.code);
    return codeOrder === 0
      ? comparePortableStrings(left.value ?? '', right.value ?? '')
      : codeOrder;
  });
}

function belongsToGroupSubtree(record: CatalogSkillRecord, group: string): boolean {
  if (group.length === 0) return true;
  return record.group === group || record.group?.startsWith(`${group}/`) === true;
}

/**
 * Apply AND across filter kinds and OR within each repeated filter kind. Input
 * ordering is never trusted; results are always sorted by qualified ID.
 */
export function filterCatalogRecords(
  records: readonly CatalogSkillRecord[],
  filters: CatalogFilters = {},
): CatalogListResult {
  const errors = validateFilters(filters);
  if (errors.length > 0) return { ok: false, items: [], errors };

  const groups = [...new Set(filters.groups ?? [])];
  const queries = [...new Set(filters.queries ?? [])].map((query) => query.toLowerCase());
  const agents = new Set(filters.agents ?? []);
  const states = new Set(filters.states ?? []);

  const items = [...records]
    .sort((left, right) => comparePortableStrings(left.id, right.id))
    .filter((record) => {
      const inGroup =
        groups.length === 0 || groups.some((group) => belongsToGroupSubtree(record, group));
      const searchable = `${record.id}\n${record.description}`.toLowerCase();
      const matchesQuery =
        queries.length === 0 || queries.some((query) => searchable.includes(query));
      const supportsAgent =
        agents.size === 0 || record.compatibleAgents.some((agent) => agents.has(agent));
      const hasState = states.size === 0 || states.has(record.installationState);
      return inGroup && matchesQuery && supportsAgent && hasState;
    })
    .map(listItem);

  return { ok: true, items };
}

export function listCatalog(
  catalog: CatalogScanResult,
  filters: CatalogFilters = {},
): CatalogListResult {
  if (!catalog.valid) {
    return {
      ok: false,
      items: [],
      errors: catalog.errors.map(libraryIssueToCatalogIssue),
    };
  }
  return filterCatalogRecords(catalog.records, filters);
}

/** Deterministic terminal text with explicit root/nested group headings. */
export function formatCatalogListHuman(items: readonly CatalogListItem[]): string {
  if (items.length === 0) return 'No skills found.';

  const lines: string[] = [];
  let previousGroup: string | null | undefined;
  for (const item of [...items].sort((left, right) => comparePortableStrings(left.id, right.id))) {
    if (item.group !== previousGroup) {
      lines.push(`${item.group ?? '(root)'}:`);
      previousGroup = item.group;
    }
    const agents = item.compatibleAgents.join(', ');
    lines.push(`  ${item.id} — ${item.description} [${agents}] (${item.installationState})`);
  }
  return lines.join('\n');
}

/** Resolve an info selector and project only metadata, hashes, and file names. */
export function getCatalogSkillInfo(
  catalog: CatalogScanResult,
  selector: string,
): CatalogInfoResult {
  if (!catalog.valid) {
    return {
      ok: false,
      errors: catalog.errors.map(libraryIssueToCatalogIssue),
    };
  }

  const resolution = resolveSkillSelector(catalog.records, selector);
  if (!resolution.success) {
    return { ok: false, errors: [selectorIssueToCatalogIssue(resolution.error)] };
  }
  return { ok: true, info: infoItem(resolution.value) };
}

/** Format info without reading or including any file body. */
export function formatCatalogSkillInfoHuman(info: CatalogSkillInfo): string {
  const lines = [
    `ID: ${info.id}`,
    `Group: ${info.group ?? '(root)'}`,
    `Description: ${info.description}`,
    `Agents: ${info.compatibleAgents.join(', ')}`,
    `State: ${info.installationState}`,
    `Revision: ${info.sourceRevision ?? 'unknown'}`,
    `Digest: ${info.digest}`,
    'Files:',
  ];
  for (const file of info.inventory) {
    lines.push(`  ${file.relativePath} (${String(file.size)} bytes, sha256:${file.sha256})`);
  }
  return lines.join('\n');
}

export type ReadOnlyValidationKind =
  'library' | 'catalog' | 'skill-id' | 'installed-skill' | 'local-path';

export interface InstalledSkillCopy {
  readonly target: string;
  readonly path: string;
}

export type ReadOnlyValidationSource =
  | { readonly kind: 'library'; readonly rootPath: string }
  | { readonly kind: 'catalog'; readonly catalog: CatalogScanResult }
  | {
      readonly kind: 'skill-id';
      readonly catalog: CatalogScanResult;
      readonly selector: string;
    }
  | {
      readonly kind: 'installed-skill';
      readonly id: string;
      readonly copies: readonly InstalledSkillCopy[];
    }
  | { readonly kind: 'local-path'; readonly path: string; readonly expectedId?: string };

export type ReadOnlyValidationIssueCode =
  | 'invalid-library'
  | 'invalid-catalog'
  | 'invalid-skill'
  | 'invalid-selector'
  | 'unknown-selector'
  | 'ambiguous-selector'
  | 'duplicate-candidate-id'
  | 'no-installed-copies'
  | 'divergent-installed-copies';

export interface ReadOnlyValidationIssue {
  readonly code: ReadOnlyValidationIssueCode;
  readonly source: string;
  readonly message: string;
  readonly candidates: readonly string[];
}

export interface ValidatedSkillSummary {
  readonly id: string;
  /** A caller-supplied path/target label; never file contents. */
  readonly source: string;
  readonly digest: string;
  readonly inventory: readonly RegularFileInventoryEntry[];
}

export interface ReadOnlyValidationResult {
  readonly kind: ReadOnlyValidationKind;
  readonly valid: boolean;
  readonly skills: readonly ValidatedSkillSummary[];
  readonly errors: readonly ReadOnlyValidationIssue[];
}

function libraryValidationIssue(
  issue: LibraryValidationIssue,
  code: 'invalid-library' | 'invalid-skill',
  sourcePrefix = '',
): ReadOnlyValidationIssue {
  const source = sourcePrefix.length === 0 ? issue.path : `${sourcePrefix}:${issue.path}`;
  return { code, source, message: issue.message, candidates: [] };
}

function selectorValidationIssue(issue: SelectorResolutionIssue): ReadOnlyValidationIssue {
  return {
    code: issue.code,
    source: issue.selector,
    message: issue.message,
    candidates: issue.candidates,
  };
}

function summaryFromRecord(record: CatalogSkillRecord, source: string): ValidatedSkillSummary {
  return {
    id: record.id,
    source,
    digest: record.digest,
    inventory: record.inventory,
  };
}

function summaryFromSkillValidation(
  result: SkillValidationResult,
  source: string,
): ValidatedSkillSummary | null {
  if (!result.valid || result.skill === null) return null;
  return {
    id: result.skill.id,
    source,
    digest: result.skill.digest,
    inventory: result.skill.files,
  };
}

function invalidCatalogResult(
  kind: ReadOnlyValidationKind,
  catalog: CatalogScanResult,
): ReadOnlyValidationResult {
  return {
    kind,
    valid: false,
    skills: [],
    errors: catalog.errors.map((issue) => ({
      code: 'invalid-catalog',
      source: issue.path,
      message: issue.message,
      candidates: [],
    })),
  };
}

async function validateInstalledSkill(
  source: Extract<ReadOnlyValidationSource, { readonly kind: 'installed-skill' }>,
): Promise<ReadOnlyValidationResult> {
  if (source.copies.length === 0) {
    return {
      kind: source.kind,
      valid: false,
      skills: [],
      errors: [
        {
          code: 'no-installed-copies',
          source: source.id,
          message: `Installed skill "${source.id}" has no tracked copies to validate.`,
          candidates: [],
        },
      ],
    };
  }

  const errors: ReadOnlyValidationIssue[] = [];
  const skills: ValidatedSkillSummary[] = [];
  const orderedCopies = [...source.copies].sort((left, right) => {
    const targetOrder = comparePortableStrings(left.target, right.target);
    return targetOrder === 0 ? comparePortableStrings(left.path, right.path) : targetOrder;
  });

  for (const copy of orderedCopies) {
    const label = `${copy.target}:${copy.path}`;
    const validation = await validateSkillDirectory(copy.path, source.id);
    errors.push(
      ...validation.errors.map((issue) => libraryValidationIssue(issue, 'invalid-skill', label)),
    );
    const summary = summaryFromSkillValidation(validation, label);
    if (summary !== null) skills.push(summary);
  }

  const digests = new Set(skills.map((skill) => skill.digest));
  if (skills.length === source.copies.length && digests.size > 1) {
    errors.push({
      code: 'divergent-installed-copies',
      source: source.id,
      message: `Installed copies of "${source.id}" have different content digests.`,
      candidates: skills.map((skill) => skill.source),
    });
  }

  return {
    kind: source.kind,
    valid: errors.length === 0,
    skills,
    errors,
  };
}

/**
 * Validate one explicitly typed read-only source. No branch writes, cache
 * refreshes, project writes, content copies, or skill execution occur here.
 */
export async function validateReadOnlySource(
  source: ReadOnlyValidationSource,
): Promise<ReadOnlyValidationResult> {
  switch (source.kind) {
    case 'library': {
      const validation = await validateLibrary(source.rootPath);
      return {
        kind: source.kind,
        valid: validation.valid,
        skills: validation.skills.map((skill) => ({
          id: skill.id,
          source: `library:${skill.id}`,
          digest: skill.digest,
          inventory: skill.files,
        })),
        errors: validation.errors.map((issue) => libraryValidationIssue(issue, 'invalid-library')),
      };
    }
    case 'catalog':
      if (!source.catalog.valid) return invalidCatalogResult(source.kind, source.catalog);
      return {
        kind: source.kind,
        valid: true,
        skills: source.catalog.records.map((record) =>
          summaryFromRecord(record, `catalog:${record.id}`),
        ),
        errors: [],
      };
    case 'skill-id': {
      if (!source.catalog.valid) return invalidCatalogResult(source.kind, source.catalog);
      const resolution = resolveSkillSelector(source.catalog.records, source.selector);
      if (!resolution.success) {
        return {
          kind: source.kind,
          valid: false,
          skills: [],
          errors: [selectorValidationIssue(resolution.error)],
        };
      }
      return {
        kind: source.kind,
        valid: true,
        skills: [summaryFromRecord(resolution.value, `catalog:${resolution.value.id}`)],
        errors: [],
      };
    }
    case 'installed-skill':
      return validateInstalledSkill(source);
    case 'local-path': {
      const validation = await validateSkillDirectory(source.path, source.expectedId);
      const summary = summaryFromSkillValidation(validation, source.path);
      return {
        kind: source.kind,
        valid: validation.valid,
        skills: summary === null ? [] : [summary],
        errors: validation.errors.map((issue) =>
          libraryValidationIssue(issue, 'invalid-skill', source.path),
        ),
      };
    }
  }
}
