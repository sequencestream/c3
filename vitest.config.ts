import { defineConfig } from 'vitest/config'

// Root Vitest config for the monorepo. Tests are colocated with sources as
// `*.test.ts` across the `server` and `shared` workspaces and run in Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{server,shared}/src/**/*.test.ts'],
    globals: false,
  },
})
