import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Test files share one Postgres database, so they must not run in parallel.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
