import { lstat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

import { resolveContainedDestination, type TargetRegistry } from '../targets/index.js';

export interface SkillProjectionCandidate {
  readonly id: string;
  readonly leafName: string;
}

export interface TrackedDestination {
  readonly skillId: string;
  readonly target: string;
  readonly path: string;
}

export interface ProjectionPlan {
  readonly skillId: string;
  readonly target: string;
  readonly destination: string;
  readonly alreadyManaged: boolean;
}

export interface PreflightIssue {
  readonly code: 'UNKNOWN_TARGET' | 'DESTINATION_COLLISION' | 'UNMANAGED_COLLISION' | 'UNSAFE_PATH';
  readonly message: string;
  readonly skillIds: readonly string[];
  readonly target?: string;
  readonly path?: string;
}

export interface TargetPreflightResult {
  readonly plans: readonly ProjectionPlan[];
  readonly issues: readonly PreflightIssue[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function preflightTargets(options: {
  readonly projectRoot: string;
  readonly skills: readonly SkillProjectionCandidate[];
  readonly targets: readonly string[];
  readonly registry: TargetRegistry;
  readonly trackedDestinations?: readonly TrackedDestination[];
}): Promise<TargetPreflightResult> {
  const plans: ProjectionPlan[] = [];
  const issues: PreflightIssue[] = [];
  const selectedPaths = new Map<string, SkillProjectionCandidate>();
  const tracked = new Map<string, string>();
  for (const entry of options.trackedDestinations ?? []) {
    try {
      const trackedRelative = isAbsolute(entry.path)
        ? relative(options.projectRoot, entry.path)
        : entry.path;
      const normalized = await resolveContainedDestination(options.projectRoot, trackedRelative);
      tracked.set(`${entry.target}\u0000${normalized}`, entry.skillId);
    } catch {
      issues.push({
        code: 'UNSAFE_PATH',
        message: `Tracked destination escapes project root: ${entry.path}`,
        skillIds: [entry.skillId],
        target: entry.target,
        path: entry.path,
      });
    }
  }

  for (const targetName of [...new Set(options.targets)].sort()) {
    const adapter = options.registry.get(targetName);
    if (adapter === undefined) {
      issues.push({
        code: 'UNKNOWN_TARGET',
        message: `Unknown target: ${targetName}`,
        skillIds: options.skills.map((skill) => skill.id),
        target: targetName,
      });
      continue;
    }

    for (const skill of [...options.skills].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      let destination: string;
      try {
        destination = await resolveContainedDestination(
          options.projectRoot,
          adapter.relativeDestination(skill.leafName),
        );
      } catch (error) {
        issues.push({
          code: 'UNSAFE_PATH',
          message: error instanceof Error ? error.message : String(error),
          skillIds: [skill.id],
          target: targetName,
        });
        continue;
      }

      const collisionKey = `${targetName}\u0000${destination}`;
      const previous = selectedPaths.get(collisionKey);
      if (previous !== undefined && previous.id !== skill.id) {
        issues.push({
          code: 'DESTINATION_COLLISION',
          message: `${previous.id} and ${skill.id} both map to ${destination}`,
          skillIds: [previous.id, skill.id].sort(),
          target: targetName,
          path: destination,
        });
        continue;
      }
      selectedPaths.set(collisionKey, skill);

      const owner = tracked.get(collisionKey);
      const exists = await pathExists(destination);
      if (exists && owner !== skill.id) {
        issues.push({
          code: 'UNMANAGED_COLLISION',
          message: `${destination} exists and is not managed by ${skill.id}`,
          skillIds: [skill.id],
          target: targetName,
          path: destination,
        });
        continue;
      }

      plans.push({
        skillId: skill.id,
        target: targetName,
        destination,
        alreadyManaged: owner === skill.id,
      });
    }
  }

  if (issues.length > 0) return { plans: [], issues };
  return {
    plans: plans.sort(
      (left, right) =>
        left.skillId.localeCompare(right.skillId) || left.target.localeCompare(right.target),
    ),
    issues: [],
  };
}
