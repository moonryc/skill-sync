import { describe, expect, it } from 'vitest';

import { createTuiLauncher } from '../../src/ui/tui/runner.js';
import type { RuntimeIo } from '../../src/ports/index.js';

function nonInteractiveIo(): RuntimeIo {
  return {
    stdinIsTty: false,
    stdoutIsTty: false,
    setExitCode: () => undefined,
    writeStderr: () => undefined,
    writeStdout: () => undefined,
  };
}

describe('TUI launcher', () => {
  it('refuses JSON, no-input, and non-terminal invocations before rendering', async () => {
    const launcher = createTuiLauncher({
      execute: () => Promise.reject(new Error('executor must not run')),
      io: nonInteractiveIo(),
    });

    await expect(
      launcher.launch({ implicit: false, options: { json: true } }),
    ).rejects.toMatchObject({
      code: 'INTERACTIVE_TERMINAL_REQUIRED',
    });
    await expect(launcher.launch({ implicit: false, options: {} })).rejects.toMatchObject({
      code: 'INTERACTIVE_TERMINAL_REQUIRED',
    });
  });
});
