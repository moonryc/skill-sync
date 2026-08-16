import { readFileSync } from 'node:fs';

import type { CliPackageMetadata } from '../application/release-management.js';

function isPackageMetadata(value: unknown): value is CliPackageMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    typeof record.version === 'string' &&
    record.version.length > 0
  );
}

export function readCliPackageMetadata(): CliPackageMetadata {
  const parsed = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as unknown;
  if (!isPackageMetadata(parsed)) throw new Error('The CLI package metadata is invalid.');
  return parsed;
}
