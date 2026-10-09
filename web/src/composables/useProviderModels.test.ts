/**
 * The front end's single entry to a provider's model list.
 *
 * What is guarded here: the shipped directory answers until (and when nothing else can) the
 * server does; the server's answer REPLACES the upstream half while the provider's own
 * entries still win where they collide; and one provider is asked for once — not on every
 * render, and not twice for two components looking at the same provider. A fresh non-empty
 * answer is what "asked for once" means: an empty or expired one is asked again (the first
 * is a provider whose key was just filled in, the second is a background refresh to collect).
 * Nothing is asked at all while this connection is not the administrator, and an in-flight
 * read has a way to end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, type EffectScope } from 'vue'
import type { ClientToServer, ModelProvider } from '@ccc/shared/protocol'
import { useAuth } from '@/composables/useAuth'
import {
  applyProviderModelsResult,
  bindProviderModelsSender,
  dropPendingProviderModels,
  resetProviderModelsForTests,
  useProviderModelCatalog,
  useProviderModels,
  type ProviderModelsHandle,
  type ProviderModelsResult,
} from './useProviderModels'

function provider(over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'p1',
    displayName: 'Kimi',
    vendor: 'moonshot',
    apiKey: 'sk-k',
    urls: { anthropic: 'https://api.moonshot.cn/anthropic' },
    ...over,
  }
}

/** A bound sender that records every frame the composable asks for. */
function bind(): ClientToServer[] {
  const sent: ClientToServer[] = []
  bindProviderModelsSender((msg) => sent.push(msg))
  return sent
}

function answer(over: Partial<ProviderModelsResult> = {}): ProviderModelsResult {
  return {
    type: 'provider_models_result',
    providerId: 'p1',
    models: [],
    fromCache: false,
    stale: true,
    ...over,
  }
}

/**
 * Mount-like scope: the composable registers an effect, so it needs one. Kept around to be
 * STOPPED after each test — a live scope from an earlier test would re-run on the next
 * binding of the sender and ask on behalf of a provider this test never mentioned.
 */
const scopes: EffectScope[] = []
function mount(providerRef: ModelProvider | null): ProviderModelsHandle {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useProviderModels(() => providerRef))!
}

const { setIsAdmin } = useAuth()

beforeEach(() => {
  resetProviderModelsForTests()
})

// 管理员判定是模块级共享状态:用例改了它,必须还原,否则污染同文件后面的用例。
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  setIsAdmin(true)
})

describe('useProviderModels(单条 provider 的有效清单)', () => {
  it('没有可用答案时清单来自随版本内置的目录 —— 离线/未保存也照样有候选', () => {
    const handle = mount(provider())
    expect(handle.upstream.value.map((m) => m.id)).toContain('kimi-k3')
    expect(handle.models.value.map((m) => m.id)).toContain('kimi-k3')
    expect(handle.loading.value).toBe(false)
    expect(handle.stale.value).toBe(false)
  })

  it('服务端答案替换上游那一半,provider 自填条目仍优先生效', async () => {
    const sent = bind()
    const subject = provider({ models: [{ id: 'b', contextWindow: 4096 }] })
    const handle = mount(subject)
    expect(sent).toEqual([{ type: 'fetch_provider_models', providerId: 'p1' }])
    expect(handle.loading.value).toBe(true)

    applyProviderModelsResult(
      answer({ models: [{ id: 'a' }, { id: 'b' }], fromCache: true, stale: false }),
    )
    await nextTick()

    expect(handle.loading.value).toBe(false)
    expect(handle.stale.value).toBe(false)
    expect(handle.upstream.value.map((m) => m.id)).toEqual(['a', 'b'])
    // 自填条目盖掉同名上游条目,并保住用户填的能力元数据;内置目录不再参与。
    expect(handle.models.value).toEqual([{ id: 'a' }, { id: 'b', contextWindow: 4096 }])
    expect(handle.models.value.map((m) => m.id)).not.toContain('kimi-k3')
  })

  it('空答案(服务端还不认识这条 provider)不清空兜底目录', async () => {
    bind()
    const handle = mount(provider())
    applyProviderModelsResult(answer({ models: [] }))
    await nextTick()
    expect(handle.upstream.value.map((m) => m.id)).toContain('kimi-k3')
  })

  it('过期答案如实标注 stale,refresh 会丢掉它重问一次', async () => {
    const sent = bind()
    const handle = mount(provider())
    applyProviderModelsResult(answer({ models: [{ id: 'a' }], fromCache: true, stale: true }))
    await nextTick()
    expect(handle.stale.value).toBe(true)

    handle.refresh()
    expect(sent).toHaveLength(2)
    expect(handle.loading.value).toBe(true)
    applyProviderModelsResult(answer({ models: [{ id: 'b' }], fromCache: true, stale: false }))
    await nextTick()
    expect(handle.upstream.value.map((m) => m.id)).toEqual(['b'])
  })

  it('没有绑定发送器时一个消息都不发 —— 直接挂组件的单测照旧', () => {
    const sent = bind()
    resetProviderModelsForTests()
    mount(provider())
    expect(sent).toHaveLength(0)
  })
})

describe('非管理员一个消息都不发', () => {
  it('挂载与显式重问都不发 —— 发了也只会被服务端拒答', () => {
    const sent = bind()
    setIsAdmin(false)
    const handle = mount(provider())
    handle.refresh()
    expect(sent).toHaveLength(0)
    expect(handle.loading.value).toBe(false)
  })

  it('本连接被认成管理员后,还挂着的面板会自己补问一轮', async () => {
    const sent = bind()
    setIsAdmin(false)
    mount(provider())
    expect(sent).toHaveLength(0)

    setIsAdmin(true)
    await nextTick()
    expect(sent).toEqual([{ type: 'fetch_provider_models', providerId: 'p1' }])
  })
})

describe('什么时候该重问', () => {
  it('过期答案在下一次索取时重问一次 —— 后台刷新的结果才读得到', () => {
    const sent = bind()
    const catalog = useProviderModelCatalog()
    catalog.ensure([provider()])
    expect(sent).toHaveLength(1)
    applyProviderModelsResult(answer({ models: [{ id: 'a' }], fromCache: true, stale: true }))

    catalog.ensure([provider()])
    expect(sent).toHaveLength(2)
  })

  it('空答案在下一次索取时重问一次 —— 刚补好 key 的 provider 不必等刷新页面', () => {
    const sent = bind()
    const catalog = useProviderModelCatalog()
    catalog.ensure([provider()])
    applyProviderModelsResult(answer({ models: [], fromCache: false, stale: false }))

    catalog.ensure([provider()])
    expect(sent).toHaveLength(2)
  })

  it('空答案落地不会把索取它的 effect 拽进死循环', async () => {
    const sent = bind()
    mount(provider())
    applyProviderModelsResult(answer({ models: [], fromCache: false, stale: false }))
    await nextTick()
    await nextTick()
    expect(sent).toHaveLength(1)
  })
})

describe('在飞状态的生命周期', () => {
  it('无人应答时能显式解掉,↻ 不会永久禁用', () => {
    bind()
    const handle = mount(provider())
    expect(handle.loading.value).toBe(true)

    dropPendingProviderModels()
    expect(handle.loading.value).toBe(false)
  })

  it('换连接(重新绑定发送器)清掉在飞状态 —— 上一根 socket 不会再有回包', () => {
    bind()
    const handle = mount(provider())
    expect(handle.loading.value).toBe(true)

    bind()
    expect(handle.loading.value).toBe(false)
  })
})

describe('useProviderModelCatalog(候选池视图)', () => {
  it('接不了 provider 的 vendor 取同名厂商内置目录', () => {
    const catalog = useProviderModelCatalog()
    expect(catalog.shipped('cursor').map((m) => m.id)).toContain('composer-2.5')
    expect(catalog.shipped(undefined)).toEqual([])
  })

  it('同一 provider 只问一次,两个组件共用一份答案', async () => {
    const sent = bind()
    const catalog = useProviderModelCatalog()
    catalog.ensure([provider()])
    catalog.ensure([provider()])
    expect(sent).toHaveLength(1)

    applyProviderModelsResult(answer({ models: [{ id: 'a' }], fromCache: false, stale: false }))
    await nextTick()
    catalog.ensure([provider()])
    expect(sent).toHaveLength(1)
    expect(catalog.effective(provider()).map((m) => m.id)).toEqual(['a'])
    expect(catalog.stale('p1')).toBe(false)
    expect(catalog.loading('p1')).toBe(false)
  })

  it('一次 ensure 覆盖整个候选池,各自独立记账', () => {
    const sent = bind()
    const catalog = useProviderModelCatalog()
    catalog.ensure([provider(), provider({ id: 'p2', vendor: 'deepseek' })])
    expect(sent).toEqual([
      { type: 'fetch_provider_models', providerId: 'p1' },
      { type: 'fetch_provider_models', providerId: 'p2' },
    ])
    expect(catalog.loading('p2')).toBe(true)
  })

  it('没有 id 的草稿行既不发消息也不进缓存', () => {
    const sent = bind()
    const catalog = useProviderModelCatalog()
    catalog.ensure([provider({ id: '' })])
    expect(sent).toHaveLength(0)
  })
})
