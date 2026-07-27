import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(projectRoot, '../..');

await Promise.all(
  [join(workspaceRoot, 'dist', 'libs', 'cli'), join(projectRoot, 'coverage')].map((path) =>
    rm(path, { recursive: true, force: true }),
  ),
);
