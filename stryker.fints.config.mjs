export default {
  mutate: ['runtime/account/tx/handlers/settlement/workspace-views.ts'],
  testRunner: 'command',
  commandRunner: {
    command: 'bun test runtime/__tests__/account/settlement/settlement-workspace-views.test.ts',
  },
  coverageAnalysis: 'off',
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/stryker-fints.json' },
  thresholds: { high: 100, low: 100, break: 100 },
  concurrency: 4,
  timeoutMS: 5_000,
  timeoutFactor: 2,
  cleanTempDir: 'always',
};
