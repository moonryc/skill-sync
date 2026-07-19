import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PROJECT_LOCK_FILENAME,
  PROJECT_MANIFEST_FILENAME,
  projectManifestSchema,
} from '../../src/domain/project-state.js';
import {
  ProjectStateVersionError,
  assertProjectStatePair,
  parseProjectLock,
  parseProjectManifest,
  readProjectLock,
  readProjectManifest,
  resolveContainedProjectPath,
  resolveProjectRoot,
  writeProjectLock,
  writeProjectManifest,
} from '../../src/infrastructure/project-state.js';
import { createFixtureProject } from '../helpers/fixtures.js';
import { withTempDirectory } from '../helpers/temp.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const revision = 'c'.repeat(40);

const manifest = {
  gitignore: 'managed',
  library: { identity: 'github.com/acme/skills' },
  schemaVersion: 1,
  skills: [
    {
      id: 'frontend/review-ui',
      projections: [
        { destination: '.codex/skills/review-ui', target: 'codex' },
        { destination: '.claude/skills/review-ui', target: 'claude' },
      ],
    },
  ],
} as const;

const lock = {
  library: { identity: 'github.com/acme/skills', revision },
  schemaVersion: 1,
  skills: [
    {
      baseDigest: digestA,
      canonicalDigest: digestB,
      id: 'frontend/review-ui',
      projections: [
        { destination: '.codex/skills/review-ui', digest: digestA, target: 'codex' },
        { destination: '.claude/skills/review-ui', digest: digestA, target: 'claude' },
      ],
    },
  ],
} as const;

describe('portable project state', () => {
  it('canonicalizes state and writes deterministic atomic JSON', async () => {
    await withTempDirectory('skill-sync-state-', async (root) => {
      const reversedManifest = {
        ...manifest,
        skills: [
          { id: 'z-last', projections: [{ destination: 'z/path', target: 'codex' }] },
          ...manifest.skills.map((skill) => ({
            ...skill,
            projections: [...skill.projections].reverse(),
          })),
        ],
      };
      await writeProjectManifest(root, reversedManifest);
      await writeProjectLock(root, lock);

      const parsedManifest = await readProjectManifest(root);
      const parsedLock = await readProjectLock(root);
      expect(parsedManifest?.skills.map((skill) => skill.id)).toEqual([
        'frontend/review-ui',
        'z-last',
      ]);
      expect(parsedManifest?.skills[0]?.projections.map((item) => item.target)).toEqual([
        'claude',
        'codex',
      ]);
      expect(parsedLock).toEqual(parseProjectLock(lock));
      expect(await readFile(join(root, PROJECT_MANIFEST_FILENAME), 'utf8')).toMatch(/\n$/u);
      expect(await readFile(join(root, PROJECT_LOCK_FILENAME), 'utf8')).not.toContain(root);
    });
  });

  it('rejects absolute, traversal, credential-bearing, duplicate, and versioned state', () => {
    expect(() =>
      projectManifestSchema.parse({
        ...manifest,
        skills: [
          {
            ...manifest.skills[0],
            projections: [{ destination: '/tmp/review-ui', target: 'codex' }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      projectManifestSchema.parse({
        ...manifest,
        skills: [
          {
            ...manifest.skills[0],
            projections: [{ destination: '../review-ui', target: 'codex' }],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseProjectManifest({
        ...manifest,
        library: { identity: 'https://person:secret@github.com/acme/skills' },
      }),
    ).toThrow(/credential-free/u);
    expect(() => parseProjectManifest({ ...manifest, schemaVersion: 2 })).toThrow(
      ProjectStateVersionError,
    );
    expect(() => parseProjectManifest({ ...manifest, schemaVersion: 0 })).toThrow(/migration/u);
    expect(() => parseProjectManifest({ ...manifest, schemaVersion: '1' })).toThrow(
      /integer schemaVersion/u,
    );
  });

  it('resolves explicit, enclosing Git, and current-directory project roots', async () => {
    await withTempDirectory('skill-sync-root-', async (root) => {
      const project = join(root, 'project');
      const nested = join(project, 'packages', 'nested');
      await createFixtureProject(project);
      await mkdir(nested, { recursive: true });

      expect(await resolveProjectRoot({ cwd: nested })).toBe(await realpath(project));
      expect(await resolveProjectRoot({ cwd: nested, explicitPath: '..' })).toBe(
        await realpath(join(project, 'packages')),
      );
      expect(
        await resolveProjectRoot({
          cwd: nested,
          gitRootResolver: () => Promise.resolve(undefined),
        }),
      ).toBe(await realpath(nested));
    });
  });

  it('rejects destinations that escape through an existing symlink', async () => {
    await withTempDirectory('skill-sync-containment-', async (root) => {
      const project = join(root, 'project');
      const outside = join(root, 'outside');
      await mkdir(project);
      await mkdir(outside);
      await writeFile(join(outside, 'valuable.txt'), 'keep');
      await symlink(outside, join(project, 'linked'));

      await expect(resolveContainedProjectPath(project, 'linked/new-skill')).rejects.toThrow(
        /escapes/u,
      );
      await expect(resolveContainedProjectPath(project, '.codex/skills/new-skill')).resolves.toBe(
        join(await realpath(project), '.codex', 'skills', 'new-skill'),
      );
    });
  });

  it('checks that manifest and lock describe the same portable projections', () => {
    const parsedManifest = parseProjectManifest(manifest);
    const parsedLock = parseProjectLock(lock);
    expect(() => assertProjectStatePair(parsedManifest, parsedLock)).not.toThrow();
    expect(() =>
      assertProjectStatePair(parsedManifest, {
        ...parsedLock,
        library: { ...parsedLock.library, identity: 'github.com/other/skills' },
      }),
    ).toThrow(/different library identities/u);
  });
});
