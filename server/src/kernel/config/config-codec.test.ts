/**
 * Codec tests: the object ⇄ rows mapping that every settings read and write goes
 * through. Covers the four expansion shapes (scalar / nested object / record array /
 * JSON leaf), secret round-trips, order preservation, dotted segments, and the
 * fail-soft decoding a settings load depends on.
 */
import { describe, expect, it } from 'vitest'
import { fromEntries, toEntries, type ConfigEntry } from './config-codec.js'
import { SYSTEM_RULES, WORKSPACE_RULES } from './config-schema.js'

function byKey(entries: readonly ConfigEntry[]): Record<string, ConfigEntry> {
  return Object.fromEntries(entries.map((e) => [e.key, e]))
}

describe('toEntries', () => {
  it('expands scalars and nested objects into one row per field', () => {
    const rows = byKey(
      toEntries({ timezone: 'Asia/Shanghai', proxy: { enabled: true, httpProxy: '' } }),
    )
    expect(rows['timezone']).toEqual({ key: 'timezone', value: 'Asia/Shanghai', type: 'string' })
    expect(rows['proxy.enabled']).toEqual({ key: 'proxy.enabled', value: 'true', type: 'boolean' })
    expect(rows['proxy.httpProxy']).toEqual({ key: 'proxy.httpProxy', value: '', type: 'string' })
    expect(rows['proxy']).toBeUndefined()
  })

  it('skips undefined but keeps null and empty objects as values', () => {
    const rows = byKey(toEntries({ a: undefined, b: null, c: {} }))
    expect(rows['a']).toBeUndefined()
    expect(rows['b']).toEqual({ key: 'b', value: null, type: 'json' })
    expect(rows['c']).toEqual({ key: 'c', value: '{}', type: 'json' })
  })

  it('expands a record array per id and records its order', () => {
    const rows = byKey(
      toEntries(
        {
          agents: [
            { id: 'sys', vendor: 'claude' },
            { id: 'x', vendor: 'codex' },
          ],
        },
        SYSTEM_RULES,
      ),
    )
    expect(rows['agents.sys.vendor'].value).toBe('claude')
    expect(rows['agents.x.vendor'].value).toBe('codex')
    expect(rows['agents._order'].value).toBe('["sys","x"]')
  })

  it('stores a scalar array as a single json row', () => {
    const rows = byKey(toEntries({ degradationChain: ['a', 'b'] }, SYSTEM_RULES))
    expect(rows['degradationChain']).toEqual({
      key: 'degradationChain',
      value: '["a","b"]',
      type: 'json',
    })
  })

  it('encrypts a declared secret and never stores it in plaintext', () => {
    const rows = byKey(
      toEntries({ agents: [{ id: 'a', config: { apiKey: 'sk-live-1' } }] }, SYSTEM_RULES),
    )
    const row = rows['agents.a.config.apiKey']
    expect(row.type).toBe('secret')
    expect(row.value).toMatch(/^c3secretv1:/)
    expect(row.value).not.toContain('sk-live-1')
  })

  it('escapes dots inside an id segment', () => {
    const rows = toEntries(
      { auth: { provider: { accounts: [{ username: 'a.b@x.com', passwordHash: 'h' }] } } },
      SYSTEM_RULES,
    )
    expect(rows.some((r) => r.key === 'auth.provider.accounts.a%2Eb@x%2Ecom.username')).toBe(true)
  })
})

describe('fromEntries', () => {
  it('round-trips a system-settings-shaped object', () => {
    const original = {
      agents: [
        { id: 'sys', vendor: 'claude', enabled: true, config: { apiKey: 'sk-1', model: 'm' } },
        { id: 'two', vendor: 'codex', enabled: false, config: { apiKey: '', model: '' } },
      ],
      defaultAgentId: 'sys',
      timezone: 'Asia/Shanghai',
      showToolSessions: false,
      degradationChain: ['sys', 'two'],
      proxy: { enabled: true, httpProxy: 'http://p:3128', httpsProxy: '' },
      vendorCliVersions: { claude: '1.2.3' },
    }
    expect(fromEntries(toEntries(original, SYSTEM_RULES), SYSTEM_RULES)).toEqual(original)
  })

  it('round-trips accounts whose username contains a dot', () => {
    const original = {
      auth: {
        enabled: true,
        provider: {
          kind: 'basic',
          accounts: [{ username: 'a.b@x.com', passwordHash: 'scrypt$1' }],
          adminUsername: 'a.b@x.com',
        },
      },
    }
    expect(fromEntries(toEntries(original, SYSTEM_RULES), SYSTEM_RULES)).toEqual(original)
  })

  it('round-trips a workspace setting including its json leaves', () => {
    const original = {
      defaultMode: { claude: 'plan', codex: { sandboxMode: 'read-only', approvalPolicy: 'never' } },
      consensus: { enabled: true, majority: false, mode: 'custom', agentIds: ['a', 'b'] },
      sddEnabled: true,
      maxRoundsPerStage: 12,
      skillRepos: [{ id: 'r1', repo: 'https://x/y', ref: 'main' }],
      sandbox: { enabled: true, extraMounts: [{ path: '/a/b', readonly: false }] },
    }
    expect(fromEntries(toEntries(original, WORKSPACE_RULES), WORKSPACE_RULES)).toEqual(original)
  })

  it('restores record-array order from the order row, not from row order', () => {
    const entries = [
      { key: 'agents.b.vendor', value: 'codex', type: 'string' as const },
      { key: 'agents.a.vendor', value: 'claude', type: 'string' as const },
      { key: 'agents._order', value: '["a","b"]', type: 'json' as const },
    ]
    const out = fromEntries(entries, SYSTEM_RULES) as { agents: { vendor: string }[] }
    expect(out.agents.map((a) => a.vendor)).toEqual(['claude', 'codex'])
  })

  it('appends records missing from the order row instead of dropping them', () => {
    const entries = [
      { key: 'agents.a.vendor', value: 'claude', type: 'string' as const },
      { key: 'agents.z.vendor', value: 'cursor', type: 'string' as const },
      { key: 'agents._order', value: '["a"]', type: 'json' as const },
    ]
    const out = fromEntries(entries, SYSTEM_RULES) as { agents: { vendor: string }[] }
    expect(out.agents.map((a) => a.vendor)).toEqual(['claude', 'cursor'])
  })

  it('skips rows it cannot decode instead of failing the whole load', () => {
    const entries: ConfigEntry[] = [
      { key: 'timezone', value: 'Asia/Shanghai', type: 'string' },
      { key: 'broken', value: '{not json', type: 'json' },
      { key: 'secretish', value: 'c3secretv9:zzz', type: 'secret' },
      { key: 'nan', value: 'abc', type: 'number' },
    ]
    expect(fromEntries(entries)).toEqual({ timezone: 'Asia/Shanghai' })
  })
})
