/** Integration tests need PostgreSQL and the roles created by scripts/db/bootstrap.ps1. They run one at a time. */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testMatch: ['**/*.integration.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/docs/'],
  testEnvironmentOptions: { customExportConditions: ['source', 'node', 'node-addons'] },
  maxWorkers: 1,
  testTimeout: 30000,
};
