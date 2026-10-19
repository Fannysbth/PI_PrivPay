// Flat ESLint config. Rules mirror CLAUDE.md (conventions, forbidden practices) and the QA checklist.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const testFunctions = ['it', 'test', 'describe'];

export default tseslint.config(
  {
    // Same areas Prettier skips, plus build output. Fixtures contain deliberate violations;
    // tests/repo/lint-rules.spec.ts lints them on purpose with --no-ignore.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      'docs/**',
      'deploy/**',
      'scripts/**',
      'prototypes/**',
      'tests/repo/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.mjs', '*.config.cjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Services must use the redacting logger from packages/common (S-45).
      'no-console': 'error',
      // Silent failures are forbidden (qa-checklist E-06): even an empty catch needs a reason.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // Skipping or focusing tests to get a green run is forbidden (CLAUDE.md, qa-checklist Q-05).
      'no-restricted-properties': [
        'error',
        ...testFunctions.flatMap((object) =>
          ['only', 'skip'].map((property) => ({
            object,
            property,
            message: 'Focused or skipped tests are not allowed.',
          })),
        ),
      ],
      'no-restricted-globals': [
        'error',
        ...['fit', 'fdescribe', 'xit', 'xdescribe', 'xtest'].map((name) => ({
          name,
          message: 'Focused or skipped tests are not allowed.',
        })),
      ],
    },
  },
  {
    // Config files are not part of any tsconfig, so type-aware rules (including no-floating-promises) are off there.
    files: ['**/*.config.{mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Jest's config is CommonJS and uses module.exports.
    files: ['jest*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly' },
    },
  },
);
