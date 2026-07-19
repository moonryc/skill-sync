import type { RegularFileInventoryEntry } from '../domain/digest.js';
import { comparePortableStrings } from '../domain/identifiers.js';
import {
  type LibraryValidationIssue,
  type LibraryValidationResult,
  type SkillFrontMatter,
  validateLibrary,
} from '../domain/library.js';

export type CatalogInstallationState =
  | 'not-installed'
  | 'current'
  | 'outdated'
  | 'locally-modified'
  | 'conflicted'
  | 'missing'
  | 'orphaned'
  | 'unmanaged-collision';

export interface CatalogSkillRecord {
  readonly id: string;
  readonly name: string;
  /** `null` denotes a root-level skill. */
  readonly group: string | null;
  readonly description: string;
  readonly compatibleAgents: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly frontMatter: SkillFrontMatter;
  readonly sourceRevision: string | null;
  readonly digest: string;
  readonly inventory: readonly RegularFileInventoryEntry[];
  readonly relativeRoot: string;
  readonly rootPath: string;
  readonly installationState: CatalogInstallationState;
}

export interface CatalogScanOptions {
  readonly sourceRevision?: string;
  readonly installationStates?: Readonly<Partial<Record<string, CatalogInstallationState>>>;
}

export interface CatalogScanResult {
  readonly valid: boolean;
  readonly libraryRoot: string;
  readonly sourceRevision: string | null;
  /** Invalid catalogs never return a partial selectable record set. */
  readonly records: readonly CatalogSkillRecord[];
  readonly errors: readonly LibraryValidationIssue[];
}

function metadataRecord(frontMatter: SkillFrontMatter): Readonly<Record<string, unknown>> {
  return frontMatter.metadata ?? {};
}

export function catalogFromValidatedLibrary(
  validation: LibraryValidationResult,
  options: CatalogScanOptions = {},
): CatalogScanResult {
  const sourceRevision = options.sourceRevision ?? null;
  if (!validation.valid) {
    return {
      valid: false,
      libraryRoot: validation.rootPath,
      sourceRevision,
      records: [],
      errors: validation.errors,
    };
  }

  const records = validation.skills
    .map((skill): CatalogSkillRecord => ({
      id: skill.id,
      name: skill.name,
      group: skill.group.length === 0 ? null : skill.group,
      description: skill.description,
      compatibleAgents: skill.compatibleAgents,
      metadata: metadataRecord(skill.frontMatter),
      frontMatter: skill.frontMatter,
      sourceRevision,
      digest: skill.digest,
      inventory: skill.files,
      relativeRoot: `skills/${skill.id}`,
      rootPath: skill.rootPath,
      installationState: options.installationStates?.[skill.id] ?? 'not-installed',
    }))
    .sort((left, right) => comparePortableStrings(left.id, right.id));

  return {
    valid: true,
    libraryRoot: validation.rootPath,
    sourceRevision,
    records,
    errors: [],
  };
}

/**
 * Scan a canonical library as data only. Validation and hashing use filesystem
 * reads; no discovered scripts, manifests, hooks, or binaries are executed.
 */
export async function scanCatalog(
  libraryRoot: string,
  options: CatalogScanOptions = {},
): Promise<CatalogScanResult> {
  return catalogFromValidatedLibrary(await validateLibrary(libraryRoot), options);
}

export const scanSkillCatalog = scanCatalog;
