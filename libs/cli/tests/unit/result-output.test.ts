import { describe, expect, it } from 'vitest';

import {
  EXIT_CODES,
  failure,
  redactSecrets,
  resultFromUnknown,
  SkillSyncError,
  success,
} from '../../src/domain/result.js';
import { renderResult } from '../../src/ui/output.js';
import type { RuntimeIo } from '../../src/ports/index.js';

function memoryIo() {
  const state = { stdout: '', stderr: '', exitCode: -1 };
  const io: RuntimeIo = {
    stdinIsTty: false,
    stdoutIsTty: false,
    writeStdout: (value) => {
      state.stdout += value;
    },
    writeStderr: (value) => {
      state.stderr += value;
    },
    setExitCode: (value) => {
      state.exitCode = value;
    },
  };
  return { io, state };
}

describe('command result and output contracts', () => {
  it('writes exactly one versioned JSON success object', () => {
    const { io, state } = memoryIo();
    renderResult('list', success({ skills: [] }), { json: true, color: false }, io);
    expect(state.stderr).toBe('');
    expect(state.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(state.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: 'list',
      data: { skills: [] },
    });
    expect(state.exitCode).toBe(0);
  });

  it('redacts credentials from JSON errors', () => {
    const { io, state } = memoryIo();
    renderResult(
      'init',
      failure(
        {
          code: 'REPOSITORY_ERROR',
          message: 'failed https://moon:secret@github.com/x/y?token=top-secret',
        },
        EXIT_CODES.repository,
      ),
      { json: true, color: false },
      io,
    );
    expect(state.stdout).not.toContain('secret@');
    expect(state.stdout).not.toContain('top-secret');
    expect(state.exitCode).toBe(4);
  });

  it('maps expected and unexpected errors to stable statuses', () => {
    expect(
      resultFromUnknown(new SkillSyncError('BAD_CONFIG', 'invalid', EXIT_CODES.validation)),
    ).toMatchObject({ ok: false, exitCode: 3 });
    expect(resultFromUnknown(new Error('boom'))).toMatchObject({ ok: false, exitCode: 1 });
  });

  it('redacts common token forms', () => {
    expect(redactSecrets('Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
    expect(redactSecrets('token=github_pat_abcdefghijklmnopqrstuv')).not.toContain('github_pat_');
  });
});
