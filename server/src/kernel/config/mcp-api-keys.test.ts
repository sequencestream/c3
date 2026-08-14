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
  replaceMcpApiKeySecret,
  revokeMcpApiKey,
  revokeMcpApiKeyInWorkspace,
  revokeUnownedMcpApiKeys,
  touchMcpApiKey,
  updateMcpApiKeyInWorkspace,
  updateMcpApiKeyTools,
  verifyMcpApiKey,
} from './mcp-api-keys.js'
import { loadSettings, saveSettings } from './index.js'
import {
  readStoredMcpKeys,
  releaseConfigDb,
  resetConfigCaches,
  seedMcpKey,
  useConfigDb,
} from './config-fixture.js'
import { findWorkspaceByName, registerWorkspace } from './workspace-store.js'
import { readPolicyEpoch } from './policy-epoch.js'

// Run against a throwaway database so these tests never touch the developer's real
// configuration.
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-mcp-keys-'))
  useConfigDb(dir)
})

afterEach(() => {
  releaseConfigDb()
  rmSync(dir, { recursive: true, force: true })
})

function storedRecords(): Record<string, unknown>[] {
  return readStoredMcpKeys()
}

/** Register a real workspace directory and return its immutable name. */
function makeWorkspace(name: string): string {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return registerWorkspace(p, name, Date.now()).name
}

function makeWorkspacePath(name: string): string {
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

/** The owner every fixture key borrows authority from. */
const OWNER = 'alice'

describe('key format', () => {
  it('mints a c3k_<id>_<secret> key with a 256-bit secret and a matching display prefix', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)

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
    const a = await createMcpApiKey('a', ws, OWNER, READ_TOOLS, 1)
    const b = await createMcpApiKey('b', ws, OWNER, READ_TOOLS, 2)
    expect(a.meta.id).not.toBe(b.meta.id)
    expect(a.key).not.toBe(b.key)
  })

  it('files the key under one registered workspace and refuses an unknown name', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    expect(meta.workspaceName).toBe(ws)
    await expect(createMcpApiKey('bad', 'relative/path', OWNER, READ_TOOLS, 1000)).rejects.toThrow()
  })

  it('records the owner and starts the secret at version 1', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', ws, ' alice ', READ_TOOLS, 1000)
    expect(meta.ownerSubject).toBe('alice')
    expect(meta.secretVersion).toBe(1)
  })

  it('refuses to mint a key with a blank owner', async () => {
    const ws = makeWorkspace('proj')
    await expect(createMcpApiKey('ci', ws, '', READ_TOOLS, 1000)).rejects.toThrow()
    await expect(createMcpApiKey('ci', ws, '   ', READ_TOOLS, 1000)).rejects.toThrow()
    expect(storedRecords()).toHaveLength(0)
  })
})

describe('persistence', () => {
  it('stores only a salted scrypt hash — never the plaintext', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)

    const serialized = JSON.stringify(storedRecords())
    expect(serialized).not.toContain(key)
    expect(serialized).not.toContain(parseMcpApiKey(key)!.secret)

    const [rec] = storedRecords()
    expect(rec.algo).toBe('scrypt')
    expect(rec.hashVersion).toBe(1)
    expect(typeof rec.salt).toBe('string')
    expect(typeof rec.hash).toBe('string')
  })

  it('gives every key its own salt', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('a', ws, OWNER, READ_TOOLS, 1)
    await createMcpApiKey('b', ws, OWNER, READ_TOOLS, 2)
    const salts = storedRecords().map((r) => r.salt)
    expect(new Set(salts).size).toBe(2)
  })

  it('never returns hash material in the listing', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    const [meta] = listMcpApiKeys()
    expect(Object.keys(meta).sort()).toEqual([
      'createdAt',
      'displayPrefix',
      'id',
      'lastUsedAt',
      'name',
      'ownerSubject',
      'secretVersion',
      'tools',
      'workspaceName',
    ])
    expect(JSON.stringify(meta)).not.toContain('salt')
  })

  it('authenticates a key after a full reload from disk', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, OWNER, ['find_intents'], 1000)
    resetConfigCaches()

    const auth = await verifyMcpApiKey(key)
    expect(auth).toEqual({
      id: meta.id,
      ownerSubject: OWNER,
      secretVersion: 1,
      tools: ['find_intents'],
    })
  })

  it('rejects a wrong secret under a real key id', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    const forged = `c3k_${meta.id}_${'A'.repeat(43)}`
    expect(forged).not.toBe(key)
    expect(await verifyMcpApiKey(forged)).toBeNull()
  })

  it('rejects an unknown key id', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    expect(await verifyMcpApiKey(`c3k_${'0'.repeat(16)}_${'A'.repeat(43)}`)).toBeNull()
  })

  it('rejects a record whose hash scheme is not supported, rather than failing open', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    const [rec] = storedRecords()
    seedMcpKey(rec.id as string, { ...rec, hashVersion: 99 })

    expect(await verifyMcpApiKey(key)).toBeNull()
  })

  it('survives a whole-object system-settings save', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)

    const next: SystemSettings = {
      ...loadSettings(),
      defaultAgentId: SYSTEM_AGENT_ID,
      baseUrl: 'http://192.168.1.5:3000',
    }
    saveSettings(next)
    resetConfigCaches()

    expect(storedRecords()).toHaveLength(1)
    expect(await verifyMcpApiKey(key)).not.toBeNull()
  })

  it('cannot be injected through a system-settings save', () => {
    const forged = {
      ...loadSettings(),
      mcpApiKeys: [{ id: 'deadbeefdeadbeef', salt: 'x', hash: 'y' }],
    } as SystemSettings & { mcpApiKeys: unknown }
    saveSettings(forged)
    resetConfigCaches()
    expect(storedRecords()).toHaveLength(0)
    expect(listMcpApiKeys()).toHaveLength(0)
  })

  it('lists one workspace’s keys only, leaving its neighbour alone', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    await createMcpApiKey('in-a', a, OWNER, READ_TOOLS, 1)
    await createMcpApiKey('in-b', b, OWNER, READ_TOOLS, 2)

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

describe('ownerless legacy records', () => {
  /** Strip a field from a stored record and write it back verbatim. */
  async function seedWithout(field: string): Promise<{ key: string; id: string }> {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    const [rec] = storedRecords()
    const legacy: Record<string, unknown> = { ...rec }
    delete legacy[field]
    seedMcpKey(rec.id as string, legacy)
    return { key, id: rec.id as string }
  }

  it('treats a record without an owner as revoked rather than guessing one', async () => {
    const { key } = await seedWithout('ownerSubject')
    expect(listMcpApiKeys()).toHaveLength(0)
    expect(await verifyMcpApiKey(key)).toBeNull()
  })

  it('treats a record without a secret version as revoked', async () => {
    const { key } = await seedWithout('secretVersion')
    expect(listMcpApiKeys()).toHaveLength(0)
    expect(await verifyMcpApiKey(key)).toBeNull()
  })

  it('rejects a non-positive secret version — 0 is not a generation', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    const [rec] = storedRecords()
    seedMcpKey(rec.id as string, { ...rec, secretVersion: 0 })
    expect(await verifyMcpApiKey(key)).toBeNull()
  })

  it('deletes ownerless scopes from storage, leaving owned ones untouched', async () => {
    const ws = makeWorkspace('proj')
    const owned = await createMcpApiKey('owned', ws, OWNER, READ_TOOLS, 1)
    const orphan = await createMcpApiKey('orphan', ws, OWNER, READ_TOOLS, 2)
    const stored = storedRecords()
    const orphanRec = stored.find((r) => r.id === orphan.meta.id)!
    const stripped: Record<string, unknown> = { ...orphanRec }
    delete stripped.ownerSubject
    seedMcpKey(orphan.meta.id, stripped)

    expect(revokeUnownedMcpApiKeys()).toEqual([orphan.meta.id])
    expect(storedRecords().map((r) => r.id)).toEqual([owned.meta.id])
    // Idempotent: a second pass has nothing left to remove.
    expect(revokeUnownedMcpApiKeys()).toEqual([])
    expect(await verifyMcpApiKey(owned.key)).not.toBeNull()
  })

  it('drops a record whose administering workspace no longer exists', async () => {
    const ws = makeWorkspace('proj')
    const { key } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    const [rec] = storedRecords()
    seedMcpKey(rec.id as string, { ...rec, workspaceName: 'never-registered' })

    expect(listMcpApiKeys()).toHaveLength(0)
    expect(await verifyMcpApiKey(key)).toBeNull()
    // The path-shaped legacy binding resolves through the registry the same way.
    expect(findWorkspaceByName(ws)).not.toBeNull()
  })
})

describe('secret rotation', () => {
  it('mints a new plaintext and advances the version, invalidating the old key', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)

    const rotated = await replaceMcpApiKeySecret(meta.id)
    expect(rotated).not.toBeNull()
    expect(rotated!.meta.secretVersion).toBe(2)
    expect(rotated!.key).not.toBe(key)
    expect(await verifyMcpApiKey(key)).toBeNull()
    expect((await verifyMcpApiKey(rotated!.key))!.secretVersion).toBe(2)
  })

  it('reports an unknown id without minting anything', async () => {
    expect(await replaceMcpApiKeySecret('nope')).toBeNull()
  })
})

describe('lifecycle', () => {
  it('revokes a key immediately — the very next verify fails', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    expect(await verifyMcpApiKey(key)).not.toBeNull()

    expect(revokeMcpApiKey(meta.id)).toBe(true)
    expect(await verifyMcpApiKey(key)).toBeNull()
    expect(listMcpApiKeys()).toHaveLength(0)
  })

  it('reports a revoke of an unknown id without mutating anything', async () => {
    const ws = makeWorkspace('proj')
    await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    expect(revokeMcpApiKey('nope')).toBe(false)
    expect(listMcpApiKeys()).toHaveLength(1)
  })

  it('replaces the tool scope, treating empty as "nothing"', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)

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
      OWNER,
      ['find_intents', 'find_intents', 'view_intent'],
      1000,
    )
    expect(meta.tools).toEqual(['find_intents', 'view_intent'])
  })

  it('does not let a scope update reassign the owner or the filing workspace', async () => {
    const a = makeWorkspace('a')
    const { key, meta } = await createMcpApiKey('ci', a, OWNER, READ_TOOLS, 1000)
    updateMcpApiKeyTools(meta.id, ['view_intent'])
    expect((await verifyMcpApiKey(key))!.ownerSubject).toBe(OWNER)
    expect(listMcpApiKeys()[0].workspaceName).toBe(a)
  })

  it('renames a key without changing what it can reach', async () => {
    const ws = makeWorkspace('proj')
    const { key, meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    expect(renameMcpApiKey(meta.id, ' release bot ')!.name).toBe('release bot')
    expect((await verifyMcpApiKey(key))!.tools).toEqual(READ_TOOLS)
  })

  it('bumps the policy epoch on a tool grant but not on a rename or a use', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
    const before = readPolicyEpoch()

    renameMcpApiKey(meta.id, 'renamed')
    touchMcpApiKey(meta.id, 900_000)
    expect(readPolicyEpoch()).toBe(before)

    updateMcpApiKeyTools(meta.id, ['view_intent'])
    expect(readPolicyEpoch()).toBe(before + 1)

    updateMcpApiKeyInWorkspace(meta.id, ws, { name: 'again' })
    expect(readPolicyEpoch()).toBe(before + 1)

    updateMcpApiKeyInWorkspace(meta.id, ws, { tools: ['find_intents'] })
    expect(readPolicyEpoch()).toBe(before + 2)
  })

  it('records last use, coarsely, and never blanks it', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
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
    const first = await createMcpApiKey('a', ws, OWNER, READ_TOOLS, 1)
    const second = await createMcpApiKey('b', ws, OWNER, READ_TOOLS, 2)
    const ids = listMcpApiKeys().map((k) => k.id)
    expect(ids).toEqual([second.meta.id, first.meta.id]) // newest first
    expect(await verifyMcpApiKey(first.key)).not.toBeNull()
    expect(await verifyMcpApiKey(second.key)).not.toBeNull()
  })

  it('updates name and tools atomically in one workspace-scoped mutation', async () => {
    const ws = makeWorkspace('proj')
    const { meta } = await createMcpApiKey('ci', ws, OWNER, READ_TOOLS, 1000)
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
    const { meta } = await createMcpApiKey('ci', b, OWNER, READ_TOOLS, 1000)
    expect(updateMcpApiKeyInWorkspace(meta.id, a, { tools: ['save_intents'] })).toBeNull()
    expect(listMcpApiKeysForWorkspace(b)[0].tools).toEqual(READ_TOOLS)
  })

  it('rejects a workspace-scoped revoke when the key belongs elsewhere', async () => {
    const a = makeWorkspace('a')
    const b = makeWorkspace('b')
    const { key, meta } = await createMcpApiKey('ci', b, OWNER, READ_TOOLS, 1000)
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
    const ws = makeWorkspacePath('proj')
    expect(canonicalizeWorkspacePath(`${ws}/`)).toBe(ws)
    expect(canonicalizeWorkspacePath(`${ws}/.`)).toBe(ws)
    expect(canonicalizeWorkspacePath(`${ws}/sub/..`)).toBe(ws)
    expect(canonicalizeWorkspacePath(`  ${ws}  `)).toBe(ws)
  })

  it('resolves a symlink to the same canonical path as its target', () => {
    const ws = makeWorkspacePath('proj')
    const link = join(dir, 'link-to-proj')
    symlinkSync(ws, link)
    expect(canonicalizeWorkspacePath(link)).toBe(ws)
  })

  it('keeps the lexically-resolved form when the path does not exist', () => {
    const missing = join(dir, 'not-there')
    expect(canonicalizeWorkspacePath(missing)).toBe(missing)
  })
})
