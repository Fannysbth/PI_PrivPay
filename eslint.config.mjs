// Flat ESLint config. Rules mirror CLAUDE.md (conventions, forbidden practices) and the QA checklist.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Fixtures contain deliberate violations; tests/repo/lint-rules.spec.ts lints them on purpose.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'coverage/**',
      'docs/**',
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
    },
  },
  {
    files: ['**/*.config.{mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // CommonJS config files (Jest) use module.exports.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'writable', require: 'readonly' },
    },
  },
);
