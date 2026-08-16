import { defineConfig } from 'vitest/config';

const defaultTimeout = process.platform === 'win32' ? 60_000 : 15_000;

export default defineConfig({
  root: import.meta.dirname,
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: defaultTimeout,
    hookTimeout: defaultTimeout,
    restoreMocks: true,
    clearMocks: true,
    pool: 'forks',
  },
});
