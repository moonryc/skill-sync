import type { Dirent, Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  inspectRegularFileTree,
  isPathContained,
  type RegularFileInventoryEntry,
  type RegularFileTree,
  UnsafeTreeError,
} from './digest.js';
import {
  comparePortableStrings,
  findCaseFoldCollisions,
  isPortableSlug,
  parseGroupPath,
  parsePortableSlug,
  parseQualifiedSkillId,
  qualifySkillId,
  type GroupPath,
  type PortableSlug,
  type QualifiedSkillId,
} from './identifiers.js';

export const LIBRARY_SCHEMA_VERSION = 1 as const;
export const LIBRARY_MANIFEST_PATH = '.skill-sync/library.json' as const;
export const GROUP_MARKER_FILE = '.skill-sync-group.json' as const;
export const SKILL_FILE = 'SKILL.md' as const;

const jsonValueSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const libraryManifestSchema = z
  .object({
    schemaVersion: z.literal(LIBRARY_SCHEMA_VERSION),
    settings: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();

export const groupMarkerSchema = z
  .object({
    schemaVersion: z.literal(LIBRARY_SCHEMA_VERSION).optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

const agentNameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const skillFrontMatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().trim().min(1),
    'allowed-tools': z.union([z.string(), z.array(z.string())]).optional(),
    license: z.string().trim().min(1).optional(),
    compatibility: z.union([z.string(), z.array(z.string())]).optional(),
    agents: z.array(agentNameSchema).min(1).optional(),
    targets: z.array(agentNameSchema).min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export type LibraryManifest = z.infer<typeof libraryManifestSchema>;
export type GroupMarker = z.infer<typeof groupMarkerSchema>;
export type SkillFrontMatter = z.infer<typeof skillFrontMatterSchema>;

export type LibraryValidationIssueCode =
  | 'missing-library-manifest'
  | 'invalid-library-manifest'
  | 'invalid-library-root'
  | 'invalid-skills-root'
  | 'invalid-group-marker'
  | 'missing-group-marker'
  | 'invalid-group-path'
  | 'missing-skill-file'
  | 'invalid-skill-file'
  | 'invalid-skill-id'
  | 'skill-name-mismatch'
  | 'case-fold-collision'
  | 'unexpected-group-entry'
  | 'unsafe-content'
  | 'io-error';

export interface LibraryValidationIssue {
  readonly code: LibraryValidationIssueCode;
  /** Portable path relative to the library root, or `.` for the root. */
  readonly path: string;
  readonly message: string;
}

export interface ValidatedGroup {
  readonly path: GroupPath;
  readonly description: string | null;
  readonly markerPath: string;
}

export interface ValidatedSkill {
  readonly id: QualifiedSkillId;
  readonly name: PortableSlug;
  readonly group: GroupPath;
  readonly description: string;
  readonly compatibleAgents: readonly string[];
  readonly frontMatter: SkillFrontMatter;
  readonly rootPath: string;
  readonly digest: string;
  readonly files: readonly RegularFileInventoryEntry[];
}

export interface LibraryValidationResult {
  readonly valid: boolean;
  readonly rootPath: string;
  readonly manifest: LibraryManifest | null;
  /** Never exposes a partial set: invalid libraries return no selectable skills. */
  readonly skills: readonly ValidatedSkill[];
  readonly groups: readonly ValidatedGroup[];
  readonly errors: readonly LibraryValidationIssue[];
}

export interface SkillValidationResult {
  readonly valid: boolean;
  readonly skill: ValidatedSkill | null;
  readonly errors: readonly LibraryValidationIssue[];
}

export type ModelParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly messages: readonly string[] };

function zodMessages(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`;
    return `${issue.message}${location}`;
  });
}

export function parseLibraryManifest(value: unknown): ModelParseResult<LibraryManifest> {
  const result = libraryManifestSchema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, messages: zodMessages(result.error) };
}

export function parseGroupMarker(value: unknown): ModelParseResult<GroupMarker> {
  const result = groupMarkerSchema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, messages: zodMessages(result.error) };
}

function extractFrontMatter(markdown: string): ModelParseResult<unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (match === null) {
    return {
      success: false,
      messages: ['SKILL.md must begin with YAML front matter delimited by `---`.'],
    };
  }

  const yamlSource = match[1] ?? '';
  const document = parseDocument(yamlSource, { uniqueKeys: true });
  if (document.errors.length > 0) {
    return {
      success: false,
      messages: document.errors.map((error) => error.message),
    };
  }

  try {
    return { success: true, data: document.toJS({ maxAliasCount: 100 }) as unknown };
  } catch (error) {
    return {
      success: false,
      messages: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function parseSkillFrontMatter(markdown: string): ModelParseResult<SkillFrontMatter> {
  const extracted = extractFrontMatter(markdown);
  if (!extracted.success) return extracted;

  const parsed = skillFrontMatterSchema.safeParse(extracted.data);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, messages: zodMessages(parsed.error) };
}

function compatibleAgents(frontMatter: SkillFrontMatter): readonly string[] {
  const declared = frontMatter.agents ?? frontMatter.targets ?? ['codex', 'claude'];
  return [...new Set(declared)].sort(comparePortableStrings);
}

async function parseJsonFile<T>(
  absolutePath: string,
  displayPath: string,
  parse: (value: unknown) => ModelParseResult<T>,
  missingCode: LibraryValidationIssueCode,
  invalidCode: LibraryValidationIssueCode,
): Promise<
  | { readonly data: T; readonly errors: readonly LibraryValidationIssue[] }
  | { readonly data: null; readonly errors: readonly LibraryValidationIssue[] }
> {
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return {
      data: null,
      errors: [
        {
          code: missing ? missingCode : 'io-error',
          path: displayPath,
          message: missing
            ? `Required file "${displayPath}" is missing.`
            : `Unable to inspect "${displayPath}": ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    return {
      data: null,
      errors: [
        {
          code: invalidCode,
          path: displayPath,
          message: `"${displayPath}" must be a regular file and must not be a symbolic link.`,
        },
      ],
    };
  }

  let source: string;
  try {
    source = await readFile(absolutePath, 'utf8');
  } catch (error) {
    return {
      data: null,
      errors: [
        {
          code: 'io-error',
          path: displayPath,
          message: `Unable to read "${displayPath}": ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(source) as unknown;
  } catch (error) {
    return {
      data: null,
      errors: [
        {
          code: invalidCode,
          path: displayPath,
          message: `Invalid JSON in "${displayPath}": ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const parsed = parse(json);
  if (!parsed.success) {
    return {
      data: null,
      errors: parsed.messages.map((message) => ({ code: invalidCode, path: displayPath, message })),
    };
  }

  return { data: parsed.data, errors: [] };
}

async function inspectDirectory(
  absolutePath: string,
  displayPath: string,
  invalidCode: LibraryValidationIssueCode,
): Promise<readonly LibraryValidationIssue[]> {
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return missing
      ? []
      : [
          {
            code: 'io-error',
            path: displayPath,
            message: `Unable to inspect "${displayPath}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ];
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return [
      {
        code: invalidCode,
        path: displayPath,
        message: `"${displayPath}" must be a directory and must not be a symbolic link.`,
      },
    ];
  }
  return [];
}

interface CandidateSkill {
  readonly rawId: string;
  readonly rootPath: string;
  readonly skill: ValidatedSkill | null;
}

async function validateSkillRoot(
  rootPath: string,
  rawSegments: readonly string[],
  displayRoot: string,
): Promise<{
  readonly candidate: CandidateSkill;
  readonly errors: readonly LibraryValidationIssue[];
}> {
  const errors: LibraryValidationIssue[] = [];
  const rawId = rawSegments.join('/');
  let id: QualifiedSkillId | undefined;
  let name: PortableSlug | undefined;
  let group: GroupPath | undefined;

  try {
    id = parseQualifiedSkillId(rawId);
    name = parsePortableSlug(rawSegments.at(-1));
    group = parseGroupPath(rawSegments.slice(0, -1));
  } catch (error) {
    errors.push({
      code: 'invalid-skill-id',
      path: displayRoot,
      message: error instanceof Error ? error.message : `Invalid qualified skill ID "${rawId}".`,
    });
  }

  let tree: RegularFileTree | undefined;
  try {
    // Discovery deliberately treats nested SKILL.md files as inert content and
    // stops assigning identities once this root has been found.
    tree = await inspectRegularFileTree(rootPath, { rejectNestedSkillRoots: false });
  } catch (error) {
    if (error instanceof UnsafeTreeError) {
      errors.push(
        ...error.issues.map((issue) => ({
          code: 'unsafe-content' as const,
          path: issue.relativePath === '.' ? displayRoot : `${displayRoot}/${issue.relativePath}`,
          message: issue.message,
        })),
      );
    } else {
      errors.push({
        code: 'io-error',
        path: displayRoot,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const skillFilePath = join(rootPath, SKILL_FILE);
  let frontMatter: SkillFrontMatter | undefined;
  let markdown: string | undefined;
  try {
    const stats = await lstat(skillFilePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      errors.push({
        code: 'invalid-skill-file',
        path: `${displayRoot}/${SKILL_FILE}`,
        message: 'SKILL.md must be a regular file and must not be a symbolic link.',
      });
    } else {
      markdown = await readFile(skillFilePath, 'utf8');
    }
  } catch (error) {
    errors.push({
      code: 'invalid-skill-file',
      path: `${displayRoot}/${SKILL_FILE}`,
      message: `Unable to read SKILL.md: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (markdown !== undefined) {
    const parsed = parseSkillFrontMatter(markdown);
    if (parsed.success) {
      frontMatter = parsed.data;
      if (!isPortableSlug(parsed.data.name)) {
        errors.push({
          code: 'invalid-skill-id',
          path: `${displayRoot}/${SKILL_FILE}`,
          message: `Front-matter name "${parsed.data.name}" is not a portable lowercase slug.`,
        });
      } else if (name !== undefined && parsed.data.name !== name) {
        errors.push({
          code: 'skill-name-mismatch',
          path: `${displayRoot}/${SKILL_FILE}`,
          message: `Front-matter name "${parsed.data.name}" must match directory name "${name}".`,
        });
      }
    } else {
      errors.push(
        ...parsed.messages.map((message) => ({
          code: 'invalid-skill-file' as const,
          path: `${displayRoot}/${SKILL_FILE}`,
          message,
        })),
      );
    }
  }

  const skill =
    errors.length === 0 &&
    id !== undefined &&
    name !== undefined &&
    group !== undefined &&
    tree !== undefined &&
    frontMatter !== undefined
      ? {
          id,
          name,
          group,
          description: frontMatter.description,
          compatibleAgents: compatibleAgents(frontMatter),
          frontMatter,
          rootPath,
          digest: tree.digest,
          files: tree.files,
        }
      : null;

  return { candidate: { rawId, rootPath, skill }, errors };
}

function sortIssues(issues: LibraryValidationIssue[]): void {
  issues.sort((left, right) => {
    const pathOrder = comparePortableStrings(left.path, right.path);
    return pathOrder === 0 ? comparePortableStrings(left.code, right.code) : pathOrder;
  });
}

export async function validateLibrary(libraryRoot: string): Promise<LibraryValidationResult> {
  const rootPath = resolve(libraryRoot);
  const errors: LibraryValidationIssue[] = [];
  const groups: ValidatedGroup[] = [];
  const candidates: CandidateSkill[] = [];

  const rootErrors = await inspectDirectory(rootPath, '.', 'invalid-library-root');
  errors.push(...rootErrors);
  if (rootErrors.length > 0) {
    sortIssues(errors);
    return { valid: false, rootPath, manifest: null, skills: [], groups: [], errors };
  }

  const metadataDirectory = join(rootPath, '.skill-sync');
  const metadataErrors = await inspectDirectory(
    metadataDirectory,
    '.skill-sync',
    'invalid-library-manifest',
  );
  errors.push(...metadataErrors);

  const manifestResult = await parseJsonFile(
    join(rootPath, LIBRARY_MANIFEST_PATH),
    LIBRARY_MANIFEST_PATH,
    parseLibraryManifest,
    'missing-library-manifest',
    'invalid-library-manifest',
  );
  errors.push(...manifestResult.errors);

  const skillsRoot = join(rootPath, 'skills');
  const skillsRootErrors = await inspectDirectory(skillsRoot, 'skills', 'invalid-skills-root');
  errors.push(...skillsRootErrors);

  let skillsRootExists = false;
  try {
    skillsRootExists = (await lstat(skillsRoot)).isDirectory() && skillsRootErrors.length === 0;
  } catch {
    // A library containing no skills can legitimately have no persisted skills directory.
  }

  async function scanDirectory(directory: string, segments: readonly string[]): Promise<void> {
    const displayPath = `skills/${segments.join('/')}`;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({
        code: 'io-error',
        path: displayPath,
        message: `Unable to read "${displayPath}": ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    entries.sort((left, right) => comparePortableStrings(left.name, right.name));
    const skillEntry = entries.find((entry) => entry.name === SKILL_FILE);
    if (skillEntry !== undefined) {
      const result = await validateSkillRoot(directory, segments, displayPath);
      errors.push(...result.errors);
      candidates.push(result.candidate);
      return;
    }

    for (const segment of segments) {
      if (!isPortableSlug(segment)) {
        errors.push({
          code: 'invalid-group-path',
          path: displayPath,
          message: `Group path segment "${segment}" is not a portable lowercase slug.`,
        });
      }
    }

    const markerEntry = entries.find((entry) => entry.name === GROUP_MARKER_FILE);
    const childDirectories: string[] = [];
    const ordinaryFiles: string[] = [];

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      const entryDisplayPath = `${displayPath}/${entry.name}`;
      let stats: Stats;
      try {
        stats = await lstat(entryPath);
      } catch (error) {
        errors.push({
          code: 'io-error',
          path: entryDisplayPath,
          message: `Unable to inspect "${entryDisplayPath}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (stats.isSymbolicLink()) {
        errors.push({
          code: 'unsafe-content',
          path: entryDisplayPath,
          message: `Symbolic links are not allowed in the canonical skills tree: "${entryDisplayPath}".`,
        });
      } else if (stats.isDirectory()) {
        if (entry.name.toLowerCase() === '.git') {
          errors.push({
            code: 'unsafe-content',
            path: entryDisplayPath,
            message: `Nested Git metadata is not allowed: "${entryDisplayPath}".`,
          });
        } else {
          childDirectories.push(entry.name);
        }
      } else if (stats.isFile()) {
        if (entry.name.toLowerCase() === '.git') {
          errors.push({
            code: 'unsafe-content',
            path: entryDisplayPath,
            message: `Nested Git metadata is not allowed: "${entryDisplayPath}".`,
          });
        } else if (entry.name !== GROUP_MARKER_FILE) {
          ordinaryFiles.push(entry.name);
        }
      } else {
        errors.push({
          code: 'unsafe-content',
          path: entryDisplayPath,
          message: `Only regular files and directories are allowed: "${entryDisplayPath}".`,
        });
      }
    }

    if (markerEntry === undefined) {
      errors.push({
        code:
          ordinaryFiles.length > 0 && childDirectories.length === 0
            ? 'missing-skill-file'
            : 'missing-group-marker',
        path: displayPath,
        message:
          ordinaryFiles.length > 0 && childDirectories.length === 0
            ? `Potential skill directory "${displayPath}" is missing ${SKILL_FILE}.`
            : `Group "${segments.join('/')}" is missing ${GROUP_MARKER_FILE}.`,
      });
    } else {
      const markerResult = await parseJsonFile(
        join(directory, GROUP_MARKER_FILE),
        `${displayPath}/${GROUP_MARKER_FILE}`,
        parseGroupMarker,
        'invalid-group-marker',
        'invalid-group-marker',
      );
      errors.push(...markerResult.errors);
      if (markerResult.data !== null) {
        try {
          const groupPath = parseGroupPath(segments);
          groups.push({
            path: groupPath,
            description: markerResult.data.description ?? null,
            markerPath: `${displayPath}/${GROUP_MARKER_FILE}`,
          });
        } catch (error) {
          errors.push({
            code: 'invalid-group-path',
            path: displayPath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const ordinaryFile of ordinaryFiles) {
      errors.push({
        code: 'unexpected-group-entry',
        path: `${displayPath}/${ordinaryFile}`,
        message: `Groups may contain only ${GROUP_MARKER_FILE} and child directories.`,
      });
    }

    for (const child of childDirectories.sort(comparePortableStrings)) {
      await scanDirectory(join(directory, child), [...segments, child]);
    }
  }

  if (skillsRootExists) {
    let rootEntries: Dirent[];
    try {
      rootEntries = await readdir(skillsRoot, { withFileTypes: true });
      rootEntries.sort((left, right) => comparePortableStrings(left.name, right.name));
    } catch (error) {
      rootEntries = [];
      errors.push({
        code: 'io-error',
        path: 'skills',
        message: `Unable to read "skills": ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    for (const entry of rootEntries) {
      const entryPath = join(skillsRoot, entry.name);
      const displayPath = `skills/${entry.name}`;
      let stats: Stats;
      try {
        stats = await lstat(entryPath);
      } catch (error) {
        errors.push({
          code: 'io-error',
          path: displayPath,
          message: `Unable to inspect "${displayPath}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (stats.isSymbolicLink()) {
        errors.push({
          code: 'unsafe-content',
          path: displayPath,
          message: `Symbolic links are not allowed in the canonical skills tree: "${displayPath}".`,
        });
      } else if (stats.isDirectory()) {
        if (entry.name.toLowerCase() === '.git') {
          errors.push({
            code: 'unsafe-content',
            path: displayPath,
            message: `Nested Git metadata is not allowed: "${displayPath}".`,
          });
        } else {
          await scanDirectory(entryPath, [entry.name]);
        }
      } else {
        errors.push({
          code: 'unexpected-group-entry',
          path: displayPath,
          message: 'The skills root may contain only skill or group directories.',
        });
      }
    }
  }

  for (const collision of findCaseFoldCollisions(candidates.map((candidate) => candidate.rawId))) {
    errors.push({
      code: 'case-fold-collision',
      path: 'skills',
      message: `Qualified skill identifiers collide under portable case folding: ${collision.values.join(', ')}.`,
    });
  }

  sortIssues(errors);
  groups.sort((left, right) => comparePortableStrings(left.path, right.path));
  const validSkills = candidates
    .flatMap((candidate) => (candidate.skill === null ? [] : [candidate.skill]))
    .sort((left, right) => comparePortableStrings(left.id, right.id));

  const valid = errors.length === 0;
  return {
    valid,
    rootPath,
    manifest: manifestResult.data,
    skills: valid ? validSkills : [],
    groups: valid ? groups : [],
    errors,
  };
}

export async function validateSkillDirectory(
  skillRoot: string,
  expectedId?: QualifiedSkillId | string,
): Promise<SkillValidationResult> {
  const rootPath = resolve(skillRoot);
  const rawId = expectedId ?? basename(rootPath);
  let segments: readonly string[];
  try {
    segments = parseQualifiedSkillId(rawId).split('/');
  } catch (error) {
    return {
      valid: false,
      skill: null,
      errors: [
        {
          code: 'invalid-skill-id',
          path: '.',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const result = await validateSkillRoot(rootPath, segments, '.');
  const errors = [...result.errors];
  sortIssues(errors);
  return {
    valid: errors.length === 0,
    skill: errors.length === 0 ? result.candidate.skill : null,
    errors,
  };
}

/** Resolve and verify a path remains inside a validated library root. */
export async function resolveLibraryPath(
  libraryRoot: string,
  portablePath: string,
): Promise<string> {
  const root = await realpath(resolve(libraryRoot));
  const candidate = resolve(root, ...portablePath.split('/'));
  if (!isPathContained(root, candidate)) {
    throw new Error(`The path "${portablePath}" escapes the library root.`);
  }
  return candidate;
}

/** Convenience for callers constructing canonical paths after identifier validation. */
export function canonicalSkillPath(
  libraryRoot: string,
  group: GroupPath | string | readonly string[],
  name: PortableSlug | string,
): { readonly id: QualifiedSkillId; readonly path: string } {
  const id = qualifySkillId(group, name);
  return { id, path: join(resolve(libraryRoot), 'skills', ...id.split('/')) };
}
