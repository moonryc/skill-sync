import { access, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export type TargetName = 'codex' | 'claude';

export interface TargetAdapter {
  readonly name: string;
  detect(projectRoot: string): Promise<boolean>;
  relativeDestination(skillLeafName: string): string;
  readonly globalDestination?: (skillLeafName: string) => string;
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
