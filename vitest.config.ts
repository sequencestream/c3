import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// Root Vitest config for the monorepo. Tests are colocated with sources as
// `*.test.ts` across the `server`, `shared`, and `web` workspaces. Most run in
// Node (pure logic — no DOM); Vue component tests — shared ones under
// `web/src/components` and page-private ones under `web/src/pages/*/components`
// — mount real SFCs (via the `vue()` plugin) and run in happy-dom instead.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    // Mirror web/vite.config.ts so component tests resolve `@/…` (web/src) imports.
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['web/src/components/**', 'happy-dom'],
      ['web/src/pages/**', 'happy-dom'],
    ],
    include: [
      '{server,shared,web}/src/**/*.test.ts',
      'server/test/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    setupFiles: ['./web/src/test-setup.ts'],
    globals: false,
  },
})
