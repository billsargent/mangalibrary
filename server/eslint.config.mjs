// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

/**
 * Flat ESLint config.
 *
 * These are the recommended rules, which run without type information and so
 * stay fast enough to be run on every change. Rules that need the type checker
 * (`no-floating-promises` and friends) can be layered on later by switching to
 * `recommendedTypeChecked`.
 *
 * `eslint-config-prettier` comes last on purpose: it turns off every rule that
 * would fight the formatter, so formatting is Prettier's business alone.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'build/**', 'coverage/**', 'src/generated/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Three places where `any` is the honest type because the shape really is
    // unknown: ambient module declarations, the capability spikes, and the
    // code generator, which walks the vendored spec's arbitrary JSON. The
    // generated output is itself type-checked, so mistakes surface there.
    files: ['**/*.d.ts', 'src/spikes/**', 'scripts/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
