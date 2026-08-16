import { createHash } from 'node:crypto';

import type { JsonValue } from '../infrastructure/stable-json.js';
import { stableJsonStringify } from '../infrastructure/stable-json.js';

export const INSTALL_PLAN_FINGERPRINT_PATTERN = /^install-v1-[a-f0-9]{64}$/u;

export interface ReviewedInstallProjection {
  readonly destination: string;
  readonly target: string;
  readonly write: boolean;
}

export interface ReviewedInstallSkill {
  readonly digest: string;
  readonly id: string;
  readonly projections: readonly ReviewedInstallProjection[];
  readonly status: string;
}

export interface ReviewedInstallOriginal {
  readonly destination: string;
  readonly digest: string | null;
}

export interface InstallPlanFingerprintInput {
  readonly gitignore?: {
    readonly after: string;
    readonly before: string;
  } | null;
  readonly libraryIdentity: string;
  readonly libraryRevision: string;
  readonly location: string;
  readonly originals: readonly ReviewedInstallOriginal[];
  readonly scope: 'global' | 'project';
  readonly skills: readonly ReviewedInstallSkill[];
  readonly state: {
    readonly after: {
      readonly lock: unknown;
      readonly manifest: unknown;
    };
    readonly before: {
      readonly lock: unknown;
      readonly manifest: unknown;
    };
  };
  readonly writes: readonly string[];
}

function compareJson(left: JsonValue, right: JsonValue): number {
  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

/** Normalize undefined explicitly and make unordered plan collections deterministic. */
function normalizeInstallValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Install plans cannot contain non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeInstallValue).sort(compareJson);
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Install plans can contain only plain objects.');
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeInstallValue((value as Record<string, unknown>)[key])]),
    );
  }
  throw new TypeError(`Install plans cannot contain ${typeof value} values.`);
}

/**
 * Bind every reviewed install input to a versioned SHA-256 value. Dry-run/apply-only fields are
 * deliberately absent so the same reviewed plan can authorize its exact application.
 */
export function installPlanFingerprint(input: InstallPlanFingerprintInput): string {
  const normalized = normalizeInstallValue({
    gitignore: input.gitignore ?? null,
    library: { identity: input.libraryIdentity, revision: input.libraryRevision },
    location: input.location,
    originals: input.originals,
    scope: input.scope,
    skills: input.skills,
    state: input.state,
    version: 'install-v1',
    writes: input.writes,
  });
  const digest = createHash('sha256')
    .update('skill-sync-install-v1\0')
    .update(stableJsonStringify(normalized))
    .digest('hex');
  return `install-v1-${digest}`;
}
