/**
 * The model vendor directory: identity coercion, labels, and the shipped model catalogs.
 *
 * What is guarded here is that the directory stays a well-formed suggestion source — ids are
 * unique and permanent, every entry is labelled and grouped, no shipped id is blank or
 * duplicated, and an id c3 does not know degrades to `custom` instead of throwing. The model
 * ids themselves are release-maintenance facts, not properties a test can assert.
 */
import { describe, expect, it } from 'vitest'
import type { ModelVendor, ModelVendorId } from './model-vendor-catalog.js'
import {
  MODEL_VENDORS,
  modelVendorLabel,
  modelVendorModels,
  normalizeModelVendor,
} from './model-vendor-catalog.js'

const VENDOR_IDS = MODEL_VENDORS.map((v) => v.id)
/** `as const` narrows every entry to literals; the widened view is what consumers see. */
const VENDORS: readonly ModelVendor[] = MODEL_VENDORS

describe('目录本身', () => {
  it('id 唯一,且每条都有非空标签与分组', () => {
    expect(new Set(VENDOR_IDS).size).toBe(VENDOR_IDS.length)
    for (const v of VENDORS) {
      expect(v.displayName.trim()).not.toBe('')
      expect(['model', 'cloud', 'gateway', 'local', 'custom']).toContain(v.group)
    }
  })

  it('兜底项 custom 始终存在,且排在最后', () => {
    expect(VENDOR_IDS.at(-1)).toBe('custom')
  })

  it('意图点名的厂商都在目录里', () => {
    const named: ModelVendorId[] = [
      'anthropic',
      'openai',
      'deepseek',
      'moonshot',
      'doubao',
      'minimax',
      'xiaomi',
    ]
    for (const id of named) expect(VENDOR_IDS).toContain(id)
  })
})

describe('normalizeModelVendor', () => {
  it.each(VENDOR_IDS)('认得 %s', (id) => {
    expect(normalizeModelVendor(id)).toBe(id)
  })

  // 未知 id 不是错误:更新版 c3 写下的 vendor、手改的配置,都只是「没有内置建议」。
  it.each([undefined, null, '', '   ', 'not-a-vendor', 42, {}])(
    '未知取值 %p 退化为 custom',
    (raw) => {
      expect(normalizeModelVendor(raw)).toBe('custom')
    },
  )

  it('去首尾空白后再比对', () => {
    expect(normalizeModelVendor('  minimax  ')).toBe('minimax')
  })
})

describe('标签与模型清单', () => {
  it('未知取值也拿得到标签,不会是 undefined', () => {
    expect(modelVendorLabel('nope')).toBe(modelVendorLabel('custom'))
    expect(modelVendorLabel('moonshot')).toContain('Kimi')
    expect(modelVendorLabel('xiaomi')).toContain('MiMo')
  })

  it('所有条目都已去空白、非空、且组内不重复', () => {
    for (const v of VENDORS) {
      const ids = v.models.map((m) => m.id)
      for (const id of ids) {
        expect(id, `${v.id} 的模型 id 需去首尾空白`).toBe(id.trim())
        expect(id, `${v.id} 不应有空模型 id`).not.toBe('')
      }
      expect(new Set(ids).size, `${v.id} 的模型 id 重复了`).toBe(ids.length)
    }
  })

  it('内置条目不带能力元数据 —— 猜错窗口会引发上游截断,那是运维该填的', () => {
    for (const v of VENDORS) {
      for (const m of v.models) {
        expect(m.contextWindow).toBeUndefined()
        expect(m.maxOutputTokens).toBeUndefined()
      }
    }
  })

  it.each(['anthropic', 'openai', 'deepseek', 'moonshot', 'doubao', 'minimax', 'xiaomi'])(
    '%s 有非空的内置模型',
    (vendor) => {
      expect(modelVendorModels(vendor).length).toBeGreaterThan(0)
    },
  )

  // 聚合网关与本地运行时故意留空:前者转发别家成百上千个 id,后者只有运维自己拉了什么。
  it.each(['openrouter', 'litellm', 'ollama', 'lmstudio', 'custom'])('%s 的内置清单为空', (v) => {
    expect(modelVendorModels(v)).toEqual([])
  })

  it('未知 vendor 查不到内置模型,但不抛错', () => {
    expect(modelVendorModels('not-a-vendor')).toEqual([])
    expect(modelVendorModels(undefined)).toEqual([])
  })
})
