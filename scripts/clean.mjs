import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

await Promise.all(
  ['dist', 'coverage'].map((entry) =>
    rm(join(projectRoot, entry), { recursive: true, force: true }),
  ),
);
