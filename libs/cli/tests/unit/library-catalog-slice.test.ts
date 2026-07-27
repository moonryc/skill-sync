import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanCatalog } from '../../src/application/catalog.js';
import {
  parseGroupMarker,
  parseLibraryManifest,
  parseSkillFrontMatter,
  validateLibrary,
} from '../../src/domain/library.js';
import { withTempDirectory } from '../helpers/temp.js';

async function initializeLibrary(root: string): Promise<void> {
  await mkdir(join(root, '.skill-sync'), { recursive: true });
  await writeFile(join(root, '.skill-sync', 'library.json'), '{"schemaVersion":1}\n');
}

async function writeSkill(root: string, id: string, nestedFixture = false): Promise<void> {
  const skillRoot = join(root, 'skills', ...id.split('/'));
  await mkdir(skillRoot, { recursive: true });
  const name = id.split('/').at(-1);
  if (name === undefined) throw new Error('A fixture skill ID must not be empty.');
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\nagents: [codex, claude]\n---\n\n# ${name}\n`,
  );
  if (nestedFixture) {
    await mkdir(join(skillRoot, 'fixtures'), { recursive: true });
    await writeFile(join(skillRoot, 'fixtures', 'SKILL.md'), 'fixture bytes');
  }
}

async function writeGroup(root: string, group: string, description?: string): Promise<void> {
  const groupRoot = join(root, 'skills', ...group.split('/'));
  await mkdir(groupRoot, { recursive: true });
  await writeFile(
    join(groupRoot, '.skill-sync-group.json'),
    description === undefined ? '{}\n' : `${JSON.stringify({ description })}\n`,
  );
}

describe('library models and catalog scanning', () => {
  it('validates strict library/group JSON and required skill metadata', () => {
    expect(parseLibraryManifest({ schemaVersion: 1 }).success).toBe(true);
    expect(parseLibraryManifest({ schemaVersion: 2 }).success).toBe(false);
    expect(parseLibraryManifest({ schemaVersion: 1, extra: true }).success).toBe(false);
    expect(parseGroupMarker({ description: 'UI skills' }).success).toBe(true);
    expect(parseGroupMarker({ description: '' }).success).toBe(false);
    expect(
      parseSkillFrontMatter('---\nname: review-ui\ndescription: Reviews interfaces\n---\n').success,
    ).toBe(true);
    expect(parseSkillFrontMatter('---\nname: review-ui\n---\n').success).toBe(false);
  });

  it('derives root and nested skills and stops below a discovered skill root', async () => {
    await withTempDirectory('skill-sync-library-', async (root) => {
      await initializeLibrary(root);
      await writeSkill(root, 'format-code');
      await writeGroup(root, 'frontend', 'Frontend skills');
      await writeGroup(root, 'frontend/react');
      await writeSkill(root, 'frontend/review-ui', true);
      await writeSkill(root, 'frontend/react/create-component');

      const result = await scanCatalog(root, { sourceRevision: 'abc123' });
      expect(result.valid).toBe(true);
      expect(result.records.map((record) => record.id)).toEqual([
        'format-code',
        'frontend/react/create-component',
        'frontend/review-ui',
      ]);
      const reviewSkill = result.records.find((record) => record.id === 'frontend/review-ui');
      expect(reviewSkill).toMatchObject({
        group: 'frontend',
        sourceRevision: 'abc123',
        compatibleAgents: ['claude', 'codex'],
        installationState: 'not-installed',
      });
      expect(reviewSkill?.inventory.map((file) => file.relativePath)).toContain(
        'fixtures/SKILL.md',
      );
      expect(result.records.some((record) => record.id.includes('fixtures'))).toBe(false);
    });
  });

  it('accepts an empty schema-valid library', async () => {
    await withTempDirectory('skill-sync-empty-library-', async (root) => {
      await initializeLibrary(root);
      await expect(scanCatalog(root)).resolves.toMatchObject({
        valid: true,
        records: [],
        errors: [],
      });
    });
  });

  it.runIf(process.platform !== 'win32')(
    'collects unsafe and malformed entry errors without a partial catalog',
    async () => {
      await withTempDirectory('skill-sync-invalid-library-', async (root) => {
        await initializeLibrary(root);
        await writeSkill(root, 'valid-skill');
        await symlink('../outside', join(root, 'skills', 'valid-skill', 'escape'));
        await mkdir(join(root, 'skills', 'broken-skill'), { recursive: true });
        await writeFile(join(root, 'skills', 'broken-skill', 'notes.md'), 'missing SKILL.md');

        const result = await validateLibrary(root);
        expect(result.valid).toBe(false);
        expect(result.skills).toEqual([]);
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'missing-skill-file' }),
            expect.objectContaining({ code: 'unsafe-content' }),
          ]),
        );
      });
    },
  );
});
