import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  inspectRegularFileTree,
  normalizeRelativeFilePath,
  UnsafeTreeError,
} from '../../src/domain/digest.js';
import { withTempDirectory } from '../helpers/temp.js';

async function makeEquivalentTree(root: string, reverse: boolean): Promise<void> {
  await mkdir(join(root, 'nested'), { recursive: true });
  const files = reverse
    ? ([
        ['nested/b.txt', 'second'],
        ['a.txt', 'first'],
      ] as const)
    : ([
        ['a.txt', 'first'],
        ['nested/b.txt', 'second'],
      ] as const);
  for (const [path, contents] of files) {
    await writeFile(join(root, path), contents);
  }
}

describe('regular-file tree digests', () => {
  it('sorts inventories and ignores creation order and timestamps', async () => {
    await withTempDirectory('skill-sync-digest-', async (temporaryRoot) => {
      const first = join(temporaryRoot, 'first');
      const second = join(temporaryRoot, 'second');
      await makeEquivalentTree(first, false);
      await makeEquivalentTree(second, true);
      await utimes(join(second, 'a.txt'), new Date(1_000), new Date(2_000));

      const firstTree = await inspectRegularFileTree(first);
      const secondTree = await inspectRegularFileTree(second);
      expect(firstTree.digest).toBe(secondTree.digest);
      expect(firstTree.files.map((file) => file.relativePath)).toEqual(['a.txt', 'nested/b.txt']);

      await writeFile(join(second, 'nested', 'b.txt'), 'changed');
      expect((await inspectRegularFileTree(second)).digest).not.toBe(firstTree.digest);
    });
  });

  it('rejects traversal spellings and nested Git metadata', async () => {
    expect(() => normalizeRelativeFilePath('../secret')).toThrow(UnsafeTreeError);
    expect(() => normalizeRelativeFilePath('/absolute')).toThrow(UnsafeTreeError);
    expect(() => normalizeRelativeFilePath('nested\\file')).toThrow(UnsafeTreeError);

    await withTempDirectory('skill-sync-git-tree-', async (root) => {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'config'), 'inert');
      await expect(inspectRegularFileTree(root)).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'nested-git', relativePath: '.git' })],
      });
    });
  });

  it('can reject a nested skill root while allowing catalog-style inert fixtures', async () => {
    await withTempDirectory('skill-sync-nested-skill-', async (root) => {
      await writeFile(join(root, 'SKILL.md'), 'outer');
      await mkdir(join(root, 'examples'), { recursive: true });
      await writeFile(join(root, 'examples', 'SKILL.md'), 'fixture');

      await expect(
        inspectRegularFileTree(root, { rejectNestedSkillRoots: true }),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'nested-skill-root' })],
      });
      const catalogStyleTree = await inspectRegularFileTree(root);
      expect(catalogStyleTree.files.map((file) => file.relativePath)).toContain(
        'examples/SKILL.md',
      );
    });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symlinks even when they point inside the tree',
    async () => {
      await withTempDirectory('skill-sync-link-tree-', async (root) => {
        await writeFile(join(root, 'target.txt'), 'data');
        await symlink('target.txt', join(root, 'alias.txt'));
        await expect(inspectRegularFileTree(root)).rejects.toMatchObject({
          issues: [expect.objectContaining({ code: 'symlink', relativePath: 'alias.txt' })],
        });
      });
    },
  );
});
