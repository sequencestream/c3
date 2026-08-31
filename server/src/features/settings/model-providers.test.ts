/**
 * Model-provider reachability probe: draft URLs must never carry stored keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelProvider, ServerToClient, SystemSettings } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

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
      modelProviders: h.providers,
    }) as SystemSettings,
}))

vi.mock('../auth/authz.js', () => ({
  requireAdmin: () => true,
}))

import { probeModelProviderHandler } from './model-providers.js'

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
