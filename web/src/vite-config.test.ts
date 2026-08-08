import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../vite.config'

// 拆包配置里唯一有逻辑的一段:i18n-messages 这个 chunk 的成员是从 locales 目录扫出来
// 的,不是手写清单。钉住扫描口径——新增一门语言必须自动进 chunk,而 `.freeze-manifest.json`
// 这类点开头的工具文件不是消息源、绝不能被当成语言包打进去。

const LOCALES_DIR = fileURLToPath(new URL('../src/locales', import.meta.url))

function manualChunks(): Record<string, string[]> {
  const output = config.build?.rollupOptions?.output
  const single = Array.isArray(output) ? output[0] : output
  return single?.manualChunks as Record<string, string[]>
}

describe('web/vite.config.ts 拆包配置', () => {
  it('i18n-messages chunk 覆盖 locales 目录下的全部语言包', () => {
    const expected = readdirSync(LOCALES_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .map((f) => join(LOCALES_DIR, f))
    expect(expected.length).toBeGreaterThan(0)
    expect([...manualChunks()['i18n-messages']].sort()).toEqual([...expected].sort())
  })

  it('点开头的工具文件不进语言包 chunk', () => {
    const dotFiles = readdirSync(LOCALES_DIR).filter((f) => f.startsWith('.'))
    expect(dotFiles).toContain('.freeze-manifest.json')
    const bundled = manualChunks()['i18n-messages'].map((p) => basename(p))
    for (const f of dotFiles) expect(bundled).not.toContain(f)
  })

  it('第三方运行时与业务代码分家,便于长缓存', () => {
    expect(Object.keys(manualChunks())).toEqual(
      expect.arrayContaining(['vendor-vue', 'vendor-markdown', 'i18n-messages']),
    )
  })
})
