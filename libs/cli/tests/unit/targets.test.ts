import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { preflightTargets } from '../../src/application/target-preflight.js';
import { claudeTarget, codexTarget, TargetRegistry } from '../../src/targets/index.js';
import { withTempDirectory } from '../helpers/temp.js';

describe('target adapters and preflight', () => {
  it('resolves built-in global destinations from the current platform home directory', () => {
    expect(codexTarget.globalRoot?.()).toBe(join(homedir(), '.codex'));
    expect(codexTarget.globalDestination?.('review-ui')).toBe(
      join(homedir(), '.codex', 'skills', 'review-ui'),
    );
    expect(claudeTarget.globalRoot?.()).toBe(join(homedir(), '.claude'));
    expect(claudeTarget.globalDestination?.('review-ui')).toBe(
      join(homedir(), '.claude', 'skills', 'review-ui'),
    );
  });

  it('detects Codex and Claude and maps portable destinations', async () =>
    withTempDirectory('skill-sync-target-', async (root) => {
      await mkdir(join(root, '.codex'));
      await mkdir(join(root, '.claude'));
      const registry = new TargetRegistry();
      expect(await registry.detect(root)).toEqual(['claude', 'codex']);
      expect(registry.get('codex')?.relativeDestination('review-ui')).toBe(
        join('.codex', 'skills', 'review-ui'),
      );
    }));

  it('rejects cross-group leaf collisions before mutation', async () =>
    withTempDirectory('skill-sync-target-', async (root) => {
      const result = await preflightTargets({
        projectRoot: root,
        skills: [
          { id: 'frontend/review-ui', leafName: 'review-ui' },
          { id: 'backend/review-ui', leafName: 'review-ui' },
        ],
        targets: ['codex'],
        registry: new TargetRegistry(),
      });
      expect(result.plans).toEqual([]);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: 'DESTINATION_COLLISION' }),
      );
    }));

  it('refuses an unmanaged destination but permits its tracked owner', async () =>
    withTempDirectory('skill-sync-target-', async (root) => {
      const destination = join(root, '.codex', 'skills', 'review-ui');
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'SKILL.md'), '# local');
      const registry = new TargetRegistry();
      const unmanaged = await preflightTargets({
        projectRoot: root,
        skills: [{ id: 'frontend/review-ui', leafName: 'review-ui' }],
        targets: ['codex'],
        registry,
      });
      expect(unmanaged.issues[0]?.code).toBe('UNMANAGED_COLLISION');

      const managed = await preflightTargets({
        projectRoot: root,
        skills: [{ id: 'frontend/review-ui', leafName: 'review-ui' }],
        targets: ['codex'],
        registry,
        trackedDestinations: [
          { skillId: 'frontend/review-ui', target: 'codex', path: destination },
        ],
      });
      expect(managed.issues).toEqual([]);
      expect(managed.plans[0]?.alreadyManaged).toBe(true);
    }));

  it('rejects custom targets that escape the project root', async () =>
    withTempDirectory('skill-sync-target-', async (root) => {
      const registry = new TargetRegistry([]);
      registry.register({
        name: 'unsafe',
        detect: () => Promise.resolve(true),
        relativeDestination: () => '../../outside',
      });
      const result = await preflightTargets({
        projectRoot: root,
        skills: [{ id: 'hello', leafName: 'hello' }],
        targets: ['unsafe'],
        registry,
      });
      expect(result.issues[0]?.code).toBe('UNSAFE_PATH');
    }));
});
