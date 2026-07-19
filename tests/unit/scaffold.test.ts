import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../../src/domain/index.js';

describe('package scaffold', () => {
  it('uses the initial schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
