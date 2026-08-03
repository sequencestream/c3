import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  ServerToClient,
  SystemSettings,
  VendorId,
  VendorRuntimeStatus,
} from '@ccc/shared/protocol'
import { VENDOR_IDS } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

/**
 * The `settings` reply's neutral runtime-availability companion.
 *
 * Two runtimes back c3's vendors — a host CLI it spawns, and an SDK that ships
 * inside the process — and the console must be able to gate on "can this vendor
 * run" without knowing which is which. These tests pin exactly that: every
 * vendor answers, a CLI vendor's answer still comes from the CLI probe (no
 * change in meaning), and an SDK vendor's answer follows its module probe.
 */

const cfg = vi.hoisted(() => ({ saved: null as unknown as SystemSettings }))
vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => cfg.saved,
  saveSettings: (s: SystemSettings) => {
    cfg.saved = s
    return s
  },
  getSessionBindingStats: () => ({}),
  loadWorkspaceSetting: () => ({}),
  saveWorkspaceSetting: (_p: string, c: unknown) => c,
}))

// The CLI probe: claude resolves, codex does not.
vi.mock('../../kernel/agent/process/launcher.js', () => ({
  probeAll: () =>
    [
      {
        vendor: 'claude',
        binary: 'claude',
        path: '/x/claude',
        source: 'managed',
        compatibleRange: '',
        installHint: '',
      },
      {
        vendor: 'codex',
        binary: 'codex',
        path: null,
        source: 'missing',
        compatibleRange: '',
        installHint: 'install codex',
      },
    ] as never,
  applyVendorCliChoices: () => {},
  readVendorCliStatus: () => ({ installedVersions: [] }),
  isManagedVendor: (vendor: string) => vendor === 'claude' || vendor === 'codex',
}))

// The embedded-runtime registry: cursor's SDK resolvability is scripted per test.
const sdk = vi.hoisted(() => ({ available: true }))
vi.mock('../../kernel/agent/adapters/index.js', () => ({
  MODE_CATALOGS: { claude: {}, codex: {}, cursor: {} },
  EMBEDDED_RUNTIME_PROBES: {
    cursor: { module: '@cursor/sdk', available: () => sdk.available },
  },
}))

import { getSettings } from './index.js'

const base = {
  agents: [],
  defaultAgentId: 'x',
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  specReviewAgentId: '',
  automationAgentId: '',
} as SystemSettings

function conn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    conn: {
      send: (m) => sent.push(m),
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      authed: true,
      authToken: 'tok',
      subject: 'admin',
    },
    sent,
  }
}

function snapshot(): Record<VendorId, VendorRuntimeStatus> {
  const { conn: c, sent } = conn()
  getSettings({} as never, c, { type: 'get_settings' })
  const reply = sent.find((m) => m.type === 'settings') as
    { vendorRuntime?: Record<VendorId, VendorRuntimeStatus> } | undefined
  expect(reply?.vendorRuntime).toBeTruthy()
  return reply!.vendorRuntime!
}

beforeEach(() => {
  cfg.saved = { ...base }
  sdk.available = true
})

describe('settings — vendor runtime availability', () => {
  it('answers for every registered vendor', () => {
    const runtime = snapshot()
    expect(Object.keys(runtime).sort()).toEqual([...VENDOR_IDS].sort())
    for (const vendor of VENDOR_IDS) expect(runtime[vendor].vendor).toBe(vendor)
  })

  it('keeps claude/codex on their host-CLI probe result', () => {
    const runtime = snapshot()
    expect(runtime.claude).toEqual({
      vendor: 'claude',
      available: true,
      runtime: 'host-cli',
      runtimeId: 'claude',
    })
    expect(runtime.codex).toEqual({
      vendor: 'codex',
      available: false,
      runtime: 'host-cli',
      runtimeId: 'codex',
      reason: 'host-cli-missing',
    })
  })

  it('marks cursor available when its SDK resolves', () => {
    const runtime = snapshot()
    expect(runtime.cursor).toEqual({
      vendor: 'cursor',
      available: true,
      runtime: 'embedded-sdk',
      runtimeId: '@cursor/sdk',
    })
  })

  it('marks cursor unavailable with a stable reason code when the SDK does not resolve', () => {
    sdk.available = false
    const runtime = snapshot()
    expect(runtime.cursor).toEqual({
      vendor: 'cursor',
      available: false,
      runtime: 'embedded-sdk',
      runtimeId: '@cursor/sdk',
      reason: 'sdk-unresolved',
    })
    // The SDK's own availability must not leak into the CLI vendors' answers.
    expect(runtime.claude.available).toBe(true)
  })

  it('does not put an SDK-backed vendor into hostStatus', () => {
    const { conn: c, sent } = conn()
    getSettings({} as never, c, { type: 'get_settings' })
    const reply = sent.find((m) => m.type === 'settings') as {
      hostStatus: { vendor: VendorId }[]
    }
    expect(reply.hostStatus.map((h) => h.vendor)).toEqual(['claude', 'codex'])
  })
})
