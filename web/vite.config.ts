import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const LOCALES_DIR = fileURLToPath(new URL('./src/locales', import.meta.url))

/** 全部语言包文件(新增一门语言无需改本配置)。`.freeze-manifest.json` 等点开头的
 *  工具文件不是消息源,不参与打包。 */
const localeMessageFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  .map((f) => join(LOCALES_DIR, f))

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
    // 拆包策略(整体):
    //  1. 业务页面与低频全局组件由 App.vue 以 defineAsyncComponent(() => import(...))
    //     装配,首次进入某个 tab / 首次打开某个弹窗时才拉取自己的 chunk。新增页面请沿用
    //     这一约定(约定与挂载门的说明写在 App.vue 顶部与 web/PAGES.md),不要退回静态
    //     import——那会把整页代码重新压回首屏主包。
    //  2. 变动频率低、体积稳定的运行时与数据在下方 manualChunks 里定点拆出。
    // 900 的阈值是「发现异常体积增长」的探针,不是可以随手上调的旋钮:主 chunk 再次
    // 越线时应当去拆代码,而不是抬高这个数字把告警消音。shiki 单语言 grammar chunk
    // (如 ruby)和 mermaid 图表 chunk 本就是按需加载的大块,允许贴近该线。
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 把变动频率低的第三方运行时从业务主包中拆出:既稳定缓存,又让单个 chunk
        // 回到告警阈值以下。markdown-it/dompurify 仅服务 Markdown 渲染管线。
        // i18n-messages 是 5 份预编译语言包(约 730KB,占拆包前主包的一多半):它们是
        // 数据不是代码,与业务代码同 chunk 只会让任何一行业务改动都作废整包缓存。这里
        // 只做「分家」,仍随首屏静态加载——按语言动态加载是另一件事,不在此处偷渡。
        manualChunks: {
          'vendor-vue': ['vue', 'vue-i18n'],
          'vendor-markdown': ['markdown-it', 'dompurify'],
          'i18n-messages': localeMessageFiles,
        },
      },
    },
  },
})
