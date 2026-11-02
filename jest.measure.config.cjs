/** M6 measurements on the running Compose stack (`pnpm measure:exposure`). Not part of `pnpm test` and not of `pnpm test:edge`. */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testMatch: ['**/*.measure.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/docs/'],
  testEnvironmentOptions: { customExportConditions: ['source', 'node', 'node-addons'] },
  maxWorkers: 1,
  testTimeout: 3600000,
};
