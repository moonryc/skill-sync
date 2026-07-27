import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(projectRoot, '../..');
const stagedPackageRoot = join(workspaceRoot, 'dist', 'libs', 'cli');

await mkdir(stagedPackageRoot, { recursive: true });
await Promise.all([
  copyFile(join(projectRoot, 'package.json'), join(stagedPackageRoot, 'package.json')),
  copyFile(join(workspaceRoot, 'README.md'), join(stagedPackageRoot, 'README.md')),
  copyFile(join(workspaceRoot, 'LICENSE'), join(stagedPackageRoot, 'LICENSE')),
]);
