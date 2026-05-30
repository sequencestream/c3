import { defineConfig } from 'vitest/config'

// Root Vitest config for the monorepo. Tests are colocated with sources as
// `*.test.ts` across the `server`, `shared`, and `web` workspaces and run in
// Node (web tests cover pure logic only — no DOM).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{server,shared,web}/src/**/*.test.ts'],
    globals: false,
  },
})
