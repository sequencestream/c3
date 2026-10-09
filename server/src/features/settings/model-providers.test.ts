/**
 * Model-provider probe and runtime model list: draft URLs must never carry stored keys, and
 * the list handler must answer from what the server resolved for the SAVED provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelProvider, ServerToClient, SystemSettings } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import type { Conn } from '../../transport/handler-registry.js'
import { resetProviderModelCacheForTests, writeProviderModelCache } from './provider-model-cache.js'

const h = vi.hoisted(() => ({
  providers: [] as ModelProvider[],
}))

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: (): SystemSettings =>
    ({
      agents: [],
      defaultAgentId: 'system',
      toolAgentId: '',
      intentAgentId: '',
      specAgentId: '',
      specReviewAgentId: '',
      automationAgentId: '',
      reviewAgentId: '',
      fixAgentId: '',
      workAgentId: '',
      modelProviders: h.providers,
    }) as SystemSettings,
}))

vi.mock('../auth/authz.js', () => ({
  requireAdmin: () => true,
}))

import { fetchProviderModelsHandler, probeModelProviderHandler } from './model-providers.js'

function conn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    conn: {
      send: (m) => sent.push(m),
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      authed: true,
      authToken: 'tok',
      subject: 'admin',
    },
    sent,
  }
}

describe('probeModelProviderHandler', () => {
  const realFetch = globalThis.fetch
  let capturedHeaders: Record<string, string> | undefined

  beforeEach(() => {
    h.providers = [
      {
        id: 'prov-1',
        displayName: 'Test',
        apiKey: 'stored-secret-key',
        urls: { openai: 'https://stored.example/v1' },
      },
    ]
    capturedHeaders = undefined
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const raw = init?.headers
      if (raw instanceof Headers) {
        capturedHeaders = Object.fromEntries(raw.entries())
      } else if (raw && typeof raw === 'object') {
        capturedHeaders = Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [k.toLowerCase(), String(v)]),
        )
      } else {
        capturedHeaders = {}
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('does not send stored apiKey when probing a draft baseUrl with empty apiKey', async () => {
    const { conn: c } = conn()
    await probeModelProviderHandler({} as never, c, {
      type: 'probe_model_provider',
      protocolType: 'openai',
      providerId: 'prov-1',
      baseUrl: 'https://attacker.example/',
      apiKey: '',
    })

    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders?.authorization).toBeUndefined()
    expect(capturedHeaders?.['x-api-key']).toBeUndefined()
  })

  it('sends draft apiKey with draft baseUrl', async () => {
    const { conn: c } = conn()
    await probeModelProviderHandler({} as never, c, {
      type: 'probe_model_provider',
      protocolType: 'openai',
      providerId: 'prov-1',
      baseUrl: 'https://draft.example/',
      apiKey: 'draft-key',
    })

    expect(capturedHeaders?.authorization).toBe('Bearer draft-key')
    expect(capturedHeaders?.['x-api-key']).toBe('draft-key')
  })

  it('sends stored apiKey when probing stored URL without draft baseUrl', async () => {
    const { conn: c } = conn()
    await probeModelProviderHandler({} as never, c, {
      type: 'probe_model_provider',
      protocolType: 'openai',
      providerId: 'prov-1',
    })

    expect(capturedHeaders?.authorization).toBe('Bearer stored-secret-key')
    expect(capturedHeaders?.['x-api-key']).toBe('stored-secret-key')
  })
})

describe('fetchProviderModelsHandler(运行时上游清单)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-provider-models-handler-'))
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    resetDbForTests()
    resetProviderModelCacheForTests()
  })

  afterEach(() => {
    resetDbForTests()
    resetProviderModelCacheForTests()
    delete process.env.C3_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('缓存命中的一条 provider 直接回缓存里的清单,并如实标注 fromCache/stale', async () => {
    writeProviderModelCache({
      providerId: 'prov-1',
      models: [{ id: 'cached-1' }, { id: 'cached-2' }],
      now: Date.now(),
      result: 'ok',
    })
    const { conn: c, sent } = conn()
    await fetchProviderModelsHandler({} as never, c, {
      type: 'fetch_provider_models',
      providerId: 'prov-1',
    })
    expect(sent).toEqual([
      {
        type: 'provider_models_result',
        providerId: 'prov-1',
        models: [{ id: 'cached-1' }, { id: 'cached-2' }],
        fromCache: true,
        stale: false,
      },
    ])
  })

  it('服务端还不认识的 provider 回空清单:界面按厂商目录兜底,而不是当作白名单', async () => {
    const { conn: c, sent } = conn()
    await fetchProviderModelsHandler({} as never, c, {
      type: 'fetch_provider_models',
      providerId: 'unsaved-draft',
    })
    expect(sent).toEqual([
      {
        type: 'provider_models_result',
        providerId: 'unsaved-draft',
        models: [],
        fromCache: false,
        stale: false,
      },
    ])
  })
})
