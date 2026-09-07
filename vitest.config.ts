import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The replay suites share one database and truncate between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The server and the job entrypoints are argument wiring; the live
      // gateway needs a key to execute at all.
      exclude: ['src/server.ts', 'src/stripe/client.ts', 'src/db/migrate.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
