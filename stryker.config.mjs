/**
 * Mutation testing for the two pure helpers the API's lifecycle flags and
 * amount conversions rest on (issue #67).
 *
 * Run locally with `npm run mutation`. Deliberately NOT wired into CI: a
 * Stryker run is far slower than the test suite and belongs to periodic
 * quality checks, not every PR. The JSON report lands in reports/mutation/,
 * which is gitignored.
 */
export default {
  packageManager: 'npm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.ts' },
  mutate: ['src/lib/lifecycle.ts', 'src/lib/amounts.ts'],
  // perTest: each mutant is only checked against the tests that covered it.
  coverageAnalysis: 'perTest',
  // Display thresholds only; no `break`, so scoring never turns the command
  // red on an equivalent mutant.
  thresholds: { high: 95, low: 85 },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
};
