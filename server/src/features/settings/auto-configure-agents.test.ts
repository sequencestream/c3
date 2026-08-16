import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { AgentConfig, ServerToClient, SystemSettings, VendorId } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

/**
 * The one-click agent bootstrap: probe → construct → persist, and the idempotency
 * that makes a second click a no-op.
 *
 * The probe and the store are stubbed so the decision is tested on its own terms:
 * what a real CLI is installed on the developer's machine must not decide whether
 * this passes.
 */

const h = vi.hoisted(() => ({
  available: new Set<string>(),
  disk: null as unknown as SystemSettings,
  saved: [] as SystemSettings[],
}))

vi.mock('../../kernel/agent/vendor-runtime.js', () => ({
  availableVendorSet: () => h.available,
}))

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => h.disk,
  // Mirror the real store's contract closely enough for the handler: the saved
  // object is echoed back as the new authoritative snapshot.
  saveSettings: (s: SystemSettings) => {
    h.saved.push(s)
    return s
  },
  getSessionBindingStats: () => ({ bound: 0, pending: 0 }),
  loadWorkspaceSetting: () => ({}),
  saveWorkspaceSetting: (_p: string, c: unknown) => c,
}))

// The settings frame re-probes host CLIs / sandbox / skill support. None of that
// is what this file is about, so the whole companion layer is stubbed flat.
vi.mock('./index.js', () => ({
  settingsFrame: (settings: SystemSettings) => ({ type: 'settings', settings }),
}))

import { autoConfigureAgentsHandler, planAutoConfiguredAgents } from './auto-configure-agents.js'

const base: SystemSettings = {
  agents: [],
  defaultAgentId: SYSTEM_AGENT_ID,
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  specReviewAgentId: '',
  automationAgentId: '',
}

/** The synthesized fallback as the server would have persisted it. */
const fallbackAgent: AgentConfig = {
  id: SYSTEM_AGENT_ID,
  vendor: 'claude',
  configMode: 'system',
  displayName: 'System',
  enabled: true,
  icon: '',
  order_seq: 0,
  config: { baseUrl: '', apiKey: '', model: '' },
}

function settingsWith(agents: AgentConfig[]): SystemSettings {
  return { ...base, agents }
}

describe('planAutoConfiguredAgents — probe → construct', () => {
  it('creates one system-mode agent per available vendor, named for the vendor', () => {
    const created = planAutoConfiguredAgents(base, new Set<VendorId>(['claude', 'codex']), 1000)
    expect(created.map((a) => a.vendor)).toEqual(['claude', 'codex'])
    expect(created.every((a) => a.configMode === 'system')).toBe(true)
    expect(created.every((a) => a.enabled === true)).toBe(true)
    expect(created.map((a) => a.displayName)).toEqual(['Claude Code', 'Codex'])
  })

  it('gives each vendor its OWN config shell, so zod cannot drop the agent on save', () => {
    const created = planAutoConfiguredAgents(
      base,
      new Set<VendorId>(['claude', 'codex', 'cursor']),
      1000,
    )
    const byVendor = new Map(created.map((a) => [a.vendor, a]))
    expect(byVendor.get('claude')!.config).toEqual({ baseUrl: '', apiKey: '', model: '' })
    // The codex arm requires `wireApi`; a claude-shaped shell would be discarded.
    expect(byVendor.get('codex')!.config).toEqual({
      baseUrl: '',
      apiKey: '',
      model: '',
      wireApi: 'chat',
    })
    // Cursor carries no baseUrl — its schema is `.strict()` and would reject one.
    expect(byVendor.get('cursor')!.config).toEqual({ apiKey: '', model: '' })
  })

  it('mints purely numeric ids — no `new`/`copy` placeholder words', () => {
    const created = planAutoConfiguredAgents(base, new Set<VendorId>(['claude', 'codex']), 1700)
    expect(created.map((a) => a.id)).toEqual(['1700-0', '1700-1'])
    for (const a of created) expect(a.id).toMatch(/^\d+-\d+$/)
  })

  it('never reuses an id an existing agent already holds', () => {
    const taken: AgentConfig = { ...fallbackAgent, id: '1700-0' }
    const created = planAutoConfiguredAgents(
      settingsWith([taken]),
      new Set<VendorId>(['codex', 'cursor']),
      1700,
    )
    expect(created.map((a) => a.id)).toEqual(['1700-1', '1700-2'])
  })

  it('skips a vendor that is not runnable', () => {
    const created = planAutoConfiguredAgents(base, new Set<VendorId>(['codex']), 1000)
    expect(created.map((a) => a.vendor)).toEqual(['codex'])
  })

  it('creates nothing when no vendor is runnable', () => {
    expect(planAutoConfiguredAgents(base, new Set<VendorId>(), 1000)).toEqual([])
  })
})

describe('planAutoConfiguredAgents — idempotency', () => {
  it('skips a vendor that already has a system-mode agent', () => {
    const existing: AgentConfig = {
      id: 'my-codex',
      vendor: 'codex',
      configMode: 'system',
      displayName: 'Codex',
      config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
    }
    const created = planAutoConfiguredAgents(
      settingsWith([existing]),
      new Set<VendorId>(['claude', 'codex']),
      1000,
    )
    expect(created.map((a) => a.vendor)).toEqual(['claude'])
  })

  it('counts the synthesized fallback as claude`s system agent — no duplicate claude row', () => {
    const created = planAutoConfiguredAgents(
      settingsWith([fallbackAgent]),
      new Set<VendorId>(['claude', 'codex']),
      1000,
    )
    expect(created.map((a) => a.vendor)).toEqual(['codex'])
  })

  it('still covers a vendor whose only agent is custom-mode (that one carries no CLI config)', () => {
    const custom: AgentConfig = {
      id: 'custom-claude',
      vendor: 'claude',
      configMode: 'custom',
      displayName: 'Custom Claude',
      config: { baseUrl: 'https://x', apiKey: 'k', model: 'm' },
    }
    const created = planAutoConfiguredAgents(
      settingsWith([custom]),
      new Set<VendorId>(['claude']),
      1000,
    )
    expect(created.map((a) => a.vendor)).toEqual(['claude'])
  })

  it('is a no-op the second time — replaying against the produced registry adds nothing', () => {
    const available = new Set<VendorId>(['claude', 'codex', 'cursor'])
    const first = planAutoConfiguredAgents(base, available, 1000)
    const second = planAutoConfiguredAgents(settingsWith(first), available, 2000)
    expect(first).toHaveLength(3)
    expect(second).toEqual([])
  })
})

describe('auto_configure_agents handler', () => {
  const KCTX = {} as never

  function connFor(subject: string | null): { conn: Conn; sent: ServerToClient[] } {
    const sent: ServerToClient[] = []
    const conn: Conn = {
      send: (m) => sent.push(m),
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      authed: subject !== null,
      authToken: subject ? 'tok' : null,
      subject,
    }
    return { conn, sent }
  }

  beforeEach(() => {
    h.disk = { ...base }
    h.saved = []
    h.available = new Set()
  })

  it('persists the created agents and echoes both the result and the settings frame', () => {
    h.available = new Set(['claude', 'codex'])
    const { conn, sent } = connFor(null)
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })

    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].agents.map((a) => a.vendor)).toEqual(['claude', 'codex'])
    expect(sent[0]).toMatchObject({
      type: 'auto_configure_agents_result',
      created: 2,
      availableVendors: 2,
      vendors: ['claude', 'codex'],
    })
    expect(sent[1]).toMatchObject({ type: 'settings' })
  })

  it('appends rather than replaces, so an existing agent survives', () => {
    h.available = new Set(['codex'])
    h.disk = settingsWith([fallbackAgent])
    const { conn } = connFor(null)
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })
    expect(h.saved[0].agents.map((a) => a.id)).toEqual([SYSTEM_AGENT_ID, expect.any(String)])
    expect(h.saved[0].agents.map((a) => a.vendor)).toEqual(['claude', 'codex'])
  })

  it('writes nothing when no vendor is runnable, and says so rather than staying silent', () => {
    const { conn, sent } = connFor(null)
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })
    expect(h.saved).toEqual([])
    expect(sent[0]).toMatchObject({
      type: 'auto_configure_agents_result',
      created: 0,
      availableVendors: 0,
      vendors: [],
    })
    // The console still gets the registry, so a stale panel cannot linger.
    expect(sent[1]).toMatchObject({ type: 'settings' })
  })

  it('reports 0 created with the vendor count intact when everything is already covered', () => {
    h.available = new Set(['claude'])
    h.disk = settingsWith([fallbackAgent])
    const { conn, sent } = connFor(null)
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })
    expect(h.saved).toEqual([])
    expect(sent[0]).toMatchObject({
      type: 'auto_configure_agents_result',
      created: 0,
      availableVendors: 1,
    })
  })

  it('is a no-op on a repeated call — the second click persists nothing new', () => {
    h.available = new Set(['claude', 'codex'])
    const { conn } = connFor(null)
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })
    // The store now holds what the first call wrote.
    h.disk = h.saved[0]
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })
    expect(h.saved).toHaveLength(1)
  })
})

describe('auto_configure_agents admin gate (admin-only)', () => {
  const KCTX = {} as never
  const H = '$scrypt$ln=15,r=8,p=1$s$h'

  function connFor(subject: string | null): { conn: Conn; sent: ServerToClient[] } {
    const sent: ServerToClient[] = []
    const conn: Conn = {
      send: (m) => sent.push(m),
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      authed: subject !== null,
      authToken: subject ? 'tok' : null,
      subject,
    }
    return { conn, sent }
  }

  beforeEach(() => {
    h.saved = []
    h.available = new Set(['claude'])
    // A live basic provider with admin 'alice' ⇒ the gate is active.
    h.disk = {
      ...base,
      auth: {
        enabled: true,
        provider: {
          kind: 'basic',
          accounts: [{ username: 'alice', passwordHash: H }],
          adminUsername: 'alice',
        },
        session: { ttlSeconds: 3600, signingKeyRef: 'k' },
      },
    }
  })

  it('refuses a non-admin — it writes system configuration, like save_settings', () => {
    const { conn, sent } = connFor('bob')
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
    expect(h.saved).toEqual([])
  })

  it('lets the admin through', () => {
    const { conn, sent } = connFor('alice')
    autoConfigureAgentsHandler(KCTX, conn, { type: 'auto_configure_agents' })
    expect(sent[0]).toMatchObject({ type: 'auto_configure_agents_result', created: 1 })
    expect(h.saved).toHaveLength(1)
  })
})
