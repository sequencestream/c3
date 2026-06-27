import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [
    vue(),
    // 编译期预编译 i18n 消息;runtimeOnly 让运行期不再携带消息编译器
    VueI18nPlugin({
      runtimeOnly: true,
      compositionOnly: true,
      include: [fileURLToPath(new URL('./src/locales/**', import.meta.url))],
    }),
  ],
  resolve: {
    alias: {
      '@ccc/shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // shiki 单语言 grammar chunk(如 ruby)和主应用 chunk 可能略高于 Vite 默认阈值。
    // 这里按当前拆包策略放宽告警线,保留对异常体积增长的提示。
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 把变动频率低的第三方运行时从业务主包中拆出:既稳定缓存,又让单个 chunk
        // 回到告警阈值以下。markdown-it/dompurify 仅服务 Markdown 渲染管线。
        manualChunks: {
          'vendor-vue': ['vue', 'vue-i18n'],
          'vendor-markdown': ['markdown-it', 'dompurify'],
        },
      },
    },
  },
})
