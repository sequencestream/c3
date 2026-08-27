import { describe, expect, it } from 'vitest'
import { SYSTEM_AGENT_ID, hasProviderConfig } from '@ccc/shared/protocol'
import { agentConfigSchema, claudeConfigSchema, parseAgentConfig } from './schema.js'

describe('agent-config schema — claude arm', () => {
  const validClaude = {
    id: 'a1',
    vendor: 'claude',
    configMode: 'custom',
    displayName: 'Agent One',
    config: { baseUrl: 'https://x', apiKey: 'k', model: 'claude-opus-4' },
  }

  it('accepts a well-formed claude agent and routes by vendor tag', () => {
    const parsed = parseAgentConfig(validClaude)
    expect(parsed).not.toBeNull()
    expect(parsed?.vendor).toBe('claude')
    // Leftover connection fields still parse; they are not a source (no providerId
    // ⇒ derived mode is system). Normalize lifts them later.
    expect(parsed?.config).toEqual({ baseUrl: 'https://x', apiKey: 'k', model: 'claude-opus-4' })
    expect(parsed?.configMode).toBe('system')
  })

  it('derives custom only when providerId is set', () => {
    const parsed = parseAgentConfig({ ...validClaude, providerId: 'mp-1' })
    expect(parsed?.configMode).toBe('custom')
    expect(parsed?.providerId).toBe('mp-1')
  })

  it('accepts the optional shell fields (enabled / icon)', () => {
    const parsed = parseAgentConfig({ ...validClaude, enabled: false, icon: '🦊' })
    expect(parsed?.enabled).toBe(false)
    expect(parsed?.icon).toBe('🦊')
  })

  it('accepts the empty-config system-mode shape', () => {
    const parsed = parseAgentConfig({
      id: SYSTEM_AGENT_ID,
      vendor: 'claude',
      configMode: 'system',
      displayName: 'System',
      config: { baseUrl: '', apiKey: '', model: '' },
    })
    expect(parsed?.id).toBe(SYSTEM_AGENT_ID)
    expect(parsed?.configMode).toBe('system')
  })

  it('rejects a record missing configMode (the migrate layer supplies it)', () => {
    const { configMode: _cm, ...noMode } = validClaude
    expect(parseAgentConfig(noMode)).toBeNull()
  })

  it('rejects a claude agent missing a config field', () => {
    // model absent ⇒ the claude arm fails ⇒ null (fail-soft, caller drops it).
    expect(parseAgentConfig({ ...validClaude, config: { baseUrl: '', apiKey: '' } })).toBeNull()
  })

  it('rejects a claude config whose field is the wrong type', () => {
    expect(
      parseAgentConfig({ ...validClaude, config: { baseUrl: 1, apiKey: 'k', model: 'm' } }),
    ).toBeNull()
  })

  it('rejects a record missing the discriminant (no vendor)', () => {
    const { vendor: _v, ...noVendor } = validClaude
    expect(parseAgentConfig(noVendor)).toBeNull()
  })

  it('rejects an agent whose displayName is missing', () => {
    const { displayName: _d, ...noName } = validClaude
    expect(parseAgentConfig(noName)).toBeNull()
  })
})

describe('agent-config schema — unknown vendors are the extension point', () => {
  it('rejects a vendor with no registered arm', () => {
    for (const vendor of ['bogus']) {
      expect(
        parseAgentConfig({ id: 'x', vendor, displayName: 'X', config: { foo: 'bar' } }),
      ).toBeNull()
    }
  })

  it('the discriminated union currently exposes exactly the claude arm', () => {
    // safeParse on a flat (un-migrated) legacy shape fails: it carries no vendor.
    const legacyFlat = { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' }
    expect(agentConfigSchema.safeParse(legacyFlat).success).toBe(false)
  })
})

describe('agent-config schema — codex arm wireApi (2026-06-12-006)', () => {
  const baseCodex = {
    id: 'cx1',
    vendor: 'codex' as const,
    configMode: 'custom' as const,
    displayName: 'Codex',
  }

  it('accepts an explicit wireApi (responses / chat) and routes by vendor tag', () => {
    for (const wireApi of ['responses', 'chat'] as const) {
      const parsed = parseAgentConfig({
        ...baseCodex,
        config: { baseUrl: 'https://x', apiKey: 'k', model: 'm', wireApi },
      })
      expect(parsed?.vendor).toBe('codex')
      expect(parsed?.vendor === 'codex' && parsed.config.wireApi).toBe(wireApi)
    }
  })

  it('migrates a legacy codex config without wireApi to the chat default (relay path)', () => {
    const parsed = parseAgentConfig({
      ...baseCodex,
      config: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk', model: 'deepseek-chat' },
    })
    // Default `chat` ⇒ the pre-2026-06-12-006 third-party-via-relay behaviour is preserved.
    expect(parsed?.vendor === 'codex' && parsed.config.wireApi).toBe('chat')
  })

  it('rejects an out-of-range wireApi value', () => {
    expect(
      parseAgentConfig({
        ...baseCodex,
        config: { baseUrl: '', apiKey: '', model: '', wireApi: 'websocket' },
      }),
    ).toBeNull()
  })
})

describe('agent-config schema — codex capability fields (2026-08-08-013)', () => {
  const baseCodex = {
    id: 'cx-caps',
    vendor: 'codex' as const,
    configMode: 'custom' as const,
    displayName: 'Codex Caps',
  }

  it('accepts positive-integer contextWindow / maxOutputTokens', () => {
    for (const [contextWindow, maxOutputTokens] of [
      [65536, 8192],
      [131072, undefined],
      [undefined, 4096],
    ] as const) {
      const parsed = parseAgentConfig({
        ...baseCodex,
        config: {
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk',
          model: 'deepseek-chat',
          wireApi: 'chat',
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        },
      })
      expect(parsed?.vendor).toBe('codex')
      expect(parsed?.vendor === 'codex' && parsed.config.contextWindow).toBe(contextWindow)
      expect(parsed?.vendor === 'codex' && parsed.config.maxOutputTokens).toBe(maxOutputTokens)
    }
  })

  it('legacy codex config without the capability fields parses with undefined', () => {
    const parsed = parseAgentConfig({
      ...baseCodex,
      config: { baseUrl: 'https://api.deepseek.com', apiKey: 'sk', model: 'deepseek-chat' },
    })
    expect(parsed?.vendor).toBe('codex')
    expect(parsed?.vendor === 'codex' && parsed.config.contextWindow).toBeUndefined()
    expect(parsed?.vendor === 'codex' && parsed.config.maxOutputTokens).toBeUndefined()
  })

  it('rejects 0 / negative / non-integer values (whole record fails, fail-soft)', () => {
    for (const bad of [0, -1, 0.5, 65536.5]) {
      expect(
        parseAgentConfig({
          ...baseCodex,
          config: {
            baseUrl: '',
            apiKey: '',
            model: 'deepseek-chat',
            wireApi: 'chat',
            contextWindow: bad,
          },
        }),
      ).toBeNull()
    }
  })
})

describe('claudeConfigSchema', () => {
  it('requires all three override fields as strings', () => {
    expect(claudeConfigSchema.safeParse({ baseUrl: '', apiKey: '', model: '' }).success).toBe(true)
    expect(claudeConfigSchema.safeParse({ baseUrl: '', apiKey: '' }).success).toBe(false)
  })
})

describe('schema — system mode + model round-trip (2026-07-02-001)', () => {
  it('parseAgentConfig preserves config.model in system mode', () => {
    const parsed = parseAgentConfig({
      id: 'sys-with-model',
      vendor: 'claude',
      configMode: 'system',
      displayName: 'Sys With Model',
      config: { baseUrl: '', apiKey: '', model: 'claude-sonnet-5' },
    })
    expect(parsed && hasProviderConfig(parsed) && parsed.config.model).toBe('claude-sonnet-5')
    expect(parsed?.configMode).toBe('system')
  })

  it('parseAgentConfig preserves config.model in system mode for codex', () => {
    const parsed = parseAgentConfig({
      id: 'sys-codex-model',
      vendor: 'codex',
      configMode: 'system',
      displayName: 'Sys Codex Model',
      config: { baseUrl: '', apiKey: '', model: 'deepseek-chat', wireApi: 'chat' },
    })
    expect(parsed?.vendor === 'codex' && parsed.config.model).toBe('deepseek-chat')
    expect(parsed?.configMode).toBe('system')
  })
})
