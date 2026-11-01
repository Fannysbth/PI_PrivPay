// Flat ESLint config. Rules mirror project rules (conventions, forbidden practices) and the QA checklist.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const testFunctions = ['it', 'test', 'describe'];
// Names that mark a value as a secret. `token` is left out on purpose: it is compared everywhere as a presence check.
const SECRET_NAME = '/secret|passw(or)?d|hmac|api_?key|private_?key/i';
// An equality test none of whose operands is a literal, undefined, null-like `void 0`: those are presence checks.
const SECRET_COMPARISON =
  "BinaryExpression[operator=/^[!=]==?$/]:not(:has(> Literal)):not(:has(> Identifier[name='undefined'])):not(:has(> UnaryExpression[operator='void']))";

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
      // Command-line helpers outside any tsconfig; they print with console on purpose.
      'tools/*/scripts/**',
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
      // Nest modules are empty classes that only carry decorator metadata.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      // Express recognises an error handler by its four parameters, so a leading underscore marks an unused one.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Skipping or focusing tests to get a green run is forbidden (project rules, qa-checklist Q-05).
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
      // A secret is compared with safeEqual from @privpay/common (timingSafeEqual), never with ===, !==, == or
      // Buffer.equals, which stop at the first differing byte (Phase 2 requirement, M1-02). The rule goes by the
      // name of the operand; a comparison with a literal, null or undefined (a presence check) is not about a secret
      // value and is left alone.
      'no-restricted-syntax': [
        'error',
        ...[
          `${SECRET_COMPARISON} > Identifier[name=${SECRET_NAME}]`,
          `${SECRET_COMPARISON} > MemberExpression[property.name=${SECRET_NAME}]`,
          // A string key: request['client_secret'].
          `${SECRET_COMPARISON} > MemberExpression[computed=true][property.value=${SECRET_NAME}]`,
          // Buffer.equals with the secret as the receiver or as the argument, and Buffer.compare.
          `CallExpression[callee.property.name='equals'][callee.object.name=${SECRET_NAME}]`,
          `CallExpression[callee.property.name='equals'][callee.object.property.name=${SECRET_NAME}]`,
          `CallExpression[callee.property.name='equals'] > Identifier.arguments[name=${SECRET_NAME}]`,
          `CallExpression[callee.property.name='equals'] > MemberExpression.arguments[property.name=${SECRET_NAME}]`,
          `CallExpression[callee.object.name='Buffer'][callee.property.name='compare'] > Identifier.arguments[name=${SECRET_NAME}]`,
        ].map((selector) => ({
          selector,
          message:
            'Compare secrets with safeEqual (timingSafeEqual), not with ===, !==, == or Buffer.equals.',
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
