import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Root Vitest config for the monorepo. Tests are colocated with sources as
// `*.test.ts` across the `server`, `shared`, and `web` workspaces. Most run in
// Node (pure logic — no DOM); Vue component tests — shared ones under
// `web/src/components` and page-private ones under `web/src/pages/*/components`
// — mount real SFCs (via the `vue()` plugin) and run in happy-dom instead.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['web/src/components/**', 'happy-dom'],
      ['web/src/pages/**', 'happy-dom'],
    ],
    include: ['{server,shared,web}/src/**/*.test.ts'],
    globals: false,
  },
})
