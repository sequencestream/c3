import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Build output lands in dist/ with predictable asset names so the Go embed
// (web/embed.go) and the SPA-fallback handler can serve them as-is.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
