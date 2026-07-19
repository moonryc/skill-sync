import process from 'node:process';

import type { RuntimeIo } from '../ports/index.js';

export const nodeRuntimeIo: RuntimeIo = {
  stdinIsTty: process.stdin.isTTY,
  stdoutIsTty: process.stdout.isTTY,
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};
