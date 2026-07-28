import { describe, expect, it } from 'vitest';

import { temporaryDirectoryPrefix } from '../helpers/temp.js';

describe('temporaryDirectoryPrefix', () => {
  it('keeps caller context outside Windows', () => {
    expect(temporaryDirectoryPrefix('skill-sync-library-', 'linux')).toBe('skill-sync-library-');
  });

  it('uses a compact prefix on Windows to avoid deep fixture paths', () => {
    expect(temporaryDirectoryPrefix('skill-sync-library-', 'win32')).toBe('ss-');
  });
});
