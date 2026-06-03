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
    // 唯一可能超 500KB 的产物是 shiki 单语言 grammar chunk(如 ruby —— 其自包含的内嵌
    // 语法含 cpp,无法被 Vite 拆出共享)。这些是首屏不加载、仅在对应代码块出现时才拉取的
    // 懒加载 chunk,体积大不影响首屏,故按 Vite 官方建议放宽阈值消除噪音告警。
    chunkSizeWarningLimit: 800,
  },
})
