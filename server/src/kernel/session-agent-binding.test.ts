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
  getSessionBindingStats,
  getSessionVendor,
  PENDING_INTENT_TTL_MS,
  resetSettingsCacheForTests,
  saveSettings,
  setPendingIntent,
} from './config/index.js'
import {
  freezeSessionAgent,
  getDefaultAgentId,
  resolveIntentAgent,
  resolveSessionAgentSwitch,
  resolveSessionVendor,
  sameVendorEnabledAgents,
  setSessionAgent,
} from './agent-config/index.js'
import type { VendorId } from '@ccc/shared/protocol'

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
    setPendingIntent('pending:p1', 'cx')
    freezeSessionAgent('pending:p1', 'real-cx', 'cx', '/abs/proj')
    expect(getSessionAgentId('real-cx')).toBe('cx')
    expect(getSessionVendor('real-cx')).toBe('codex')
    // Intent is gone — only the fact remains.
    expect(getSessionAgentId('pending:p1')).toBeNull()
  })

  it('freezes the actually-run agent even with no explicit intent', () => {
    freezeSessionAgent('pending:p2', 'real-cx', 'cx', '/abs/proj')
    expect(getSessionAgentId('real-cx')).toBe('cx')
    expect(getSessionVendor('real-cx')).toBe('codex')
  })

  it('is idempotent: a re-bind never re-freezes the vendor', () => {
    freezeSessionAgent('pending:p3', 'real-claude', SYSTEM_AGENT_ID, '/abs/proj')
    expect(getSessionVendor('real-claude')).toBe('claude')
    // A second bind to the same real id (e.g. a retry) must not overwrite the fact.
    freezeSessionAgent('pending:p3b', 'real-claude', 'oc', '/abs/proj')
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
    expect(changeSessionAgentFact('real-2', 'cx', 'codex')).toBe(false)
    expect(getSessionAgentId('real-2')).toBe(SYSTEM_AGENT_ID)
    expect(getSessionVendor('real-2')).toBe('claude')
  })

  it('setSessionAgent routes pending→intent and real→vendor-checked fact', () => {
    // Pending: always succeeds, updates the mutable intent.
    expect(setSessionAgent('pending:s3', 'cx')).toEqual({ ok: true })
    expect(getSessionAgentId('pending:s3')).toBe('cx')

    // Real, same vendor → ok; cross vendor → rejected.
    bindSessionAgent('pending:s3', 'real-3', SYSTEM_AGENT_ID, 'claude')
    expect(setSessionAgent('real-3', 'claude-b')).toEqual({ ok: true })
    expect(setSessionAgent('real-3', 'cx')).toEqual({ ok: false })
    expect(getSessionAgentId('real-3')).toBe('claude-b')
  })
})

describe('intent session agent binding (pending→agent + freezeVendor)', () => {
  beforeEach(seedAgents)

  it('bindDefaultAgent: setSessionAgent with defaultAgentId writes pending intent and resolves vendor', () => {
    const pending = 'pending:intent-chat-1'
    const defaultId = getDefaultAgentId()
    expect(defaultId).toBe(SYSTEM_AGENT_ID)

    // Simulate what bindDefaultAgent does: setSessionAgent with the default.
    setSessionAgent(pending, defaultId)
    expect(getSessionAgentId(pending)).toBe(defaultId)
    // A pending session's vendor is resolved from the agent (not frozen yet).
    expect(resolveSessionVendor(pending)).toBe('claude')
  })

  it('bindDefaultAgent: codex as defaultAgentId writes codex vendor', () => {
    // Change default agent to 'cx' (codex).
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
          id: 'cx',
          vendor: 'codex',
          configMode: 'system',
          displayName: 'CX',
          config: { baseUrl: '', apiKey: '', model: '' },
        },
      ],
      defaultAgentId: 'cx',
    } as unknown as SystemSettings)
    resetSettingsCacheForTests()

    const pending = 'pending:intent-chat-2'
    setSessionAgent(pending, getDefaultAgentId())
    expect(getSessionAgentId(pending)).toBe('cx')
    expect(resolveSessionVendor(pending)).toBe('codex')
  })

  it('four entry points style: each ensureRuntime followed by setSessionAgent creates a resolvable pending', () => {
    // Simulate the pattern used by newIntentSession / openIntentSession / refineIntent / discussionToIntent.
    const ids = ['pending:new', 'pending:open', 'pending:refine', 'pending:discuss']
    for (const id of ids) {
      setSessionAgent(id, getDefaultAgentId())
    }
    for (const id of ids) {
      expect(getSessionAgentId(id)).toBe(SYSTEM_AGENT_ID)
      expect(resolveSessionVendor(id)).toBe('claude')
    }
  })

  it('bindDefaultAgent idempotent: re-binding same pending id with same agent is harmless', () => {
    const pending = 'pending:idempotent'
    setSessionAgent(pending, SYSTEM_AGENT_ID)
    const firstAgent = getSessionAgentId(pending)
    // Re-bind with the same agent — should still succeed.
    setSessionAgent(pending, SYSTEM_AGENT_ID)
    expect(getSessionAgentId(pending)).toBe(firstAgent)
  })

  it('resolveSessionVendor for pending intent session prefers the intent over default', () => {
    // Default is claude, but the pending intent explicitly binds to codex.
    const pending = 'pending:explicit-cx'
    setSessionAgent(pending, 'cx')
    expect(resolveSessionVendor(pending)).toBe('codex')
    // Default agent is still claude, but the intent overrides.
    expect(getDefaultAgentId()).toBe(SYSTEM_AGENT_ID)
  })
})

describe('intent comm session binding via intentAgentId (bindIntentAgent, AC-R23)', () => {
  beforeEach(seedAgents)

  /** What `bindIntentAgent` does: setSessionAgent with the resolved intent agent. */
  const bindIntentAgent = (sessionId: string): void => {
    setSessionAgent(sessionId, resolveIntentAgent().id)
  }

  it('an empty intentAgentId follows the default agent (system)', () => {
    // seedAgents leaves intentAgentId unset ⇒ normalize keeps it '' ⇒ follow default.
    expect(resolveIntentAgent().id).toBe(SYSTEM_AGENT_ID)
    const pending = 'pending:intent-empty'
    bindIntentAgent(pending)
    expect(getSessionAgentId(pending)).toBe(SYSTEM_AGENT_ID)
    expect(resolveSessionVendor(pending)).toBe('claude')
  })

  it('an explicitly-set intentAgentId routes intent comm sessions to that agent', () => {
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
          id: 'cx',
          vendor: 'codex',
          configMode: 'system',
          displayName: 'CX',
          config: { baseUrl: '', apiKey: '', model: '' },
        },
      ],
      defaultAgentId: SYSTEM_AGENT_ID,
      intentAgentId: 'cx',
    } as unknown as SystemSettings)
    resetSettingsCacheForTests()

    // Intent comm runs on 'cx' even though the default-for-new-sessions is system.
    expect(resolveIntentAgent().id).toBe('cx')
    expect(getDefaultAgentId()).toBe(SYSTEM_AGENT_ID)

    const pending = 'pending:intent-cx'
    bindIntentAgent(pending)
    expect(getSessionAgentId(pending)).toBe('cx')
    expect(resolveSessionVendor(pending)).toBe('codex')
  })

  it('all four entry points (new/open/refine/discussion) bind the intent agent', () => {
    // Route intent comm to claude-b; assert every startup point lands there.
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
      ],
      defaultAgentId: SYSTEM_AGENT_ID,
      intentAgentId: 'claude-b',
    } as unknown as SystemSettings)
    resetSettingsCacheForTests()

    const ids = ['pending:new', 'pending:open', 'pending:refine', 'pending:discuss']
    for (const id of ids) bindIntentAgent(id)
    for (const id of ids) {
      expect(getSessionAgentId(id)).toBe('claude-b')
      expect(resolveSessionVendor(id)).toBe('claude')
    }
  })
})

describe('sameVendorEnabledAgents (shared same-vendor candidate rule)', () => {
  beforeEach(seedAgents)

  it('keeps only same-vendor agents and excludes the given id', () => {
    expect(sameVendorEnabledAgents('claude', SYSTEM_AGENT_ID).map((a) => a.id)).toEqual([
      'claude-b',
    ])
    // No exclusion ⇒ both claude agents; never the codex one.
    expect(sameVendorEnabledAgents('claude', null).map((a) => a.id)).toEqual([
      SYSTEM_AGENT_ID,
      'claude-b',
    ])
    // A vendor with a single agent has no same-vendor peers once it's excluded.
    expect(sameVendorEnabledAgents('codex', 'cx')).toEqual([])
  })
})

describe('resolveSessionAgentSwitch (title-bar switcher payload)', () => {
  beforeEach(seedAgents)
  const allPresent = new Set<VendorId>(['claude', 'codex'])

  it('returns null only for null sessionId', () => {
    expect(resolveSessionAgentSwitch(null, allPresent)).toBeNull()
  })

  it('returns current agent for pending sessions (needed for status bar)', () => {
    const sw = resolveSessionAgentSwitch('pending:x', allPresent)
    expect(sw).not.toBeNull()
    expect(sw?.current).toEqual({ id: SYSTEM_AGENT_ID, displayName: 'System' })
  })

  it('lists same-vendor available peers, marking the current agent', () => {
    bindSessionAgent('pending:w1', 'real-1', SYSTEM_AGENT_ID, 'claude')
    const sw = resolveSessionAgentSwitch('real-1', allPresent)
    expect(sw).not.toBeNull()
    expect(sw?.current).toEqual({ id: SYSTEM_AGENT_ID, displayName: 'System' })
    expect(sw?.candidates).toEqual([{ id: 'claude-b', displayName: 'Claude B' }])
    expect(sw?.currentUnavailable).toBe(false)
  })

  it('excludes a same-vendor peer whose host binary is missing', () => {
    bindSessionAgent('pending:w2', 'real-2', SYSTEM_AGENT_ID, 'claude')
    // claude present, but suppose only system is reachable — claude-b shares the
    // claude binary, so host presence is per-vendor: claude present ⇒ both listed.
    // Drop claude from the present set to assert the current-unavailable path below.
    const sw = resolveSessionAgentSwitch('real-2', new Set<VendorId>(['codex']))
    expect(sw?.currentUnavailable).toBe(true)
    // No claude candidates survive when the claude binary is absent.
    expect(sw?.candidates).toEqual([])
  })

  it('includes current agent when available and has no same-vendor peer', () => {
    bindSessionAgent('pending:w3', 'real-3', 'cx', 'codex')
    const sw = resolveSessionAgentSwitch('real-3', allPresent)
    expect(sw).not.toBeNull()
    expect(sw?.current).toEqual({ id: 'cx', displayName: 'CX' })
    expect(sw?.candidates).toEqual([])
    expect(sw?.currentUnavailable).toBe(false)
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

describe('getSessionBindingStats', () => {
  it('counts bound facts and pending intents independently', () => {
    expect(getSessionBindingStats()).toEqual({ bound: 0, pending: 0 })
    setPendingIntent('pending:a', 'oc')
    setPendingIntent('pending:b', 'claude-b')
    bindSessionAgent('pending:c', 'real-1', 'claude-b', 'claude')
    // bind drops `pending:c`'s (absent) intent and writes one fact; the two
    // standalone intents remain pending.
    expect(getSessionBindingStats()).toEqual({ bound: 1, pending: 2 })
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
