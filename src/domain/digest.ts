import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

import { comparePortableStrings, portableCaseFold } from './identifiers.js';

export const TREE_DIGEST_ALGORITHM = 'sha256-tree-v1' as const;

export interface RegularFileInventoryEntry {
  /** A normalized forward-slash path relative to the inspected root. */
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface RegularFileTree {
  readonly files: readonly RegularFileInventoryEntry[];
  readonly digest: string;
}

export type UnsafeTreeIssueCode =
  | 'root-not-directory'
  | 'unsafe-relative-path'
  | 'path-escape'
  | 'symlink'
  | 'special-file'
  | 'nested-git'
  | 'nested-skill-root'
  | 'io-error';

export interface UnsafeTreeIssue {
  readonly code: UnsafeTreeIssueCode;
  readonly relativePath: string;
  readonly message: string;
}

export interface InventoryOptions {
  /** Reject SKILL.md files below the root SKILL.md. */
  readonly rejectNestedSkillRoots?: boolean;
}

export class UnsafeTreeError extends Error {
  public readonly issues: readonly UnsafeTreeIssue[];

  public constructor(issues: readonly UnsafeTreeIssue[]) {
    super(
      issues.length === 1
        ? issues[0]?.message
        : `The file tree is unsafe (${String(issues.length)} errors).`,
    );
    this.name = 'UnsafeTreeError';
    this.issues = issues;
  }
}

interface InspectedFile extends RegularFileInventoryEntry {
  readonly contents: Buffer;
}

/**
 * Validate a user- or manifest-provided relative path and normalize it to the
 * portable representation used by inventories and digests.
 */
export function normalizeRelativeFilePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    throw new UnsafeTreeError([
      {
        code: 'unsafe-relative-path',
        relativePath: value,
        message: `The path "${value}" is not a safe portable relative path.`,
      },
    ]);
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new UnsafeTreeError([
      {
        code: 'unsafe-relative-path',
        relativePath: value,
        message: `The path "${value}" contains an empty or traversal segment.`,
      },
    ]);
  }

  return segments.join('/');
}

export function isPathContained(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return (
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot))
  );
}

function portablePathFromNative(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

function digestFiles(files: readonly InspectedFile[]): string {
  const digest = createHash('sha256');
  digest.update(`${TREE_DIGEST_ALGORITHM}\0`, 'utf8');

  for (const file of files) {
    const pathBytes = Buffer.from(file.relativePath, 'utf8');
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const contentLength = Buffer.allocUnsafe(8);
    contentLength.writeBigUInt64BE(BigInt(file.contents.length));

    digest.update(pathLength);
    digest.update(pathBytes);
    digest.update(contentLength);
    digest.update(file.contents);
  }

  return digest.digest('hex');
}

async function inspectFiles(
  root: string,
  options: InventoryOptions,
): Promise<{
  readonly files: readonly InspectedFile[];
  readonly issues: readonly UnsafeTreeIssue[];
}> {
  const absoluteRoot = resolve(root);
  const issues: UnsafeTreeIssue[] = [];

  let rootStats: Stats;
  try {
    rootStats = await lstat(absoluteRoot);
  } catch (error) {
    issues.push({
      code: 'io-error',
      relativePath: '.',
      message: `Unable to inspect the tree root: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { files: [], issues };
  }

  if (rootStats.isSymbolicLink()) {
    issues.push({
      code: 'symlink',
      relativePath: '.',
      message: 'The tree root must not be a symbolic link.',
    });
    return { files: [], issues };
  }

  if (!rootStats.isDirectory()) {
    issues.push({
      code: 'root-not-directory',
      relativePath: '.',
      message: 'The tree root must be a regular directory.',
    });
    return { files: [], issues };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch (error) {
    issues.push({
      code: 'io-error',
      relativePath: '.',
      message: `Unable to resolve the tree root: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { files: [], issues };
  }

  const files: InspectedFile[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const nativeRelative = relative(absoluteRoot, directory);
      issues.push({
        code: 'io-error',
        relativePath: nativeRelative.length === 0 ? '.' : portablePathFromNative(nativeRelative),
        message: `Unable to read a directory: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    entries.sort((left, right) => comparePortableStrings(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const nativeRelative = relative(absoluteRoot, absolutePath);
      const candidatePath = portablePathFromNative(nativeRelative);

      let relativePath: string;
      try {
        relativePath = normalizeRelativeFilePath(candidatePath);
      } catch (error) {
        if (error instanceof UnsafeTreeError) {
          issues.push(...error.issues);
        } else {
          issues.push({
            code: 'unsafe-relative-path',
            relativePath: candidatePath,
            message: `The entry path "${candidatePath}" is unsafe.`,
          });
        }
        continue;
      }

      if (!isPathContained(absoluteRoot, absolutePath)) {
        issues.push({
          code: 'path-escape',
          relativePath,
          message: `The entry "${relativePath}" escapes the inspected tree.`,
        });
        continue;
      }

      let stats: Stats;
      try {
        stats = await lstat(absolutePath);
      } catch (error) {
        issues.push({
          code: 'io-error',
          relativePath,
          message: `Unable to inspect "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (stats.isSymbolicLink()) {
        issues.push({
          code: 'symlink',
          relativePath,
          message: `Symbolic links are not allowed in skill content: "${relativePath}".`,
        });
        continue;
      }

      if (portableCaseFold(entry.name) === '.git') {
        issues.push({
          code: 'nested-git',
          relativePath,
          message: `Nested Git metadata is not allowed in skill content: "${relativePath}".`,
        });
        continue;
      }

      let canonicalEntry: string;
      try {
        canonicalEntry = await realpath(absolutePath);
      } catch (error) {
        issues.push({
          code: 'io-error',
          relativePath,
          message: `Unable to resolve "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      if (!isPathContained(canonicalRoot, canonicalEntry)) {
        issues.push({
          code: 'path-escape',
          relativePath,
          message: `The entry "${relativePath}" resolves outside the inspected tree.`,
        });
        continue;
      }

      if (stats.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      if (!stats.isFile()) {
        issues.push({
          code: 'special-file',
          relativePath,
          message: `Only regular files are allowed in skill content: "${relativePath}".`,
        });
        continue;
      }

      if (
        options.rejectNestedSkillRoots === true &&
        relativePath !== 'SKILL.md' &&
        relativePath.endsWith('/SKILL.md')
      ) {
        issues.push({
          code: 'nested-skill-root',
          relativePath,
          message: `A skill root must not be nested beneath another skill: "${relativePath}".`,
        });
        continue;
      }

      let contents: Buffer;
      try {
        contents = await readFile(absolutePath);
      } catch (error) {
        issues.push({
          code: 'io-error',
          relativePath,
          message: `Unable to read "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      files.push({
        relativePath,
        size: contents.length,
        sha256: createHash('sha256').update(contents).digest('hex'),
        contents,
      });
    }
  }

  await visit(absoluteRoot);
  files.sort((left, right) => comparePortableStrings(left.relativePath, right.relativePath));
  issues.sort((left, right) => {
    const pathOrder = comparePortableStrings(left.relativePath, right.relativePath);
    return pathOrder === 0 ? comparePortableStrings(left.code, right.code) : pathOrder;
  });
  return { files, issues };
}

export async function inspectRegularFileTree(
  root: string,
  options: InventoryOptions = {},
): Promise<RegularFileTree> {
  const result = await inspectFiles(root, options);
  if (result.issues.length > 0) {
    throw new UnsafeTreeError(result.issues);
  }

  return {
    files: result.files.map(({ relativePath, size, sha256 }) => ({ relativePath, size, sha256 })),
    digest: digestFiles(result.files),
  };
}

export async function inventoryRegularFiles(
  root: string,
  options: InventoryOptions = {},
): Promise<readonly RegularFileInventoryEntry[]> {
  return (await inspectRegularFileTree(root, options)).files;
}

export async function sha256TreeDigest(
  root: string,
  options: InventoryOptions = {},
): Promise<string> {
  return (await inspectRegularFileTree(root, options)).digest;
}
