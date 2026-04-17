import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── Ignores ───────────────────────────────────────────────────────────────
  { ignores: ['node_modules', 'dist', 'src/_pending_extraction'] },

  // ── Base rules ────────────────────────────────────────────────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

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

      // Passing async functions where sync is expected silently swallows errors.
      '@typescript-eslint/no-misused-promises': 'error',

      // Adapter pattern: async interface over sync backend (e.g. better-sqlite3).
      '@typescript-eslint/require-await': 'off',


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

  // ── RPC parsing layer — JSON-RPC responses are inherently `any` ─────────────
  // The unsafe-* rules fire on every .result/.error access on the raw HTTP
  // response body. The right fix long-term is to type each response shape;
  // until then, scope the suppression to just these files.
  {
    files: ['src/rpc/**/*.ts', 'src/indexer/wsSessionManager.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment':    'off',
      '@typescript-eslint/no-unsafe-member-access':  'off',
      '@typescript-eslint/no-unsafe-argument':      'off',
      '@typescript-eslint/no-unsafe-return':        'off',
      '@typescript-eslint/no-unsafe-call':          'off',
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
      // Vitest spy matchers trigger false positives for unbound-method.
      '@typescript-eslint/unbound-method': 'off',
      // Tests inspect raw RPC/SQLite responses which are `any` typed.
      '@typescript-eslint/no-unsafe-assignment':    'off',
      '@typescript-eslint/no-unsafe-member-access':  'off',
      '@typescript-eslint/no-unsafe-argument':      'off',
      '@typescript-eslint/no-unsafe-return':        'off',
      '@typescript-eslint/no-unsafe-call':          'off',
    },
  },
);
