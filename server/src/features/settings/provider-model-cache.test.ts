/**
 * The runtime upstream model list: URL derivation, and the resolution order with its cache.
 *
 * The properties under test are the ones a settings page's correctness hangs off: a fresh
 * cache costs no upstream request at all; an expired one refreshes in the background without
 * the read waiting; a failure keeps the old list and does not become a retry loop; and with
 * nothing cached the shipped directory still answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelProvider } from '@ccc/shared/protocol'
import { modelVendorModels } from '@ccc/shared'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  MODEL_CACHE_TTL_MS,
  NEGATIVE_CACHE_TTL_MS,
  parseModelListResponse,
  providerModelListUrl,
  providerModelProtocol,
  readProviderModelCache,
  resetProviderModelCacheForTests,
  resolveProviderModels,
} from './provider-model-cache.js'

let dir: string
let clock = 1_000_000_000

function provider(over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'p1',
    displayName: 'Gateway',
    vendor: 'openai',
    apiKey: 'sk-secret',
    urls: { openai: 'https://gateway.example/v1' },
    ...over,
  }
}

/** A fetch that records every URL it was asked for and answers with a list. */
function listFetch(ids: readonly string[]) {
  const calls: string[] = []
  const impl = (async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })
  }) as unknown as typeof fetch
  return { impl, calls }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-provider-models-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetProviderModelCacheForTests()
  clock = 1_000_000_000
})

afterEach(() => {
  resetDbForTests()
  resetProviderModelCacheForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** The cache row as stored, straight from the table (not through the module's mapping). */
function rawRow(providerId: string) {
  return getDb()!.get<{
    models_json: string | null
    created_at: number
    updated_at: number
    cached_at: number | null
    last_fetched_at: number | null
    last_fetch_result: string
    last_fetch_error: string | null
  }>('SELECT * FROM provider_model_caches WHERE provider_id=?', providerId)
}

describe('providerModelListUrl(清单接口地址派生)', () => {
  const cases: Array<[string, 'openai' | 'anthropic', string]> = [
    ['https://api.openai.com/v1', 'openai', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1/', 'openai', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com', 'openai', 'https://api.openai.com/models'],
    ['https://gateway.example/v1/', 'openai', 'https://gateway.example/v1/models'],
    ['https://api.anthropic.com', 'anthropic', 'https://api.anthropic.com/v1/models'],
    ['https://api.anthropic.com/', 'anthropic', 'https://api.anthropic.com/v1/models'],
    // The version segment is not appended twice: the anthropic slot is served under /v1
    // whether or not the operator's base URL already ends in it.
    ['https://api.anthropic.com/v1', 'anthropic', 'https://api.anthropic.com/v1/models'],
    [
      'https://gateway.example/anthropic/v1/',
      'anthropic',
      'https://gateway.example/anthropic/v1/models',
    ],
  ]
  for (const [base, protocol, expected] of cases) {
    it(`${protocol} 槽:${base} ⇒ ${expected}`, () => {
      expect(providerModelListUrl(base, protocol)).toBe(expected)
    })
  }

  it('没有可用 base URL 时不派生 —— 与界面同一套结构检查', () => {
    expect(providerModelListUrl('', 'openai')).toBeNull()
    expect(providerModelListUrl('   ', 'openai')).toBeNull()
    expect(providerModelListUrl('not-a-url', 'openai')).toBeNull()
    expect(providerModelListUrl('ftp://gateway.example', 'openai')).toBeNull()
    expect(providerModelListUrl(undefined, 'anthropic')).toBeNull()
  })

  it('方言取第一个真正填了的槽,两个都没填就是没有', () => {
    expect(
      providerModelProtocol({ openai: 'https://a.example', anthropic: 'https://b.example' }),
    ).toBe('openai')
    expect(providerModelProtocol({ anthropic: 'https://b.example' })).toBe('anthropic')
    expect(providerModelProtocol({ openai: '' })).toBeNull()
    expect(providerModelProtocol({})).toBeNull()
  })
})

describe('parseModelListResponse(上游响应解析)', () => {
  it('只读标准的 data[].id,去空白、去重', () => {
    expect(
      parseModelListResponse({ data: [{ id: ' a ' }, { id: 'b' }, { id: 'a' }, { id: '  ' }] }),
    ).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('不认识的形状一律 null —— 视为抓取失败,而不是空清单', () => {
    expect(parseModelListResponse({ models: ['a'] })).toBeNull()
    expect(parseModelListResponse('<html>')).toBeNull()
    expect(parseModelListResponse({ data: 'nope' })).toBeNull()
    expect(parseModelListResponse(null)).toBeNull()
  })

  it('不读上游的能力元数据 —— 那些由用户声明', () => {
    expect(parseModelListResponse({ data: [{ id: 'x', context_window: 128000 }] })).toEqual([
      { id: 'x' },
    ])
  })
})

describe('resolveProviderModels(解析顺序)', () => {
  it('首次读取不阻塞抓取:先回写死的厂商目录,抓完后下一次读取就是抓取结果', async () => {
    const { impl, calls } = listFetch(['gpt-9', 'gpt-9-mini'])
    const first = resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock })

    // 还没抓到任何东西:这一读回答的是随版本内置的目录(offline 的起点),而不是空清单。
    expect(first.models.map((m) => m.id)).toEqual(modelVendorModels('openai').map((m) => m.id))
    expect(first.fromCache).toBe(false)
    expect(first.stale).toBe(true)
    expect(first.refresh).not.toBeNull()
    await first.refresh

    expect(calls).toEqual(['https://gateway.example/v1/models'])
    const row = rawRow('p1')
    expect(JSON.parse(row!.models_json!)).toEqual([{ id: 'gpt-9' }, { id: 'gpt-9-mini' }])
    expect(row!.created_at).toBe(clock)
    expect(row!.updated_at).toBe(clock)
    expect(row!.cached_at).toBe(clock)
    expect(row!.last_fetch_result).toBe('ok')

    clock += 1000
    const second = resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock })
    expect(second.models.map((m) => m.id)).toEqual(['gpt-9', 'gpt-9-mini'])
    expect(second.fromCache).toBe(true)
    expect(second.stale).toBe(false)
    expect(second.refresh).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('缓存没过期时读取不发上游请求', async () => {
    const { impl } = listFetch(['only'])
    await resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock }).refresh

    const { impl: counting, calls } = listFetch(['never'])
    clock += MODEL_CACHE_TTL_MS - 1
    const read = resolveProviderModels(provider(), { fetchImpl: counting, now: () => clock })
    expect(read.models.map((m) => m.id)).toEqual(['only'])
    expect(read.refresh).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('缓存超过 TTL:下一次读取起一次后台刷新并替换缓存,读取不被超时拖住', async () => {
    const { impl } = listFetch(['old'])
    await resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock }).refresh

    // 上游这次故意挂住:读取必须立刻拿到旧清单,刷新挂在超时上。
    let settle: ((r: Response) => void) | null = null
    const hanging = (() =>
      new Promise<Response>((resolve) => {
        settle = resolve
      })) as unknown as typeof fetch

    clock += MODEL_CACHE_TTL_MS + 1
    const read = resolveProviderModels(provider(), { fetchImpl: hanging, now: () => clock })
    expect(read.models.map((m) => m.id)).toEqual(['old'])
    expect(read.fromCache).toBe(true)
    expect(read.stale).toBe(true)
    expect(read.refresh).not.toBeNull()

    // 抓取还没结束:缓存原封不动,刷新依旧在飞。
    expect(rawRow('p1')!.models_json).toBe(JSON.stringify([{ id: 'old' }]))

    settle!(
      new Response(JSON.stringify({ data: [{ id: 'new-1' }, { id: 'new-2' }] }), { status: 200 }),
    )
    await read.refresh
    const next = resolveProviderModels(provider(), { fetchImpl: hanging, now: () => clock })
    expect(next.models.map((m) => m.id)).toEqual(['new-1', 'new-2'])
    expect(next.stale).toBe(false)
  })

  it('同一 provider 并发读取只发一次请求', async () => {
    const { impl, calls } = listFetch(['x'])
    const a = resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock })
    const b = resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock })
    await a.refresh
    await b.refresh
    expect(calls).toHaveLength(1)
  })

  it('刷新超时可注入:超时记为失败,读取仍立刻返回旧数据', async () => {
    const { impl } = listFetch(['cached'])
    await resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock }).refresh

    const aborting = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch

    clock += MODEL_CACHE_TTL_MS + 1
    const read = resolveProviderModels(provider(), {
      fetchImpl: aborting,
      now: () => clock,
      timeoutMs: 20,
    })
    expect(read.models.map((m) => m.id)).toEqual(['cached'])
    await read.refresh
    const row = rawRow('p1')
    expect(row!.models_json).toBe(JSON.stringify([{ id: 'cached' }]))
    expect(row!.last_fetch_result).toBe('failed')
    expect(row!.last_fetch_error).toBe('timeout after 20ms')
  })

  it('非 2xx / 解析失败都不清空旧缓存,且紧随其后的读取不再打上游', async () => {
    const { impl } = listFetch(['keep-me'])
    await resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock }).refresh

    for (const answer of [
      (() => Promise.resolve(new Response('denied', { status: 403 }))) as typeof fetch,
      (() => Promise.resolve(new Response('<html>', { status: 200 }))) as typeof fetch,
      // 2xx 但清单为空:宁可当失败,也不能用「没有模型」覆盖一份好清单。
      (() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
        )) as typeof fetch,
    ]) {
      clock += MODEL_CACHE_TTL_MS + 1
      const read = resolveProviderModels(provider(), { fetchImpl: answer, now: () => clock })
      await read.refresh
      expect(rawRow('p1')!.models_json).toBe(JSON.stringify([{ id: 'keep-me' }]))
      expect(rawRow('p1')!.last_fetch_result).toBe('failed')

      // 负缓存:紧随其后的读取(哪怕是另一次面板打开)不再撞坏端点。
      const { impl: counting, calls } = listFetch(['never'])
      clock += 1000
      const followUp = resolveProviderModels(provider(), { fetchImpl: counting, now: () => clock })
      expect(followUp.models.map((m) => m.id)).toEqual(['keep-me'])
      expect(followUp.fromCache).toBe(true)
      expect(followUp.refresh).toBeNull()
      expect(calls).toHaveLength(0)
      clock += NEGATIVE_CACHE_TTL_MS
    }
  })

  it('退避期满后重试一次,而不是永久放弃', async () => {
    const failing = (() => Promise.resolve(new Response('nope', { status: 500 }))) as typeof fetch
    await resolveProviderModels(provider(), { fetchImpl: failing, now: () => clock }).refresh

    clock += NEGATIVE_CACHE_TTL_MS + 1
    const { impl, calls } = listFetch(['recovered'])
    const read = resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock })
    expect(read.refresh).not.toBeNull()
    await read.refresh
    expect(calls).toHaveLength(1)
    expect(rawRow('p1')!.models_json).toBe(JSON.stringify([{ id: 'recovered' }]))
  })

  it('库里没有任何缓存且抓不到时,回落写死的厂商目录 —— 界面仍有候选', () => {
    const read = resolveProviderModels(provider({ vendor: 'moonshot', urls: {} }), {
      fetchImpl: (() => Promise.reject(new Error('must not be called'))) as typeof fetch,
      now: () => clock,
    })
    expect(read.models.map((m) => m.id)).toEqual(modelVendorModels('moonshot').map((m) => m.id))
    expect(read.fromCache).toBe(false)
    expect(read.stale).toBe(true)
    expect(read.refresh).toBeNull()
    expect(rawRow('p1')).toBeUndefined()
  })

  it('没有 key 拨不出去:不发请求、不写失败行,清单仍从厂商目录来', () => {
    const fetchImpl = vi.fn()
    const read = resolveProviderModels(provider({ apiKey: '' }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(read.models.length).toBeGreaterThan(0)
    expect(read.refresh).toBeNull()
    expect(rawRow('p1')).toBeUndefined()
  })

  it('成功抓取后失败的尝试不动 created_at,只前移 updated_at', async () => {
    const { impl } = listFetch(['a'])
    await resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock }).refresh
    const created = rawRow('p1')!.created_at

    clock += MODEL_CACHE_TTL_MS + 1
    const failing = (() => Promise.resolve(new Response('no', { status: 502 }))) as typeof fetch
    await resolveProviderModels(provider(), { fetchImpl: failing, now: () => clock }).refresh

    const row = rawRow('p1')!
    expect(row.created_at).toBe(created)
    expect(row.updated_at).toBe(clock)
    expect(row.cached_at).toBe(created)
    expect(row.last_fetched_at).toBe(clock)
  })

  it('缓存的读回与写入闭环:读到的行与解析顺序一致', async () => {
    const { impl } = listFetch(['a', 'b'])
    expect(readProviderModelCache('p1')).toBeNull()
    await resolveProviderModels(provider(), { fetchImpl: impl, now: () => clock }).refresh
    const row = readProviderModelCache('p1')!
    expect(row.models).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(row.lastFetchResult).toBe('ok')
    expect(row.lastFetchError).toBeNull()
  })
})
