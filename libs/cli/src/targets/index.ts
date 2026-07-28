import { access, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export type TargetName = 'codex' | 'claude';

export interface TargetAdapter {
  readonly name: string;
  detect(projectRoot: string): Promise<boolean>;
  relativeDestination(skillLeafName: string): string;
  readonly globalDestination?: (skillLeafName: string) => string;
  /** The root that bounds global destinations for this target. */
  readonly globalRoot?: () => string;
}

function builtInTarget(
  name: TargetName,
  rootDirectory: string,
  homeDirectory: () => string = homedir,
): TargetAdapter {
  return {
    name,
    detect: async (projectRoot) => {
      try {
        await access(join(projectRoot, rootDirectory));
        return true;
      } catch {
        return false;
      }
    },
    relativeDestination: (skillLeafName) => join(rootDirectory, 'skills', skillLeafName),
    globalRoot: () => join(homeDirectory(), rootDirectory),
    globalDestination: (skillLeafName) =>
      join(homeDirectory(), rootDirectory, 'skills', skillLeafName),
  };
}

export const codexTarget = builtInTarget('codex', '.codex');
export const claudeTarget = builtInTarget('claude', '.claude');

export class TargetRegistry {
  private readonly adapters = new Map<string, TargetAdapter>();

  constructor(initial: readonly TargetAdapter[] = [codexTarget, claudeTarget]) {
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: TargetAdapter): void {
    if (this.adapters.has(adapter.name))
      throw new Error(`Target ${adapter.name} is already registered`);
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): TargetAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): readonly TargetAdapter[] {
    return [...this.adapters.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async detect(projectRoot: string): Promise<readonly string[]> {
    const detected: string[] = [];
    for (const adapter of this.list()) {
      if (await adapter.detect(projectRoot)) detected.push(adapter.name);
    }
    return detected;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function nearestExisting(path: string): Promise<string> {
  let cursor = path;
  for (;;) {
    try {
      await lstat(cursor);
      return cursor;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return cursor;
      cursor = parent;
    }
  }
}

export async function resolveContainedDestination(
  projectRoot: string,
  relativeDestination: string,
): Promise<string> {
  if (isAbsolute(relativeDestination)) {
    throw new Error(`Target destination must be relative: ${relativeDestination}`);
  }
  const root = await realpath(projectRoot);
  const candidate = resolve(root, relativeDestination);
  if (!isWithin(root, candidate)) throw new Error(`Target destination escapes project root`);

  const existing = await nearestExisting(candidate);
  const existingReal = await realpath(existing);
  if (!isWithin(root, existingReal))
    throw new Error(`Target destination crosses an escaping symlink`);
  return candidate;
}

/**
 * Resolve an absolute user-level target destination without permitting it to leave the target
 * adapter's declared root through lexical traversal or an existing symlink.
 */
export async function resolveContainedGlobalDestination(
  globalRoot: string,
  destination: string,
): Promise<string> {
  if (!isAbsolute(globalRoot) || !isAbsolute(destination)) {
    throw new Error('Global target roots and destinations must be absolute paths.');
  }
  const root = resolve(globalRoot);
  const candidate = resolve(destination);
  if (!isWithin(root, candidate) || candidate === root) {
    throw new Error(`Global target destination escapes its target root: ${destination}`);
  }

  let realRoot: string;
  try {
    const rootInformation = await lstat(root);
    if (rootInformation.isSymbolicLink()) {
      throw new Error(`Global target root must not be a symbolic link: ${root}`);
    }
    realRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
    throw error;
  }

  const existing = await nearestExisting(candidate);
  const existingReal = await realpath(existing);
  if (!isWithin(realRoot, existingReal)) {
    throw new Error(`Global target destination crosses an escaping symlink: ${destination}`);
  }
  return candidate;
}
