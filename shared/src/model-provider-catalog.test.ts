/**
 * The provider directory: endpoint templates and the merge that turns a provider into the
 * model suggestions the agent form offers.
 *
 * What is guarded here is that every template is a usable starting point — it resolves to a
 * real Model Vendor, prefills only protocol slots whose dialect its endpoint speaks, and
 * passes the same base-URL check the console applies. The endpoints themselves are
 * release-maintenance facts, not properties a test can assert. Vendor identity and the model
 * catalogs are covered by `model-vendor-catalog.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { MODEL_VENDORS, modelVendorModels } from './model-vendor-catalog.js'
import {
  PROVIDER_TEMPLATES,
  checkProviderBaseUrl,
  effectiveProviderModels,
  findProviderTemplate,
  modelVendorForTemplate,
} from './model-provider-catalog.js'

const VENDOR_IDS = MODEL_VENDORS.map((v) => v.id)

describe('端点模板', () => {
  it('模板 id 唯一', () => {
    const ids = PROVIDER_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个模板都指向一个真实存在的 Model Vendor', () => {
    for (const tpl of PROVIDER_TEMPLATES) {
      expect(VENDOR_IDS, `模板 ${tpl.id} 的 vendor 不在目录里`).toContain(tpl.vendor)
      expect(modelVendorForTemplate(tpl.id)).toBe(tpl.vendor)
    }
  })

  it('每个模板至少预填一条协议 URL,且都通得过结构性检查', () => {
    for (const tpl of PROVIDER_TEMPLATES) {
      const urls = Object.values(tpl.urls)
      expect(urls.length, `模板 ${tpl.id} 没有任何端点`).toBeGreaterThan(0)
      for (const url of urls) {
        // 本地运行时走 http 回环,按规则只是 warning 而非 error。
        expect(checkProviderBaseUrl(url).severity, `模板 ${tpl.id} 的 ${url}`).not.toBe('error')
      }
    }
  })

  it('只有填了 openai 槽的模板才声明 wireApi', () => {
    for (const tpl of PROVIDER_TEMPLATES) {
      if (tpl.wireApi !== undefined) expect(tpl.urls.openai, `模板 ${tpl.id}`).toBeTruthy()
    }
  })

  it('空白 / 未知模板创建出来的 provider 身份是 custom', () => {
    expect(modelVendorForTemplate('')).toBe('custom')
    expect(modelVendorForTemplate(undefined)).toBe('custom')
    expect(modelVendorForTemplate('some-old-template')).toBe('custom')
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
    expect(modelVendorModels('doubao').length).toBeGreaterThan(0)
  })

  it('MiniMax 填的是 anthropic 槽 —— 它对外提供的是 Anthropic 兼容端点', () => {
    const tpl = findProviderTemplate('minimax')!
    expect(tpl.urls.anthropic).toBe('https://api.minimax.io/anthropic')
    expect(tpl.urls.openai).toBeUndefined()
    expect(tpl.wireApi).toBeUndefined()
  })
})

describe('effectiveProviderModels(有效模型清单)', () => {
  it('只有内置:清单就是该 vendor 的内置模型', () => {
    expect(effectiveProviderModels({ vendor: 'deepseek' }).map((m) => m.id)).toEqual(
      modelVendorModels('deepseek').map((m) => m.id),
    )
  })

  it('只有自定义:custom vendor 下清单就是 provider 自己的条目', () => {
    expect(effectiveProviderModels({ vendor: 'custom', models: [{ id: 'my-model' }] })).toEqual([
      { id: 'my-model' },
    ])
  })

  it('同名条目只出现一次,且以持久化条目为准(保住用户填的能力元数据)', () => {
    const shipped = modelVendorModels('deepseek')[0].id
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
    const shipped = modelVendorModels('anthropic').map((m) => m.id)
    const models = effectiveProviderModels({
      vendor: 'anthropic',
      models: [{ id: 'zzz-custom' }, { id: shipped[1] }],
    })
    expect(models.map((m) => m.id)).toEqual([...shipped, 'zzz-custom'])
  })

  it('换 vendor 只换内置那一半,自定义条目原样留下', () => {
    const own = [{ id: 'house-model' }]
    const before = effectiveProviderModels({ vendor: 'anthropic', models: own })
    const after = effectiveProviderModels({ vendor: 'minimax', models: own })
    expect(before.map((m) => m.id)).toContain('house-model')
    expect(after.map((m) => m.id)).toEqual([
      ...modelVendorModels('minimax').map((m) => m.id),
      'house-model',
    ])
  })

  it('两条 provider 互不干扰,且都改不动内置常量', () => {
    const a = effectiveProviderModels({ vendor: 'zhipu', models: [{ id: 'only-a' }] })
    const b = effectiveProviderModels({ vendor: 'zhipu' })
    a[0].contextWindow = 999
    expect(b.map((m) => m.id)).not.toContain('only-a')
    expect(modelVendorModels('zhipu')[0].contextWindow).toBeUndefined()
  })

  it('vendor 缺失或未知时,只剩自定义条目 —— 不是错误', () => {
    expect(effectiveProviderModels({ models: [{ id: 'x' }] })).toEqual([{ id: 'x' }])
    expect(effectiveProviderModels({})).toEqual([])
  })
})
