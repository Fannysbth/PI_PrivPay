/** Unit tests. Integration tests (`*.integration.spec.ts`) get their own config in M0-05. */
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/docs/', '\\.integration\\.spec\\.ts$'],
};
