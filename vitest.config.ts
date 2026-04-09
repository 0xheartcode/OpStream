import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';

/**
 * node:sqlite was added in Node.js 22.5+ and is stable in Node 24.
 * Vite doesn't recognise it as a known built-in, so we serve a virtual module
 * that loads it via createRequire so Vite's bundler never resolves it as a file.
 */
const nodeSqlitePlugin: Plugin = {
  name: 'vite-plugin-node-sqlite',
  enforce: 'pre',
  resolveId(id: string) {
    if (id === 'node:sqlite' || id === 'sqlite') {
      return '\0virtual:node-sqlite';
    }
  },
  load(id: string) {
    if (id === '\0virtual:node-sqlite') {
      return `
import { createRequire } from 'module';
const _require = createRequire(process.cwd() + '/');
const _m = _require('node:sqlite');
export const DatabaseSync = _m.DatabaseSync;
export const StatementSync = _m.StatementSync;
export default _m;
`;
    }
  },
};

export default defineConfig({
  plugins: [nodeSqlitePlugin],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
