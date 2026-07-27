import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function createFixtureLibrary(root: string): Promise<void> {
  await mkdir(join(root, '.skill-sync'), { recursive: true });
  await mkdir(join(root, 'skills', 'examples', 'hello'), { recursive: true });
  await writeFile(join(root, '.skill-sync', 'library.json'), '{\n  "schemaVersion": 1\n}\n');
  await writeFile(
    join(root, 'skills', 'examples', 'hello', 'SKILL.md'),
    '---\nname: hello\ndescription: Example skill\n---\n\n# Hello\n',
  );
}

export async function createFixtureProject(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
}

export async function createBareRemote(root: string): Promise<string> {
  const remote = join(root, 'remote.git');
  await execFileAsync('git', ['init', '--bare', '--quiet', remote]);
  return remote;
}
