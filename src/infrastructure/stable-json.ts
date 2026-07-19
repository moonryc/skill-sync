import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

function normalizeJson(value: unknown, location: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot serialize non-finite number at ${location}.`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeJson(entry, `${location}[${String(index)}]`));
  }

  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot serialize a non-plain object at ${location}.`);
    }

    const result: Record<string, JsonValue> = {};
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source).sort((left, right) => left.localeCompare(right))) {
      const entry = source[key];
      if (entry !== undefined) {
        result[key] = normalizeJson(entry, `${location}.${key}`);
      }
    }
    return result;
  }

  throw new TypeError(`Cannot serialize ${typeof value} at ${location}.`);
}

/** Serialize JSON with recursively sorted object keys and one trailing newline. */
export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(normalizeJson(value, '$'), null, 2)}\n`;
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Directory fsync is unavailable on Windows and on a few virtual filesystems.
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'ENOTSUP' && code !== 'EPERM') {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/**
 * Atomically replace a JSON file by writing and syncing a same-directory temporary file first.
 * Validation belongs to the caller and must happen before invoking this function.
 */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  options: { readonly mode?: number } = {},
): Promise<void> {
  const contents = stableJsonStringify(value);
  const parent = dirname(path);
  const temporaryPath = join(parent, `.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true, mode: 0o700 });

  let handle;
  try {
    handle = await open(temporaryPath, 'wx', options.mode ?? 0o600);
    await handle.writeFile(contents, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
