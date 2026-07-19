import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  scanCatalog,
  type CatalogScanResult,
  type CatalogSkillRecord,
} from '../../src/application/catalog.js';
import {
  filterCatalogRecords,
  formatCatalogListHuman,
  formatCatalogSkillInfoHuman,
  getCatalogSkillInfo,
  listCatalog,
  validateReadOnlySource,
} from '../../src/application/read-only.js';
import { withTempDirectory } from '../helpers/temp.js';

const FILE_HASH = 'a'.repeat(64);

function record(
  id: string,
  options: {
    readonly description: string;
    readonly agents: readonly string[];
    readonly state: CatalogSkillRecord['installationState'];
  },
): CatalogSkillRecord {
  const segments = id.split('/');
  const name = segments.at(-1);
  if (name === undefined) throw new Error('A fixture ID must have a leaf name.');
  const group = segments.slice(0, -1).join('/');
  return {
    id,
    name,
    group: group === '' ? null : group,
    description: options.description,
    compatibleAgents: options.agents,
    metadata: { author: 'fixture' },
    frontMatter: { name, description: options.description },
    sourceRevision: 'f'.repeat(40),
    digest: FILE_HASH,
    inventory: [{ relativePath: 'SKILL.md', size: 20, sha256: FILE_HASH }],
    relativeRoot: `skills/${id}`,
    rootPath: `/not-exposed/${id}`,
    installationState: options.state,
  };
}

const records: readonly CatalogSkillRecord[] = [
  record('frontend/react/create-component', {
    description: 'Build reusable components',
    agents: ['codex'],
    state: 'outdated',
  }),
  record('format-code', {
    description: 'Format source files',
    agents: ['codex'],
    state: 'not-installed',
  }),
  record('backend/review-api', {
    description: 'Review APIs',
    agents: ['claude'],
    state: 'current',
  }),
  record('frontend/review-ui', {
    description: 'ACCESSIBILITY review',
    agents: ['claude', 'codex'],
    state: 'current',
  }),
];

function catalog(catalogRecords: readonly CatalogSkillRecord[] = records): CatalogScanResult {
  return {
    valid: true,
    libraryRoot: '/library',
    sourceRevision: 'f'.repeat(40),
    records: catalogRecords,
    errors: [],
  };
}

async function writeSkill(root: string, id: string, body: string): Promise<string> {
  const skillRoot = join(root, ...id.split('/'));
  const name = id.split('/').at(-1);
  if (name === undefined) throw new Error('A fixture ID must have a leaf name.');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`,
  );
  return skillRoot;
}

async function createLibrary(root: string): Promise<void> {
  await mkdir(join(root, '.skill-sync'), { recursive: true });
  await writeFile(join(root, '.skill-sync', 'library.json'), '{"schemaVersion":1}\n');
  await mkdir(join(root, 'skills', 'frontend'), { recursive: true });
  await writeFile(join(root, 'skills', 'frontend', '.skill-sync-group.json'), '{}\n');
  await writeSkill(join(root, 'skills'), 'frontend/review-ui', 'DO-NOT-PRINT-SKILL-BODY');
}

describe('read-only catalog list and info services', () => {
  it('composes OR-within-kind filters with AND-across-kind semantics', () => {
    const result = filterCatalogRecords(records, {
      groups: ['frontend'],
      queries: ['component', 'accessibility'],
      agents: ['claude'],
      states: ['current', 'outdated'],
    });
    expect(result).toMatchObject({
      ok: true,
      items: [{ id: 'frontend/review-ui', group: 'frontend' }],
    });
  });

  it('keeps group subtrees and deterministic IDs visible in safe list DTOs', () => {
    const result = listCatalog(catalog(), { groups: ['frontend', 'backend'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.id)).toEqual([
      'backend/review-api',
      'frontend/react/create-component',
      'frontend/review-ui',
    ]);
    expect(result.items[0]).not.toHaveProperty('rootPath');
    expect(result.items[0]).not.toHaveProperty('frontMatter');
    expect(result.items[0]).not.toHaveProperty('inventory');
    expect(formatCatalogListHuman(result.items)).toBe(
      [
        'backend:',
        '  backend/review-api — Review APIs [claude] (current)',
        'frontend/react:',
        '  frontend/react/create-component — Build reusable components [codex] (outdated)',
        'frontend:',
        '  frontend/review-ui — ACCESSIBILITY review [claude, codex] (current)',
      ].join('\n'),
    );
  });

  it('returns an empty success for valid filters with no matches', () => {
    expect(listCatalog(catalog(), { queries: ['definitely absent'] })).toEqual({
      ok: true,
      items: [],
    });
  });

  it('rejects invalid filters before exposing a partial list', () => {
    expect(
      listCatalog(catalog(), { groups: ['Frontend'], agents: ['Claude'], states: ['fresh'] }),
    ).toMatchObject({
      ok: false,
      items: [],
      errors: [
        { code: 'invalid-agent-filter' },
        { code: 'invalid-group-filter' },
        { code: 'invalid-state-filter' },
      ],
    });
  });

  it('resolves info selectors and exposes inventory metadata but no paths or file bytes', () => {
    const result = getCatalogSkillInfo(catalog(), 'review-api');
    expect(result).toMatchObject({
      ok: true,
      info: {
        id: 'backend/review-api',
        sourceRevision: 'f'.repeat(40),
        digest: FILE_HASH,
        inventory: [{ relativePath: 'SKILL.md', size: 20, sha256: FILE_HASH }],
      },
    });
    expect(result).not.toHaveProperty('info.rootPath');
    expect(result).not.toHaveProperty('info.frontMatter');
    expect(JSON.stringify(result)).not.toContain('/not-exposed/');
    if (result.ok) {
      expect(formatCatalogSkillInfoHuman(result.info)).toContain('SKILL.md (20 bytes, sha256:');
      expect(formatCatalogSkillInfoHuman(result.info)).not.toContain('/not-exposed/');
    }
  });

  it('reports every qualified candidate for ambiguous info', () => {
    const ambiguous = catalog([
      record('frontend/review-ui', {
        description: 'Review UI',
        agents: ['codex'],
        state: 'current',
      }),
      record('backend/review-ui', {
        description: 'Review backend UI',
        agents: ['claude'],
        state: 'current',
      }),
    ]);
    expect(getCatalogSkillInfo(ambiguous, 'review-ui')).toMatchObject({
      ok: false,
      errors: [
        {
          code: 'ambiguous-selector',
          candidates: ['backend/review-ui', 'frontend/review-ui'],
        },
      ],
    });
  });
});

describe('read-only validation source routing', () => {
  it('validates a configured library, catalog, and qualified ID without returning body bytes', async () => {
    await withTempDirectory('skill-sync-read-validation-', async (root) => {
      await createLibrary(root);
      const scanned = await scanCatalog(root, { sourceRevision: 'e'.repeat(40) });

      const libraryResult = await validateReadOnlySource({ kind: 'library', rootPath: root });
      const catalogResult = await validateReadOnlySource({ kind: 'catalog', catalog: scanned });
      const idResult = await validateReadOnlySource({
        kind: 'skill-id',
        catalog: scanned,
        selector: 'review-ui',
      });

      expect(libraryResult).toMatchObject({ valid: true, skills: [{ id: 'frontend/review-ui' }] });
      expect(catalogResult).toMatchObject({ valid: true, skills: [{ id: 'frontend/review-ui' }] });
      expect(idResult).toMatchObject({ valid: true, skills: [{ id: 'frontend/review-ui' }] });
      expect(JSON.stringify([libraryResult, catalogResult, idResult])).not.toContain(
        'DO-NOT-PRINT-SKILL-BODY',
      );
    });
  });

  it('validates an explicit local path without changing its bytes', async () => {
    await withTempDirectory('skill-sync-local-validation-', async (root) => {
      const skillRoot = await writeSkill(root, 'local-skill', 'LOCAL-BODY-MUST-STAY');
      const before = await readFile(join(skillRoot, 'SKILL.md'));
      const result = await validateReadOnlySource({ kind: 'local-path', path: skillRoot });
      const after = await readFile(join(skillRoot, 'SKILL.md'));

      expect(result).toMatchObject({ valid: true, skills: [{ id: 'local-skill' }], errors: [] });
      expect(after).toEqual(before);
      expect(JSON.stringify(result)).not.toContain('LOCAL-BODY-MUST-STAY');
    });
  });

  it('checks every installed target and reports divergent copies', async () => {
    await withTempDirectory('skill-sync-installed-validation-', async (root) => {
      const codex = await writeSkill(join(root, 'codex'), 'review-ui', 'codex body');
      const claude = await writeSkill(join(root, 'claude'), 'review-ui', 'different body');

      const result = await validateReadOnlySource({
        kind: 'installed-skill',
        id: 'frontend/review-ui',
        copies: [
          { target: 'codex', path: codex },
          { target: 'claude', path: claude },
        ],
      });
      expect(result).toMatchObject({
        valid: false,
        skills: [{ id: 'frontend/review-ui' }, { id: 'frontend/review-ui' }],
        errors: [{ code: 'divergent-installed-copies' }],
      });
    });
  });

  it('collects validation errors from every malformed installed target', async () => {
    await withTempDirectory('skill-sync-bad-installed-', async (root) => {
      const codex = join(root, 'codex', 'review-ui');
      const claude = join(root, 'claude', 'review-ui');
      await mkdir(codex, { recursive: true });
      await mkdir(claude, { recursive: true });
      await writeFile(join(codex, 'SKILL.md'), 'missing front matter');
      await writeFile(join(claude, 'SKILL.md'), 'also missing front matter');

      const result = await validateReadOnlySource({
        kind: 'installed-skill',
        id: 'frontend/review-ui',
        copies: [
          { target: 'codex', path: codex },
          { target: 'claude', path: claude },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.skills).toEqual([]);
      expect(result.errors.some((error) => error.source.startsWith('codex:'))).toBe(true);
      expect(result.errors.some((error) => error.source.startsWith('claude:'))).toBe(true);
    });
  });
});
