import { describe, expect, it } from 'vitest';

import { terminalSafe } from '../../src/ui/tui/sanitize.js';

describe('terminal-safe text', () => {
  it('removes terminal control sequences from untrusted content', () => {
    expect(terminalSafe('help\u001b[2J\nnext')).toBe('help [2J next');
  });
});
