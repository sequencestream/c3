import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import {
  bindSessionAgent,
  changeSessionAgentFact,
  cleanupStalePendingIntents,
  deleteSessionAgentId,
  getSessionAgentId,
  getSessionVendor,
  PENDING_INTENT_TTL_MS,
  resetSettingsCacheForTests,
  saveSettings,
  setPendingIntent,
} from './config/index.js'
import { freezeSessionAgent, setSessionAgent } from './agent-config/index.js'

// Two-key session→agent binding space + frozen-vendor invariant (ADR-0015).
// `~/.c3` is redirected to a throwaway dir (os.homedir() honours $HOME on POSIX)
// so these never touch the developer's real state.json.
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-binding-'))
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

/** Register a heterogeneous agent table so `resolveAgent` maps ids → vendors. */
function seedAgents(): void {
  saveSettings({
    agents: [
      {
        id: SYSTEM_AGENT_ID,
        vendor: 'claude',
        configMode: 'system',
        displayName: 'System',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'claude-b',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'Claude B',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'oc',
        vendor: 'opencode',
        configMode: 'custom',
        displayName: 'OC',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'cx',
        vendor: 'codex',
        configMode: 'custom',
        displayName: 'CX',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
    ],
    defaultAgentId: SYSTEM_AGENT_ID,
  } as unknown as SystemSettings)
}

/**
 * Write a raw `~/.c3/state.json` body, then drop the cache so the next read
 * re-parses. The JSON is passed pre-serialized (built with template strings) —
 * `JSON.stringify` is banned under `kernel/` by the ADR-0009 R2 lint rule.
 */
function writeRawState(json: string): void {
  const c3 = join(dir, '.c3')
  mkdirSync(c3, { recursive: true })
  writeFileSync(join(c3, 'state.json'), json, 'utf-8')
  resetSettingsCacheForTests()
}

describe('two-key write space (intent vs fact)', () => {
  it('a pending intent never lands as a fact, and getSessionAgentId reads both spaces', () => {
    const pending = 'pending:abc'
    setPendingIntent(pending, 'claude-b')
    // Intent is readable via the pending id…
    expect(getSessionAgentId(pending)).toBe('claude-b')
    // …but it is not a fact (no frozen vendor, not under a real id).
    expect(getSessionVendor(pending)).toBeNull()
    expect(getSessionVendor('claude-b')).toBeNull()

    bindSessionAgent(pending, 'real-1', 'claude-b', 'claude')
    expect(getSessionAgentId('real-1')).toBe('claude-b')
    expect(getSessionVendor('real-1')).toBe('claude')
  })

  it('clearing an intent (null agent) leaves no fact behind', () => {
    setPendingIntent('pending:x', 'oc')
    setPendingIntent('pending:x', null)
    expect(getSessionAgentId('pending:x')).toBeNull()
    expect(getSessionVendor('pending:x')).toBeNull()
  })
})

describe('freezeSessionAgent (bind → freeze vendor)', () => {
  beforeEach(seedAgents)

  it('copies the intent into a fact, freezes vendor, and drops the intent', () => {
    setPendingIntent('pending:p1', 'oc')
    freezeSessionAgent('pending:p1', 'real-oc', 'oc')
    expect(getSessionAgentId('real-oc')).toBe('oc')
    expect(getSessionVendor('real-oc')).toBe('opencode')
    // Intent is gone — only the fact remains.
    expect(getSessionAgentId('pending:p1')).toBeNull()
  })

  it('freezes the actually-run agent even with no explicit intent', () => {
    freezeSessionAgent('pending:p2', 'real-cx', 'cx')
    expect(getSessionAgentId('real-cx')).toBe('cx')
    expect(getSessionVendor('real-cx')).toBe('codex')
  })

  it('is idempotent: a re-bind never re-freezes the vendor', () => {
    freezeSessionAgent('pending:p3', 'real-claude', SYSTEM_AGENT_ID)
    expect(getSessionVendor('real-claude')).toBe('claude')
    // A second bind to the same real id (e.g. a retry) must not overwrite the fact.
    freezeSessionAgent('pending:p3b', 'real-claude', 'oc')
    expect(getSessionAgentId('real-claude')).toBe(SYSTEM_AGENT_ID)
    expect(getSessionVendor('real-claude')).toBe('claude')
  })
})

describe('changeSessionAgentFact / setSessionAgent (same-vendor swap vs cross-vendor reject)', () => {
  beforeEach(seedAgents)

  it('allows a same-vendor agent swap', () => {
    bindSessionAgent('pending:s1', 'real-1', SYSTEM_AGENT_ID, 'claude')
    expect(changeSessionAgentFact('real-1', 'claude-b', 'claude')).toBe(true)
    expect(getSessionAgentId('real-1')).toBe('claude-b')
    expect(getSessionVendor('real-1')).toBe('claude')
  })

  it('rejects a cross-vendor change and leaves the fact untouched', () => {
    bindSessionAgent('pending:s2', 'real-2', SYSTEM_AGENT_ID, 'claude')
    expect(changeSessionAgentFact('real-2', 'oc', 'opencode')).toBe(false)
    expect(getSessionAgentId('real-2')).toBe(SYSTEM_AGENT_ID)
    expect(getSessionVendor('real-2')).toBe('claude')
  })

  it('setSessionAgent routes pending→intent and real→vendor-checked fact', () => {
    // Pending: always succeeds, updates the mutable intent.
    expect(setSessionAgent('pending:s3', 'oc')).toEqual({ ok: true })
    expect(getSessionAgentId('pending:s3')).toBe('oc')

    // Real, same vendor → ok; cross vendor → rejected.
    bindSessionAgent('pending:s3', 'real-3', SYSTEM_AGENT_ID, 'claude')
    expect(setSessionAgent('real-3', 'claude-b')).toEqual({ ok: true })
    expect(setSessionAgent('real-3', 'oc')).toEqual({ ok: false })
    expect(getSessionAgentId('real-3')).toBe('claude-b')
  })
})

describe('cleanupStalePendingIntents (janitor)', () => {
  it('reaps intents older than the TTL, keeps fresh ones, and returns the reaped ids', () => {
    const now = 1_000_000_000_000
    const stale = now - PENDING_INTENT_TTL_MS - 1
    const fresh = now - 1000
    // Stale intent written far in the past; fresh one written "now".
    writeRawState(
      `{"version":2,` +
        `"pendingIntents":{` +
        `"pending:old":{"agentId":"oc","createdAt":${stale}},` +
        `"pending:new":{"agentId":"oc","createdAt":${fresh}}},` +
        `"sessionAgents":{"real-keep":{"agentId":"claude-b","vendor":"claude"}}}`,
    )

    const reaped = cleanupStalePendingIntents(now, PENDING_INTENT_TTL_MS)
    expect(reaped).toEqual(['pending:old'])
    expect(getSessionAgentId('pending:old')).toBeNull()
    expect(getSessionAgentId('pending:new')).toBe('oc')
    // Facts are never touched by the janitor — no orphaning.
    expect(getSessionAgentId('real-keep')).toBe('claude-b')
    expect(getSessionVendor('real-keep')).toBe('claude')
  })
})

describe('deleteSessionAgentId clears both spaces', () => {
  it('drops a pending intent and a real fact alike', () => {
    setPendingIntent('pending:d', 'oc')
    bindSessionAgent('pending:other', 'real-d', 'claude-b', 'claude')
    deleteSessionAgentId('pending:d')
    deleteSessionAgentId('real-d')
    expect(getSessionAgentId('pending:d')).toBeNull()
    expect(getSessionAgentId('real-d')).toBeNull()
    expect(getSessionVendor('real-d')).toBeNull()
  })
})

describe('v1 → v2 state migration', () => {
  it('splits a legacy single map: pending keys → intents, real keys → claude facts', () => {
    writeRawState(`{"version":1,"sessionAgents":{"pending:legacy":"oc","real-legacy":"claude-b"}}`)

    // Pending key migrated to an intent (readable via the pending id, no vendor).
    expect(getSessionAgentId('pending:legacy')).toBe('oc')
    expect(getSessionVendor('pending:legacy')).toBeNull()
    // Real key migrated to a fact frozen to claude (the only pre-multi-vendor vendor).
    expect(getSessionAgentId('real-legacy')).toBe('claude-b')
    expect(getSessionVendor('real-legacy')).toBe('claude')
  })
})
