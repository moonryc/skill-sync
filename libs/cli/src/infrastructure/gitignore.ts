import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const GITIGNORE_BLOCK_START = '# >>> skill-sync managed skills >>>';
export const GITIGNORE_BLOCK_END = '# <<< skill-sync managed skills <<<';

const STATE_FILES = new Set(['skill-sync.json', 'skill-sync.lock.json']);

function portablePath(path: string): string {
  if (isAbsolute(path)) throw new Error(`Managed gitignore path must be relative: ${path}`);
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Invalid managed gitignore path: ${path}`);
  }
  if (STATE_FILES.has(normalized)) throw new Error(`${normalized} must remain tracked`);
  return normalized;
}

function findManagedBlock(content: string): { start: number; end: number } | undefined {
  const start = content.indexOf(GITIGNORE_BLOCK_START);
  if (start < 0) return undefined;
  if (start > 0 && content[start - 1] !== '\n')
    throw new Error('Malformed skill-sync gitignore block');
  const markerEnd = content.indexOf(GITIGNORE_BLOCK_END, start + GITIGNORE_BLOCK_START.length);
  if (markerEnd < 0) throw new Error('Unclosed skill-sync gitignore block');
  const end = markerEnd + GITIGNORE_BLOCK_END.length;
  if (end < content.length && content[end] !== '\n') {
    throw new Error('Malformed skill-sync gitignore block ending');
  }
  if (content.includes(GITIGNORE_BLOCK_START, start + 1)) {
    throw new Error('Multiple skill-sync gitignore blocks found');
  }
  return { start, end };
}

export function renderManagedGitignore(
  original: string,
  managedDestinations: readonly string[],
): string {
  const paths = [...new Set(managedDestinations.map((path) => portablePath(path)))].sort();
  const existing = findManagedBlock(original);
  const block =
    paths.length === 0
      ? ''
      : [GITIGNORE_BLOCK_START, ...paths.map((path) => `/${path}/`), GITIGNORE_BLOCK_END].join(
          '\n',
        );

  if (existing !== undefined) {
    return `${original.slice(0, existing.start)}${block}${original.slice(existing.end)}`;
  }
  if (block.length === 0) return original;
  if (original.length === 0) return `${block}\n`;
  return `${original}${original.endsWith('\n') ? '\n' : '\n\n'}${block}\n`;
}

export interface GitignoreUpdate {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

async function readExisting(path: string): Promise<string> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('.gitignore must be a regular file');
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export async function updateManagedGitignore(options: {
  readonly projectRoot: string;
  readonly managedDestinations: readonly string[];
  readonly dryRun?: boolean;
}): Promise<GitignoreUpdate> {
  const gitignorePath = join(options.projectRoot, '.gitignore');
  const projectRelative = relative(options.projectRoot, gitignorePath);
  if (projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) {
    throw new Error('.gitignore escapes the project root');
  }
  const before = await readExisting(gitignorePath);
  const after = renderManagedGitignore(before, options.managedDestinations);
  const changed = before !== after;
  if (changed && options.dryRun !== true) {
    await mkdir(dirname(gitignorePath), { recursive: true });
    const temporary = `${gitignorePath}.skill-sync-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, after, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, gitignorePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { path: gitignorePath, before, after, changed };
}
