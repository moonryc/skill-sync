import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDefaultCommandExecutor } from '../../src/commands/default-executor.js';
import { EXIT_CODES } from '../../src/domain/result.js';
import { resolveApplicationPaths } from '../../src/infrastructure/config.js';
import type { RuntimeIo } from '../../src/ports/index.js';
import { withTempDirectory } from '../helpers/temp.js';

function memoryIo(): RuntimeIo {
  return {
    stdinIsTty: false,
    stdoutIsTty: false,
    writeStdout: () => undefined,
    writeStderr: () => undefined,
    setExitCode: () => undefined,
  };
}

describe('default command executor dispatch', () => {
  it('routes system and workflow commands and preserves expected unknown-command status', async () => {
    await withTempDirectory('skill-sync-default-executor-', async (root) => {
      const environment = { CI: '1', SKILL_SYNC_CONFIG_HOME: join(root, 'config') };
      const paths = resolveApplicationPaths({ cwd: root, env: environment });
      const execute = createDefaultCommandExecutor(memoryIo(), { environment, paths });

      await expect(
        execute({ command: 'config:path', arguments: [], options: { json: true } }),
      ).resolves.toEqual({ ok: true, data: { path: paths.configFile }, exitCode: 0 });

      const skill = join(root, 'hello');
      await mkdir(skill);
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: hello\ndescription: Local fixture\n---\n\n# Hello\n',
      );
      await expect(
        execute({ command: 'validate', arguments: [skill], options: { json: true } }),
      ).resolves.toMatchObject({
        data: { kind: 'local-path', valid: true },
        exitCode: EXIT_CODES.success,
        ok: true,
      });

      await expect(
        execute({ command: 'not-a-command', arguments: [], options: {} }),
      ).resolves.toMatchObject({
        errors: [{ code: 'UNKNOWN_COMMAND' }],
        exitCode: EXIT_CODES.usage,
        ok: false,
      });
    });
  });
});
