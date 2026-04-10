import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── Ignores ───────────────────────────────────────────────────────────────
  { ignores: ['node_modules', 'dist', 'src/_pending_extraction'] },

  // ── Base rules ────────────────────────────────────────────────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommended,

  // ── Project-specific overrides ────────────────────────────────────────────
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Warn (not error) on explicit any — test doubles may legitimately need
      // `as unknown as T`; production code should never need bare `any`.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Floating promises are real bugs in async code — enforce void/await.
      '@typescript-eslint/no-floating-promises': 'error',

      // Unused vars are dead code. Prefix with _ to intentionally suppress.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Prefer nullish coalescing (??) over || for nullable values.
      // Helps catch cases like `0 || fallback` silently eating valid zeros.
      '@typescript-eslint/prefer-nullish-coalescing': 'warn',

      // Consistent type imports keep the bundle clean (erased at compile time).
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // No-op: this is a CLI/server tool — console.log is fine.
      'no-console': 'off',
    },
  },

  // ── Relax rules in test files ─────────────────────────────────────────────
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Test doubles routinely need `as unknown as SomeComplexType`.
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests intentionally use non-null assertions for clarity.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
