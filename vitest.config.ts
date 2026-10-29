import { defineConfig } from 'vitest/config';
import path from 'path';

// Tests run from dashboard/ (D, 2026-10-12: a fresh clone runs its own tests): `npm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'server-only': path.resolve(__dirname, 'src/test/server-only.ts'), // Next's build guard, not a real package in tests
      'next/server': path.resolve(__dirname, 'node_modules/next/server.js'), // next-auth imports it without the extension
    },
  },
  // next-auth inlined so the next/server alias reaches it (loaded as an outside module it asked for next/server with no extension and failed)
  test: { globals: true, testTimeout: 10000, include: ['src/**/__tests__/**/*.test.ts'], server: { deps: { inline: ['next-auth'] } } },
});
