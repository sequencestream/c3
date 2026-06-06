import { describe, expect, it } from 'vitest'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
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
    // The config sub-object is routed to the claude arm and preserved.
    expect(parsed?.config).toEqual({ baseUrl: 'https://x', apiKey: 'k', model: 'claude-opus-4' })
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
  it('rejects a vendor with no registered arm (codex / opencode have no adapter yet)', () => {
    for (const vendor of ['codex', 'opencode', 'bogus']) {
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

describe('claudeConfigSchema', () => {
  it('requires all three override fields as strings', () => {
    expect(claudeConfigSchema.safeParse({ baseUrl: '', apiKey: '', model: '' }).success).toBe(true)
    expect(claudeConfigSchema.safeParse({ baseUrl: '', apiKey: '' }).success).toBe(false)
  })
})
