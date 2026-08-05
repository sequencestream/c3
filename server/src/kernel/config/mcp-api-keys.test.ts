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
  listMcpApiKeysForWorkspace,
  parseMcpApiKey,
  renameMcpApiKey,
  revokeMcpApiKey,
  revokeMcpApiKeyInWorkspace,
  touchMcpApiKey,
  updateMcpApiKeyInWorkspace,
  updateMcpApiKeyTools,
  verifyMcpApiKey,
} from './mcp-api-keys.js'
import { loadSettings, resetSettingsCacheForTests, saveSettings } from './index.js'
import { readJsonFile, writeAtomic } from './store.js'

// Redirect the c3 config dir to a throwaway dir via C3_DIR (NOT HOME: os.homedir()
// caches its first call in the worker, so an env change after startup is ignored)
// so these tests never touch the developer's real settings.json.
let dir: string
let prevC3Dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-mcp-keys-'))
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, '.c3')
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
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

const READ_TOOLS = [
  'find_intents',
  'view_intent',
  'find_discussions',
  'view_discussion',
  'publish_event',
]

describe('key format', () => {
  it('mints a c3k_<id>_<secret> key with a 256-bit secret and a matching display prefix', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)

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
    const a = await createMcpApiKey('a', ws, READ_TOOLS, 1)
    const b = await createMcpApiKey('b', ws, READ_TOOLS, 2)
    expect(a.meta.id).not.toBe(b.meta.id)
    expect(a.key).not.toBe(b.key)
  })

  it('binds exactly one canonicalized workspace and refuses a non-absolute path', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', `${ws}/`, READ_TOOLS, 1000)
    expect(meta.workspace).toBe(ws)
    await expect(createMcpApiKey('bad', 'relative/path', READ_TOOLS, 1000)).rejects.toThrow()
  })
})

describe('persistence', () => {
  it('stores only a salted scrypt hash — never the plaintext', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)

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
    await createMcpApiKey('a', ws, READ_TOOLS, 1)
    await createMcpApiKey('b', ws, READ_TOOLS, 2)
    const salts = diskRecords().map((r) => r.salt)
    expect(new Set(salts).size).toBe(2)
  })

  it('never returns hash material in the listing', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    const [meta] = listMcpApiKeys()
    expect(Object.keys(meta).sort()).toEqual([
      'createdAt',
      'displayPrefix',
      'id',
      'lastUsedAt',
      'name',
      'tools',
      'workspace',
    ])
    expect(JSON.stringify(meta)).not.toContain('salt')
  })

  it('authenticates a key after a full reload from disk', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, ['find_intents'], 1000)
    resetSettingsCacheForTests()

    const auth = await verifyMcpApiKey(key)
    expect(auth).toEqual({ id: meta.id, workspace: ws, tools: ['find_intents'] })
  })

  it('rejects a wrong secret under a real key id', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    const forged = `c3k_${meta.id}_${'A'.repeat(43)}`
    expect(forged).not.toBe(key)
    expect(await verifyMcpApiKey(forged)).toBeNull()
  })

  it('rejects an unknown key id', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    expect(await verifyMcpApiKey(`c3k_${'0'.repeat(16)}_${'A'.repeat(43)}`)).toBeNull()
  })

  it('rejects a record whose hash scheme is not supported, rather than failing open', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    const raw = diskRaw()
    const records = raw.mcpApiKeys as Record<string, unknown>[]
    records[0].hashVersion = 99
    writeAtomic(settingsPath(), raw)
    resetSettingsCacheForTests()

    expect(await verifyMcpApiKey(key)).toBeNull()
  })

  it('survives a whole-object system-settings save', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)

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

  it('lists one workspace’s keys only, leaving its neighbour alone', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    await createMcpApiKey('in-a', a, READ_TOOLS, 1)
    await createMcpApiKey('in-b', b, READ_TOOLS, 2)

    const inA = listMcpApiKeysForWorkspace(a)
    const inB = listMcpApiKeysForWorkspace(b)
    expect(inA).toHaveLength(1)
    expect(inA[0].name).toBe('in-a')
    expect(inB).toHaveLength(1)
    expect(inB[0].name).toBe('in-b')
    // A relative path is a caller error, not a lookup miss.
    expect(listMcpApiKeysForWorkspace('relative')).toEqual([])
  })
})

describe('legacy migration', () => {
  it('keeps a single-workspace legacy key verbatim, giving it the read-only scope it effectively had', async () => {
    const ws = makeWorkspace('proj')
    // A pre-scope record: `workspaces` array of one, no `tools`.
    const { key } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    const raw = diskRaw()
    const rec = (raw.mcpApiKeys as Record<string, unknown>[])[0]
    rec.workspaces = [rec.workspace]
    delete rec.workspace
    delete rec.tools
    writeAtomic(settingsPath(), raw)
    resetSettingsCacheForTests()

    const auth = await verifyMcpApiKey(key)
    expect(auth).not.toBeNull()
    expect(auth!.workspace).toBe(ws)
    expect(auth!.tools).toEqual(READ_TOOLS)
  })

  it('revokes a legacy key that authorized several workspaces — no single address exists', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    const { key, meta } = await createMcpApiKey('multi', a, READ_TOOLS, 1000)
    const raw = diskRaw()
    const rec = (raw.mcpApiKeys as Record<string, unknown>[])[0]
    rec.workspaces = [a, b]
    delete rec.workspace
    writeAtomic(settingsPath(), raw)
    resetSettingsCacheForTests()

    // Dropped on load: gone from the roster, and the plaintext is now invalid.
    expect(listMcpApiKeys()).toHaveLength(0)
    expect(await verifyMcpApiKey(key)).toBeNull()
    expect(meta.id).toBeTruthy()
  })

  it('revokes a legacy key with no resolvable workspace', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ghost', ws, READ_TOOLS, 1000)
    const raw = diskRaw()
    const rec = (raw.mcpApiKeys as Record<string, unknown>[])[0]
    rec.workspaces = []
    delete rec.workspace
    writeAtomic(settingsPath(), raw)
    resetSettingsCacheForTests()

    expect(listMcpApiKeys()).toHaveLength(0)
    expect(await verifyMcpApiKey(key)).toBeNull()
  })
})

describe('lifecycle', () => {
  it('revokes a key immediately — the very next verify fails', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    expect(await verifyMcpApiKey(key)).not.toBeNull()

    expect(revokeMcpApiKey(meta.id)).toBe(true)
    expect(await verifyMcpApiKey(key)).toBeNull()
    expect(listMcpApiKeys()).toHaveLength(0)
  })

  it('reports a revoke of an unknown id without mutating anything', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    expect(revokeMcpApiKey('nope')).toBe(false)
    expect(listMcpApiKeys()).toHaveLength(1)
  })

  it('replaces the tool scope, treating empty as "nothing"', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)

    expect(updateMcpApiKeyTools(meta.id, ['save_intents', 'find_intents'])!.tools).toEqual([
      'save_intents',
      'find_intents',
    ])
    expect((await verifyMcpApiKey(key))!.tools).toEqual(['save_intents', 'find_intents'])

    expect(updateMcpApiKeyTools(meta.id, [])!.tools).toEqual([])
    // An empty scope is "no tools", never a wildcard: the key still authenticates
    // but can call nothing.
    expect((await verifyMcpApiKey(key))!.tools).toEqual([])
  })

  it('de-duplicates tool names in the scope', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey(
      'ci',
      ws,
      ['find_intents', 'find_intents', 'view_intent'],
      1000,
    )
    expect(meta.tools).toEqual(['find_intents', 'view_intent'])
  })

  it('does not let a scope update move a key to another workspace', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    const { key, meta } = await createMcpApiKey('ci', a, READ_TOOLS, 1000)
    updateMcpApiKeyTools(meta.id, ['view_intent'])
    // The binding is immutable: the update changed tools, never the workspace.
    expect((await verifyMcpApiKey(key))!.workspace).toBe(a)
    void b
  })

  it('renames a key without changing what it can reach', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    expect(renameMcpApiKey(meta.id, ' release bot ')!.name).toBe('release bot')
    expect((await verifyMcpApiKey(key))!.workspace).toBe(ws)
  })

  it('records last use, coarsely, and never blanks it', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
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
    const first = await createMcpApiKey('a', ws, READ_TOOLS, 1)
    const second = await createMcpApiKey('b', ws, READ_TOOLS, 2)
    const ids = listMcpApiKeys().map((k) => k.id)
    expect(ids).toEqual([second.meta.id, first.meta.id]) // newest first
    expect(await verifyMcpApiKey(first.key)).not.toBeNull()
    expect(await verifyMcpApiKey(second.key)).not.toBeNull()
  })

  it('updates name and tools atomically in one workspace-scoped mutation', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', ws, READ_TOOLS, 1000)
    const updated = updateMcpApiKeyInWorkspace(meta.id, ws, {
      name: 'release bot',
      tools: ['save_intents'],
    })
    expect(updated!.name).toBe('release bot')
    expect(updated!.tools).toEqual(['save_intents'])
    expect(listMcpApiKeys()[0].name).toBe('release bot')
  })

  it('rejects a workspace-scoped update when the key belongs elsewhere', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    const { meta } = await createMcpApiKey('ci', b, READ_TOOLS, 1000)
    expect(updateMcpApiKeyInWorkspace(meta.id, a, { tools: ['save_intents'] })).toBeNull()
    expect(listMcpApiKeysForWorkspace(b)[0].tools).toEqual(READ_TOOLS)
  })

  it('rejects a workspace-scoped revoke when the key belongs elsewhere', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    const { key, meta } = await createMcpApiKey('ci', b, READ_TOOLS, 1000)
    expect(revokeMcpApiKeyInWorkspace(meta.id, a)).toBe(false)
    expect(listMcpApiKeys()).toHaveLength(1)
    expect(await verifyMcpApiKey(key)).not.toBeNull()
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
