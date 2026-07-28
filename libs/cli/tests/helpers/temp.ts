import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function temporaryDirectoryPrefix(prefix: string, platform = process.platform): string {
  return platform === 'win32' ? 'ss-' : prefix;
}

export async function withTempDirectory<T>(
  prefix: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), temporaryDirectoryPrefix(prefix)));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
