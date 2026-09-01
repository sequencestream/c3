import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_TEMPLATES, PROVIDER_VENDORS } from '@ccc/shared'
import { parseModelProvider } from './model-provider-schema.js'

describe('parseModelProvider', () => {
  it('keeps protocol-keyed urls', () => {
    const p = parseModelProvider({
      id: 'p1',
      displayName: ' DeepSeek ',
      apiKey: 'sk',
      urls: {
        openai: ' https://api.deepseek.com ',
        anthropic: 'https://api.deepseek.com/anthropic',
        bogus: 'https://x.example',
      },
      wireApi: 'chat',
    })
    expect(p).toMatchObject({
      id: 'p1',
      displayName: 'DeepSeek',
      urls: {
        openai: 'https://api.deepseek.com',
        anthropic: 'https://api.deepseek.com/anthropic',
      },
      wireApi: 'chat',
    })
    expect(p?.urls).not.toHaveProperty('bogus')
  })

  it('folds legacy vendor connections into protocol urls', () => {
    const p = parseModelProvider({
      id: 'p1',
      displayName: 'Legacy',
      apiKey: '',
      connections: {
        claude: { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-claude' },
        codex: { baseUrl: 'https://api.deepseek.com', wireApi: 'chat' },
      },
    })
    expect(p).toMatchObject({
      apiKey: 'sk-claude',
      urls: {
        anthropic: 'https://api.deepseek.com/anthropic',
        openai: 'https://api.deepseek.com',
      },
      wireApi: 'chat',
    })
    expect(p).not.toHaveProperty('connections')
  })

  it('preserves an enabled protocol slot with an empty url', () => {
    const p = parseModelProvider({
      id: 'p1',
      displayName: 'Draft',
      apiKey: 'sk',
      urls: { openai: '' },
      wireApi: 'chat',
    })
    expect(p?.urls).toEqual({ openai: '' })
  })

  it('tolerates a cleared numeric model-catalog field instead of dropping the whole provider', () => {
    // `v-model.number` writes back '' when a number input is cleared (Vue's
    // looseToNumber leaves a non-numeric string alone) — the schema must accept
    // that shape rather than fail the whole provider on one blanked field.
    const p = parseModelProvider({
      id: 'p1',
      displayName: 'DeepSeek',
      apiKey: 'sk',
      urls: { openai: 'https://api.deepseek.com' },
      models: [{ id: 'gpt', contextWindow: '', maxOutputTokens: '' }],
    })
    expect(p).not.toBeNull()
    expect(p?.models).toEqual([{ id: 'gpt' }])
  })

  it.each(PROVIDER_VENDORS.map((v) => v.id))('round-trips the vendor id %s', (vendor) => {
    const p = parseModelProvider({ id: 'p1', displayName: 'X', apiKey: 'sk', urls: {}, vendor })
    expect(p?.vendor).toBe(vendor)
    // Re-parsing a normalized record changes nothing — the field is stable across saves.
    expect(parseModelProvider(p)?.vendor).toBe(vendor)
  })

  it.each(PROVIDER_TEMPLATES.map((t) => [t.id, t.vendor] as const))(
    'infers the vendor of template %s when none is stored',
    (template, vendor) => {
      const p = parseModelProvider({ id: 'p1', displayName: 'X', apiKey: 'sk', urls: {}, template })
      expect(p?.vendor).toBe(vendor)
    },
  )

  it.each([
    ['no template at all', {}],
    ['a blank template', { template: '  ' }],
    ['a template this build never shipped', { template: 'retired-preset' }],
    ['a blank vendor', { vendor: '' }],
    ['a vendor id from a newer c3', { vendor: 'some-future-vendor' }],
  ])('normalizes %s to custom', (_label, over) => {
    const p = parseModelProvider({ id: 'p1', displayName: 'X', apiKey: 'sk', urls: {}, ...over })
    expect(p?.vendor).toBe('custom')
  })

  it('a stored vendor wins over the template that created the record', () => {
    const p = parseModelProvider({
      id: 'p1',
      displayName: 'X',
      apiKey: 'sk',
      urls: {},
      template: 'anthropic',
      vendor: 'moonshot',
    })
    expect(p?.vendor).toBe('moonshot')
    expect(p?.template).toBe('anthropic')
  })

  // A vendor c3 cannot resolve must cost the provider its suggestions, nothing else: the
  // key, the endpoints and the operator's own model entries all survive intact.
  it('degrading an unknown vendor never touches the secret, urls or custom models', () => {
    const p = parseModelProvider({
      id: 'p1',
      displayName: 'House gateway',
      apiKey: 'sk-secret',
      urls: { openai: 'https://gw.example/v1' },
      wireApi: 'chat',
      models: [{ id: 'house-model', contextWindow: 4096 }],
      paused: true,
      vendor: 'not-a-vendor',
    })
    expect(p).toMatchObject({
      vendor: 'custom',
      apiKey: 'sk-secret',
      urls: { openai: 'https://gw.example/v1' },
      wireApi: 'chat',
      models: [{ id: 'house-model', contextWindow: 4096 }],
      paused: true,
    })
  })

  it('warns when legacy connections carry different apiKeys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    parseModelProvider({
      id: 'p1',
      displayName: 'Legacy',
      apiKey: 'sk-first',
      connections: {
        claude: { baseUrl: 'https://a.example', apiKey: 'sk-claude' },
        codex: { baseUrl: 'https://b.example', apiKey: 'sk-codex' },
      },
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('different apiKeys'))
    warn.mockRestore()
  })
})
