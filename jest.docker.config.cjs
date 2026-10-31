/** Tests that need Docker (a throwaway container, or the running Compose stack): `pnpm test:edge`. Not part of `pnpm test`. */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testMatch: ['**/*.docker.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/docs/'],
  testEnvironmentOptions: { customExportConditions: ['source', 'node', 'node-addons'] },
  maxWorkers: 1,
  testTimeout: 120000,
};
