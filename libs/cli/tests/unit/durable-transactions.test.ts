import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acquireAdvisoryLock,
  createOperationJournal,
  createRecoverableBackup,
  createStagingDirectory,
  listOperationJournals,
  readOperationJournal,
  replacePathsAtomically,
  stageRegularPath,
  updateOperationJournal,
} from '../../src/infrastructure/transactions.js';
import { withTempDirectory } from '../helpers/temp.js';

describe('transaction primitives', () => {
  it('uses owner-checked exclusive advisory locks', async () => {
    await withTempDirectory('skill-sync-lock-', async (root) => {
      const path = join(root, 'locks', 'library.lock');
      const first = await acquireAdvisoryLock(path, {
        hostname: 'test-host',
        now: new Date('2026-01-01T00:00:00.000Z'),
        operationId: 'first-operation',
        pid: 123,
      });
      await expect(
        acquireAdvisoryLock(path, { operationId: 'second-operation' }),
      ).rejects.toMatchObject({
        owner: { operationId: 'first-operation', pid: 123 },
      });
      await first.release();
      await first.release();
      const second = await acquireAdvisoryLock(path, { operationId: 'second-operation' });
      await second.release();
    });
  });

  it('persists stable operation journals with checked state transitions', async () => {
    await withTempDirectory('skill-sync-journal-', async (root) => {
      const created = await createOperationJournal(join(root, 'journals'), {
        entries: [
          {
            action: 'replace',
            destination: '.codex/skills/example',
            state: 'pending',
          },
        ],
        kind: 'install',
        now: new Date('2026-01-01T00:00:00.000Z'),
        operationId: 'install-example',
      });
      const [entry] = created.value.entries;
      if (entry === undefined) throw new Error('Expected the journal fixture entry.');
      await updateOperationJournal(created.path, {
        entries: [{ ...entry, state: 'prepared' }],
        now: new Date('2026-01-01T00:00:01.000Z'),
        status: 'prepared',
      });
      expect((await readOperationJournal(created.path)).status).toBe('prepared');
      expect(await listOperationJournals(join(root, 'journals'))).toHaveLength(1);
      await expect(updateOperationJournal(created.path, { status: 'committed' })).rejects.toThrow(
        /Invalid journal transition/u,
      );
    });
  });

  it('stages only inert regular content and rejects symlinks', async () => {
    await withTempDirectory('skill-sync-stage-', async (root) => {
      const source = join(root, 'source');
      const staging = await createStagingDirectory(join(root, 'staging'), 'install');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), '# Example\n');
      const staged = await stageRegularPath(source, staging, 'frontend/example');
      expect(await readFile(join(staged, 'SKILL.md'), 'utf8')).toBe('# Example\n');

      const linkedSource = join(root, 'linked-source');
      await mkdir(linkedSource);
      await symlink(join(source, 'SKILL.md'), join(linkedSource, 'SKILL.md'));
      await expect(stageRegularPath(linkedSource, staging, 'linked/example')).rejects.toThrow(
        /symbolic link/u,
      );
    });
  });

  it('rolls every committed destination back when a later replacement fails', async () => {
    await withTempDirectory('skill-sync-replace-', async (root) => {
      const project = join(root, 'project');
      const staged = join(root, 'staged');
      const firstDestination = join(project, '.codex', 'skills', 'first');
      const secondDestination = join(project, '.claude', 'skills', 'first');
      await mkdir(firstDestination, { recursive: true });
      await mkdir(secondDestination, { recursive: true });
      await mkdir(join(staged, 'first'), { recursive: true });
      await mkdir(join(staged, 'second'), { recursive: true });
      await writeFile(join(firstDestination, 'SKILL.md'), 'old codex');
      await writeFile(join(secondDestination, 'SKILL.md'), 'old claude');
      await writeFile(join(staged, 'first', 'SKILL.md'), 'new codex');
      await writeFile(join(staged, 'second', 'SKILL.md'), 'new claude');

      await expect(
        replacePathsAtomically({
          hooks: {
            beforeCommit: (index) => {
              if (index === 1) throw new Error('injected second-target failure');
            },
          },
          journalDirectory: join(root, 'journals'),
          kind: 'update',
          operationId: 'update-first',
          replacements: [
            {
              action: 'replace',
              destinationPath: firstDestination,
              stagedPath: join(staged, 'first'),
            },
            {
              action: 'replace',
              destinationPath: secondDestination,
              stagedPath: join(staged, 'second'),
            },
          ],
          root: project,
        }),
      ).rejects.toThrow(/injected second-target failure/u);

      expect(await readFile(join(firstDestination, 'SKILL.md'), 'utf8')).toBe('old codex');
      expect(await readFile(join(secondDestination, 'SKILL.md'), 'utf8')).toBe('old claude');
      expect((await listOperationJournals(join(root, 'journals')))[0]?.value.status).toBe(
        'rolled-back',
      );
    });
  });

  it('atomically replaces and removes paths on success', async () => {
    await withTempDirectory('skill-sync-commit-', async (root) => {
      const project = join(root, 'project');
      const destination = join(project, '.codex', 'skills', 'example');
      const removed = join(project, '.claude', 'skills', 'old');
      const staged = join(root, 'staged');
      await mkdir(destination, { recursive: true });
      await mkdir(removed, { recursive: true });
      await mkdir(staged);
      await writeFile(join(destination, 'SKILL.md'), 'old');
      await writeFile(join(removed, 'SKILL.md'), 'remove');
      await writeFile(join(staged, 'SKILL.md'), 'new');

      await replacePathsAtomically({
        kind: 'reconcile',
        operationId: 'replace-example',
        replacements: [
          { action: 'replace', destinationPath: destination, stagedPath: staged },
          { action: 'remove', destinationPath: removed },
        ],
        root: project,
      });
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('new');
      await expect(readFile(join(removed, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  });

  it('creates recoverable bounded backups with relative restore metadata', async () => {
    await withTempDirectory('skill-sync-backup-', async (root) => {
      const project = join(root, 'project');
      const skill = join(project, '.codex', 'skills', 'example');
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), 'local work');
      await writeFile(join(project, 'skill-sync.json'), '{"schemaVersion":1}\n');

      const backup = await createRecoverableBackup({
        backupRoot: join(root, 'backups'),
        entries: [
          { path: skill, relativePath: '.codex/skills/example' },
          { path: join(project, 'skill-sync.json'), relativePath: 'skill-sync.json' },
        ],
        now: new Date('2026-01-01T00:00:00.000Z'),
        operationId: 'discard-example',
        projectRoot: project,
      });

      expect(
        await readFile(
          join(backup.path, 'files', '.codex', 'skills', 'example', 'SKILL.md'),
          'utf8',
        ),
      ).toBe('local work');
      expect(JSON.stringify(backup.manifest)).not.toContain(project);
      expect(backup.manifest.entries.map((entry) => entry.originalPath)).toEqual([
        '.codex/skills/example',
        'skill-sync.json',
      ]);
    });
  });
});
