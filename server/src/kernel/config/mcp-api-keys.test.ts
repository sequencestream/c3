import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import {
  canonicalizeWorkspacePath,
  createMcpApiKey,
  listMcpApiKeys,
  parseMcpApiKey,
  renameMcpApiKey,
  revokeMcpApiKey,
  touchMcpApiKey,
  updateMcpApiKeyWorkspaces,
  verifyMcpApiKey,
} from './mcp-api-keys.js'
import { loadSettings, resetSettingsCacheForTests, saveSettings } from './index.js'
import { readJsonFile, writeAtomic } from './store.js'

// Redirect `~/.c3` to a throwaway dir (os.homedir() honours $HOME on POSIX) so
// these tests never touch the developer's real settings.json.
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-mcp-keys-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

function settingsPath(): string {
  return join(dir, '.c3', 'settings.json')
}

function diskRaw(): Record<string, unknown> {
  return readJsonFile<Record<string, unknown>>(settingsPath()) ?? {}
}

function diskRecords(): Record<string, unknown>[] {
  const raw = diskRaw().mcpApiKeys
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
}

/** A workspace directory that actually exists, so canonicalization has something to resolve. */
function makeWorkspace(name: string): string {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return canonicalizeWorkspacePath(p)!
}

describe('key format', () => {
  it('mints a c3k_<id>_<secret> key with a 256-bit secret and a matching display prefix', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', [ws], 1000)

    const parsed = parseMcpApiKey(key)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(meta.id)
    expect(key.startsWith(`${meta.displayPrefix}_`)).toBe(true)
    // base64url of 32 random bytes ⇒ 43 chars, i.e. ≥256 bit of entropy.
    expect(parsed!.secret).toHaveLength(43)
  })

  it('rejects malformed keys without touching storage', () => {
    expect(parseMcpApiKey('')).toBeNull()
    expect(parseMcpApiKey('nonsense')).toBeNull()
    expect(parseMcpApiKey('c3k_zzzz_abc')).toBeNull()
    expect(parseMcpApiKey('c3k_0123456789abcdef')).toBeNull()
  })

  it('produces a distinct id and secret on every mint', async () => {
    const ws = makeWorkspace('proj')
    const a = await createMcpApiKey('a', [ws], 1)
    const b = await createMcpApiKey('b', [ws], 2)
    expect(a.meta.id).not.toBe(b.meta.id)
    expect(a.key).not.toBe(b.key)
  })
})

describe('persistence', () => {
  it('stores only a salted scrypt hash — never the plaintext', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', [ws], 1000)

    const serialized = JSON.stringify(diskRaw())
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain(parseMcpApiKey(key)!.secret)

    const [rec] = diskRecords()
    expect(rec.algo).toBe('scrypt')
    expect(rec.hashVersion).toBe(1)
    expect(typeof rec.salt).toBe('string')
    expect(typeof rec.hash).toBe('string')
  })

  it('gives every key its own salt', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('a', [ws], 1)
    await createMcpApiKey('b', [ws], 2)
    const salts = diskRecords().map((r) => r.salt)
    expect(new Set(salts).size).toBe(2)
  })

  it('never returns hash material in the listing', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', [ws], 1000)
    const [meta] = listMcpApiKeys()
    expect(Object.keys(meta).sort()).toEqual([
      'createdAt',
      'displayPrefix',
      'id',
      'lastUsedAt',
      'name',
      'workspaces',
    ])
    expect(JSON.stringify(meta)).not.toContain('salt')
  })

  it('authenticates a key after a full reload from disk', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', [ws], 1000)
    resetSettingsCacheForTests()

    const auth = await verifyMcpApiKey(key)
    expect(auth).toEqual({ id: meta.id, workspaces: [ws] })
  })

  it('rejects a wrong secret under a real key id', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', [ws], 1000)
    const forged = `c3k_${meta.id}_${'A'.repeat(43)}`
    expect(forged).not.toBe(key)
    expect(await verifyMcpApiKey(forged)).toBeNull()
  })

  it('rejects an unknown key id', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', [ws], 1000)
    expect(await verifyMcpApiKey(`c3k_${'0'.repeat(16)}_${'A'.repeat(43)}`)).toBeNull()
  })

  it('rejects a record whose hash scheme is not supported, rather than failing open', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', [ws], 1000)
    const raw = diskRaw()
    const records = raw.mcpApiKeys as Record<string, unknown>[]
    records[0].hashVersion = 99
    writeAtomic(settingsPath(), raw)
    resetSettingsCacheForTests()

    expect(await verifyMcpApiKey(key)).toBeNull()
  })

  it('survives a whole-object system-settings save', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', [ws], 1000)

    const next: SystemSettings = {
      ...loadSettings(),
      defaultAgentId: SYSTEM_AGENT_ID,
      baseUrl: 'http://192.168.1.5:3000',
    }
    saveSettings(next)
    resetSettingsCacheForTests()

    expect(diskRecords()).toHaveLength(1)
    expect(await verifyMcpApiKey(key)).not.toBeNull()
  })

  it('cannot be injected through a system-settings save', () => {
    const forged = {
      ...loadSettings(),
      mcpApiKeys: [{ id: 'deadbeefdeadbeef', salt: 'x', hash: 'y' }],
    } as SystemSettings & { mcpApiKeys: unknown }
    saveSettings(forged)
    resetSettingsCacheForTests()
    expect(diskRecords()).toHaveLength(0)
    expect(listMcpApiKeys()).toHaveLength(0)
  })
})

describe('lifecycle', () => {
  it('revokes a key immediately — the very next verify fails', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', [ws], 1000)
    expect(await verifyMcpApiKey(key)).not.toBeNull()

    expect(revokeMcpApiKey(meta.id)).toBe(true)
    expect(await verifyMcpApiKey(key)).toBeNull()
    expect(listMcpApiKeys()).toHaveLength(0)
  })

  it('reports a revoke of an unknown id without mutating anything', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', [ws], 1000)
    expect(revokeMcpApiKey('nope')).toBe(false)
    expect(listMcpApiKeys()).toHaveLength(1)
  })

  it('replaces the authorized workspace set, treating empty as "nothing"', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    const { key, meta } = await createMcpApiKey('ci', [a], 1000)

    expect(updateMcpApiKeyWorkspaces(meta.id, [b])!.workspaces).toEqual([b])
    expect((await verifyMcpApiKey(key))!.workspaces).toEqual([b])

    expect(updateMcpApiKeyWorkspaces(meta.id, [])!.workspaces).toEqual([])
    // An empty set is "no access", never a wildcard: the key still authenticates
    // but can reach nothing.
    expect((await verifyMcpApiKey(key))!.workspaces).toEqual([])
  })

  it('de-duplicates equivalent workspace spellings in the authorized set', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', [ws, `${ws}/`, `${ws}/./`], 1000)
    expect(meta.workspaces).toEqual([ws])
  })

  it('renames a key without changing what it can reach', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', [ws], 1000)
    expect(renameMcpApiKey(meta.id, ' release bot ')!.name).toBe('release bot')
    expect((await verifyMcpApiKey(key))!.workspaces).toEqual([ws])
  })

  it('records last use, coarsely, and never blanks it', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', [ws], 1000)
    expect(listMcpApiKeys()[0].lastUsedAt).toBeNull()

    touchMcpApiKey(meta.id, 5_000)
    expect(listMcpApiKeys()[0].lastUsedAt).toBe(5_000)

    // Within the granularity window the write is skipped (no lock churn per request).
    touchMcpApiKey(meta.id, 6_000)
    expect(listMcpApiKeys()[0].lastUsedAt).toBe(5_000)

    touchMcpApiKey(meta.id, 200_000)
    expect(listMcpApiKeys()[0].lastUsedAt).toBe(200_000)
  })

  it('keeps concurrent creations — a later save never drops an earlier key', async () => {
    const ws = makeWorkspace('proj')
    const first = await createMcpApiKey('a', [ws], 1)
    const second = await createMcpApiKey('b', [ws], 2)
    const ids = listMcpApiKeys().map((k) => k.id)
    expect(ids).toEqual([second.meta.id, first.meta.id]) // newest first
    expect(await verifyMcpApiKey(first.key)).not.toBeNull()
    expect(await verifyMcpApiKey(second.key)).not.toBeNull()
  })
})

describe('canonicalizeWorkspacePath', () => {
  it('rejects a non-absolute path', () => {
    expect(canonicalizeWorkspacePath('relative/path')).toBeNull()
    expect(canonicalizeWorkspacePath('')).toBeNull()
    expect(canonicalizeWorkspacePath('   ')).toBeNull()
  })

  it('collapses trailing separators and dot segments', () => {
    const ws = makeWorkspace('proj')
    expect(canonicalizeWorkspacePath(`${ws}/`)).toBe(ws)
    expect(canonicalizeWorkspacePath(`${ws}/.`)).toBe(ws)
    expect(canonicalizeWorkspacePath(`${ws}/sub/..`)).toBe(ws)
    expect(canonicalizeWorkspacePath(`  ${ws}  `)).toBe(ws)
  })

  it('resolves a symlink to the same canonical path as its target', () => {
    const ws = makeWorkspace('proj')
    const link = join(dir, 'link-to-proj')
    symlinkSync(ws, link)
    expect(canonicalizeWorkspacePath(link)).toBe(ws)
  })

  it('keeps the lexically-resolved form when the path does not exist', () => {
    const missing = join(dir, 'not-there')
    expect(canonicalizeWorkspacePath(missing)).toBe(missing)
  })
})
