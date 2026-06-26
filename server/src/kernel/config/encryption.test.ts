import { describe, expect, it } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  encryptAgentApiKeys,
  decryptAgentApiKeys,
} from './encryption.js'
import type { SystemSettings } from '@ccc/shared/protocol'

describe('encryptSecret / decryptSecret round-trip', () => {
  it('round-trips an arbitrary non-empty plaintext', () => {
    const plain = 'sk-abc123-XYZ_/+=.~'
    const enc = encryptSecret(plain)
    expect(enc.startsWith('c3secretv1:')).toBe(true)
    expect(enc).not.toContain(plain)
    // The body after the prefix is decodable base64url.
    const body = enc.slice('c3secretv1:'.length)
    expect(Buffer.from(body, 'base64url').length).toBeGreaterThan(12 + 16)
    expect(decryptSecret(enc)).toBe(plain)
  })

  it('round-trips unicode and long secrets', () => {
    const plain = '密钥-🔐-' + 'a'.repeat(500)
    expect(decryptSecret(encryptSecret(plain))).toBe(plain)
  })
})

describe('random IV', () => {
  it('produces different ciphertext for the same plaintext, both decrypt back', () => {
    const plain = 'same-key'
    const a = encryptSecret(plain)
    const b = encryptSecret(plain)
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe(plain)
    expect(decryptSecret(b)).toBe(plain)
  })
})

describe('legacy plaintext passthrough', () => {
  it('returns a non-prefixed value verbatim', () => {
    expect(decryptSecret('sk-abc123')).toBe('sk-abc123')
  })
  it('returns empty string verbatim', () => {
    expect(decryptSecret('')).toBe('')
  })
})

describe('empty string', () => {
  it('encryptSecret("") returns "" with no prefix', () => {
    expect(encryptSecret('')).toBe('')
  })
})

describe('authentication failure', () => {
  it('throws when the ciphertext body is tampered', () => {
    const enc = encryptSecret('top-secret')
    const prefix = 'c3secretv1:'
    const body = Buffer.from(enc.slice(prefix.length), 'base64url')
    // Flip a byte in the ciphertext region (after the 12-byte IV).
    body[13] = body[13] ^ 0xff
    const tampered = prefix + body.toString('base64url')
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('throws when the auth tag is tampered', () => {
    const enc = encryptSecret('top-secret')
    const prefix = 'c3secretv1:'
    const body = Buffer.from(enc.slice(prefix.length), 'base64url')
    body[body.length - 1] = body[body.length - 1] ^ 0xff
    const tampered = prefix + body.toString('base64url')
    expect(() => decryptSecret(tampered)).toThrow()
  })
})

describe('unknown / malformed version', () => {
  it('throws on an unknown version prefix (never treats it as plaintext)', () => {
    const enc = encryptSecret('x')
    const v2 = 'c3secretv2:' + enc.slice('c3secretv1:'.length)
    expect(() => decryptSecret(v2)).toThrow(/unknown c3secret key version/)
  })
  it('throws on a c3secret prefix without a version separator', () => {
    expect(() => decryptSecret('c3secretno-colon')).toThrow(/missing version separator/)
  })
})

describe('encryptAgentApiKeys / decryptAgentApiKeys', () => {
  function settings(claudeKey: string, codexKey: string): SystemSettings {
    return {
      agents: [
        {
          id: 'c',
          vendor: 'claude',
          configMode: 'custom',
          displayName: 'C',
          enabled: true,
          icon: '',
          config: { baseUrl: '', apiKey: claudeKey, model: '' },
        },
        {
          id: 'x',
          vendor: 'codex',
          configMode: 'custom',
          displayName: 'X',
          enabled: true,
          icon: '',
          config: { baseUrl: '', apiKey: codexKey, model: '', wireApi: 'chat' },
        },
      ],
      defaultAgentId: 'c',
      toolAgentId: '',
      intentAgentId: '',
      specAgentId: '',
    } as SystemSettings
  }

  it('encrypts non-empty apiKeys for both vendors without mutating the input', () => {
    const input = settings('sk-claude', 'sk-codex')
    const out = encryptAgentApiKeys(input)
    expect(input.agents[0].config.apiKey).toBe('sk-claude') // input untouched
    expect(out.agents[0].config.apiKey.startsWith('c3secretv1:')).toBe(true)
    expect(out.agents[1].config.apiKey.startsWith('c3secretv1:')).toBe(true)
    // decryptAgentApiKeys reverses it in place.
    decryptAgentApiKeys(out)
    expect(out.agents[0].config.apiKey).toBe('sk-claude')
    expect(out.agents[1].config.apiKey).toBe('sk-codex')
  })

  it('leaves empty apiKeys (system mode) unencrypted', () => {
    const out = encryptAgentApiKeys(settings('', ''))
    expect(out.agents[0].config.apiKey).toBe('')
    expect(out.agents[1].config.apiKey).toBe('')
  })

  it('decrypts legacy-flat plaintext records (apiKey at top level) untouched', () => {
    const raw = {
      agents: [{ id: 'a1', name: 'One', baseUrl: '', apiKey: 'sk-legacy', model: '' }],
    } as unknown as Partial<SystemSettings>
    decryptAgentApiKeys(raw)
    expect((raw.agents as unknown as Array<{ apiKey: string }>)[0].apiKey).toBe('sk-legacy')
  })
})
