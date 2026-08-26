import { describe, expect, it, vi } from 'vitest'
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
