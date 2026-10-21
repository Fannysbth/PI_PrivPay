/** Unit tests. Integration tests (`*.integration.spec.ts`) and smoke tests (`*.smoke.spec.ts`) have their own configs. */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/docs/',
    '\\.integration\\.spec\\.ts$',
    '\\.smoke\\.spec\\.ts$',
  ],
  // `source` resolves workspace packages to their TypeScript (see their package.json exports); the built output is
  // only used by the processes the smoke tests start.
  testEnvironmentOptions: { customExportConditions: ['source', 'node', 'node-addons'] },
};
