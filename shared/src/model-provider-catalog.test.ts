/**
 * The provider directory: Provider Vendor identity, the model ids c3 ships per vendor, and
 * the merge that turns a provider into the suggestions the agent form offers.
 *
 * What is guarded here is that the directory stays a well-formed suggestion source — every
 * template resolves to a real vendor, no shipped id is blank or duplicated, and an id c3
 * does not know degrades to `custom` instead of throwing. The endpoints and model ids
 * themselves are release-maintenance facts, not properties a test can assert.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderVendorId } from './model-provider-catalog.js'
import {
  PROVIDER_TEMPLATES,
  PROVIDER_VENDORS,
  PROVIDER_VENDOR_MODELS,
  effectiveProviderModels,
  findProviderTemplate,
  normalizeProviderVendor,
  providerVendorForTemplate,
  providerVendorLabel,
  providerVendorModels,
} from './model-provider-catalog.js'

const VENDOR_IDS = PROVIDER_VENDORS.map((v) => v.id)

describe('Provider Vendor 目录', () => {
  it('每个 vendor id 都唯一,且都有非空标签', () => {
    expect(new Set(VENDOR_IDS).size).toBe(VENDOR_IDS.length)
    for (const v of PROVIDER_VENDORS) expect(v.displayName.trim()).not.toBe('')
  })

  it.each(VENDOR_IDS)('归一化认得 %s', (id) => {
    expect(normalizeProviderVendor(id)).toBe(id)
  })

  // 未知 id 不是错误:更新版 c3 写下的 vendor、手改的配置,都只是「没有内置建议」。
  it.each([undefined, null, '', '   ', 'gemini', 42, {}])('未知取值 %p 退化为 custom', (raw) => {
    expect(normalizeProviderVendor(raw)).toBe('custom')
  })

  it('标签查询对未知取值也返回 custom 的标签,不会是 undefined', () => {
    expect(providerVendorLabel('nope')).toBe(providerVendorLabel('custom'))
    expect(providerVendorLabel('moonshot')).toContain('Kimi')
  })
})

describe('模板与 vendor 的对应', () => {
  it('每个模板都指向一个真实存在的 vendor', () => {
    for (const tpl of PROVIDER_TEMPLATES) {
      expect(VENDOR_IDS).toContain(tpl.vendor)
      expect(providerVendorForTemplate(tpl.id)).toBe(tpl.vendor)
    }
  })

  it('空白 / 未知模板创建出来的 provider 身份是 custom', () => {
    expect(providerVendorForTemplate('')).toBe('custom')
    expect(providerVendorForTemplate(undefined)).toBe('custom')
    expect(providerVendorForTemplate('some-old-template')).toBe('custom')
  })

  it('Doubao(火山方舟)是一条完整的目录条目,而不只是一个选择器标签', () => {
    const tpl = findProviderTemplate('doubao')!
    expect(tpl).toMatchObject({
      id: 'doubao',
      vendor: 'doubao',
      displayName: 'Doubao (Volcengine Ark)',
      urls: { openai: 'https://ark.cn-beijing.volces.com/api/v3' },
      wireApi: 'responses',
      docs: 'https://www.volcengine.com/docs/82379/1795150',
    })
    // 通用 Ark 预设不预填 Anthropic 端点 —— Coding Plan 之类的产品端点语义不同,手工配置。
    expect(tpl.urls.anthropic).toBeUndefined()
    expect(providerVendorModels('doubao').length).toBeGreaterThan(0)
  })
})

describe('内置模型清单', () => {
  const named: ProviderVendorId[] = ['moonshot', 'doubao', 'deepseek', 'openai', 'anthropic']

  it.each(named)('%s 有非空的内置模型', (vendor) => {
    expect(providerVendorModels(vendor).length).toBeGreaterThan(0)
  })

  it('所有 vendor 的条目都已去空白、非空、且组内不重复', () => {
    for (const vendor of VENDOR_IDS) {
      const ids = PROVIDER_VENDOR_MODELS[vendor].map((m) => m.id)
      for (const id of ids) {
        expect(id).toBe(id.trim())
        expect(id).not.toBe('')
      }
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('未知 vendor 查不到内置模型,但不抛错', () => {
    expect(providerVendorModels('gemini')).toEqual([])
    expect(providerVendorModels(undefined)).toEqual([])
  })
})

describe('effectiveProviderModels(有效模型清单)', () => {
  it('只有内置:清单就是该 vendor 的内置模型', () => {
    expect(effectiveProviderModels({ vendor: 'deepseek' }).map((m) => m.id)).toEqual(
      providerVendorModels('deepseek').map((m) => m.id),
    )
  })

  it('只有自定义:custom vendor 下清单就是 provider 自己的条目', () => {
    const models = effectiveProviderModels({ vendor: 'custom', models: [{ id: 'my-model' }] })
    expect(models).toEqual([{ id: 'my-model' }])
  })

  it('同名条目只出现一次,且以持久化条目为准(保住用户填的能力元数据)', () => {
    const shipped = providerVendorModels('deepseek')[0].id
    const models = effectiveProviderModels({
      vendor: 'deepseek',
      models: [{ id: shipped, contextWindow: 4096 }],
    })
    expect(models.filter((m) => m.id === shipped)).toEqual([{ id: shipped, contextWindow: 4096 }])
  })

  it('空 id 与纯空白 id 被丢弃,其余条目去首尾空白', () => {
    const models = effectiveProviderModels({
      vendor: 'custom',
      models: [{ id: '' }, { id: '   ' }, { id: '  spaced  ' }],
    })
    expect(models).toEqual([{ id: 'spaced' }])
  })

  it('顺序确定:内置在前、自定义在后,重名留在内置的位置上', () => {
    const shipped = providerVendorModels('anthropic').map((m) => m.id)
    const models = effectiveProviderModels({
      vendor: 'anthropic',
      models: [{ id: 'zzz-custom' }, { id: shipped[1] }],
    })
    expect(models.map((m) => m.id)).toEqual([...shipped, 'zzz-custom'])
  })

  it('换 vendor 只换内置那一半,自定义条目原样留下', () => {
    const own = [{ id: 'house-model' }]
    const before = effectiveProviderModels({ vendor: 'anthropic', models: own })
    const after = effectiveProviderModels({ vendor: 'moonshot', models: own })
    expect(before.map((m) => m.id)).toContain('house-model')
    expect(after.map((m) => m.id)).toContain('house-model')
    expect(after.map((m) => m.id)).toEqual([
      ...providerVendorModels('moonshot').map((m) => m.id),
      'house-model',
    ])
  })

  it('两条 provider 互不干扰,且都改不动内置常量', () => {
    const a = effectiveProviderModels({ vendor: 'zhipu', models: [{ id: 'only-a' }] })
    const b = effectiveProviderModels({ vendor: 'zhipu' })
    a[0].contextWindow = 999
    expect(b.map((m) => m.id)).not.toContain('only-a')
    expect(PROVIDER_VENDOR_MODELS.zhipu[0].contextWindow).toBeUndefined()
  })

  it('vendor 缺失或未知时,只剩自定义条目 —— 不是错误', () => {
    expect(effectiveProviderModels({ models: [{ id: 'x' }] })).toEqual([{ id: 'x' }])
    expect(effectiveProviderModels({})).toEqual([])
  })
})
