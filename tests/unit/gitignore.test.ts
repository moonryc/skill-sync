import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GITIGNORE_BLOCK_END,
  GITIGNORE_BLOCK_START,
  renderManagedGitignore,
  updateManagedGitignore,
} from '../../src/infrastructure/gitignore.js';
import { withTempDirectory } from '../helpers/temp.js';

describe('managed .gitignore block', () => {
  it('preserves user bytes and renders exact sorted paths once', () => {
    const original = '# user rule\n.env\n';
    const rendered = renderManagedGitignore(original, [
      '.codex/skills/zeta',
      '.claude/skills/alpha',
      '.codex/skills/zeta',
    ]);
    expect(rendered.startsWith(original)).toBe(true);
    expect(rendered).toContain(
      `${GITIGNORE_BLOCK_START}\n/.claude/skills/alpha/\n/.codex/skills/zeta/\n${GITIGNORE_BLOCK_END}`,
    );
    expect(renderManagedGitignore(rendered, ['.codex/skills/zeta', '.claude/skills/alpha'])).toBe(
      rendered,
    );
  });

  it('removes only the managed block when no paths remain', () => {
    const original = `before\n${GITIGNORE_BLOCK_START}\n/.codex/skills/a/\n${GITIGNORE_BLOCK_END}\nafter\n`;
    expect(renderManagedGitignore(original, [])).toBe('before\n\nafter\n');
  });

  it('never allows project state files in the managed block', () => {
    expect(() => renderManagedGitignore('', ['skill-sync.json'])).toThrow(/remain tracked/);
    expect(() => renderManagedGitignore('', ['../outside'])).toThrow(/Invalid/);
  });

  it('supports a zero-write dry run and an atomic real update', async () =>
    withTempDirectory('skill-sync-ignore-', async (root) => {
      const path = join(root, '.gitignore');
      await writeFile(path, 'custom\n');
      const dry = await updateManagedGitignore({
        projectRoot: root,
        managedDestinations: ['.codex/skills/hello'],
        dryRun: true,
      });
      expect(dry.changed).toBe(true);
      expect(await readFile(path, 'utf8')).toBe('custom\n');

      await updateManagedGitignore({
        projectRoot: root,
        managedDestinations: ['.codex/skills/hello'],
      });
      expect(await readFile(path, 'utf8')).toContain('/.codex/skills/hello/');
    }));
});
