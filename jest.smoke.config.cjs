/** Smoke tests run the built output (`pnpm build`) as real processes, one at a time (N-04). */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testMatch: ['**/*.smoke.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/docs/'],
  // `source` makes workspace packages resolve to their TypeScript, as in the unit tests; the processes started by the
  // tests use the built `dist` through the default condition.
  testEnvironmentOptions: { customExportConditions: ['source', 'node', 'node-addons'] },
  maxWorkers: 1,
  testTimeout: 30000,
};
