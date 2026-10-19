import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .github/scripts has its own node:test suite, run by the CI bot job.
    include: ['src/**/*.test.ts'],
    // Environment must exist before src/env.ts is imported, and the test
    // database must exist before any route test runs.
    setupFiles: ['./test/env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Route tests share one SQLite file; run files one at a time.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // Count files no test imports at all: the point of the report is to
      // show which handlers and routes the suite misses (issue #65).
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**'],
      reporter: ['text'],
      // Thresholds are today's measured values (issue #65): 88.52/88.48/
      // 90.30/88.52 for statements/branches/functions/lines across the
      // whole suite as of 2026-10-18, minus a small margin for run
      // variance. They are a floor to stop regressions, not an aspiration
      // — raising them means writing real tests, never lowering them.
      thresholds: {
        statements: 88,
        branches: 88,
        functions: 90,
        lines: 88,
      },
    },
  },
});
