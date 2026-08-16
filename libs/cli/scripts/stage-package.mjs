import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(projectRoot, '../..');
const stagedPackageRoot = join(workspaceRoot, 'dist', 'libs', 'cli');
const packageReadmeExcludedSections = new Set([
  '## Exit statuses\n',
  '## Development and release checks\n',
]);

const rootReadme = await readFile(join(workspaceRoot, 'README.md'), 'utf8');
const packageReadme = rootReadme
  .split(/(?=^## )/mu)
  .filter((section) =>
    [...packageReadmeExcludedSections].every((heading) => !section.startsWith(heading)),
  )
  .join('')
  .trimEnd()
  .concat('\n');

await mkdir(stagedPackageRoot, { recursive: true });
await Promise.all([
  copyFile(join(projectRoot, 'package.json'), join(stagedPackageRoot, 'package.json')),
  writeFile(join(stagedPackageRoot, 'README.md'), packageReadme),
  copyFile(join(workspaceRoot, 'LICENSE'), join(stagedPackageRoot, 'LICENSE')),
]);
