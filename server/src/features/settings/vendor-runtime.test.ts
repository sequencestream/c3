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
 * The console gates on "can this vendor run" without knowing anything about how
 * a given vendor is distributed. These tests pin exactly that: every vendor
 * answers, each answer comes from the CLI probe, and the provenance a row shows
 * is derived from where the binary resolved.
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

// The CLI probe: claude and cursor resolve, codex does not. cursor's presence is
// scripted per test, because it is the vendor c3 does not distribute.
const cursorCli = vi.hoisted(() => ({ present: true }))
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
      cursorCli.present
        ? {
            vendor: 'cursor',
            binary: 'cursor-agent',
            path: '/home/u/.local/bin/cursor-agent',
            source: 'host-path-fallback',
            compatibleRange: '',
            installHint: '',
          }
        : {
            vendor: 'cursor',
            binary: 'cursor-agent',
            path: null,
            source: 'missing',
            compatibleRange: '',
            installHint: 'install cursor-agent',
          },
    ] as never,
  applyVendorCliChoices: () => {},
  readVendorCliStatus: () => ({ installedVersions: [] }),
  isManagedVendor: (vendor: string) =>
    vendor === 'claude' || vendor === 'codex' || vendor === 'cursor',
}))

vi.mock('../../kernel/agent/adapters/index.js', () => ({
  MODE_CATALOGS: { claude: {}, codex: {}, cursor: {} },
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
  cursorCli.present = true
})

describe('settings — vendor runtime availability', () => {
  it('answers for every registered vendor', () => {
    const runtime = snapshot()
    expect(Object.keys(runtime).sort()).toEqual([...VENDOR_IDS].sort())
    for (const vendor of VENDOR_IDS) expect(runtime[vendor].vendor).toBe(vendor)
  })

  it('keeps every vendor on its host-CLI probe result', () => {
    const runtime = snapshot()
    expect(runtime.claude).toEqual({
      vendor: 'claude',
      available: true,
      runtime: 'host-cli',
      runtimeId: 'claude',
      origin: 'installed',
      location: '/x/claude',
    })
    expect(runtime.codex).toEqual({
      vendor: 'codex',
      available: false,
      runtime: 'host-cli',
      runtimeId: 'codex',
      reason: 'host-cli-missing',
    })
  })

  it('says where a vendor-distributed CLI was found', () => {
    const runtime = snapshot()
    expect(runtime.cursor).toEqual({
      vendor: 'cursor',
      available: true,
      runtime: 'host-cli',
      runtimeId: 'cursor-agent',
      // Found on PATH rather than installed by c3 — the honest provenance for a
      // CLI c3 launches but does not distribute.
      origin: 'host-path',
      location: '/home/u/.local/bin/cursor-agent',
    })
  })

  it('marks a vendor unavailable with a stable reason code when its CLI is missing', () => {
    cursorCli.present = false
    const runtime = snapshot()
    expect(runtime.cursor).toEqual({
      vendor: 'cursor',
      available: false,
      runtime: 'host-cli',
      runtimeId: 'cursor-agent',
      reason: 'host-cli-missing',
    })
    // One vendor's absence must not leak into another's answer.
    expect(runtime.claude.available).toBe(true)
  })

  it('reports every host CLI in hostStatus', () => {
    const { conn: c, sent } = conn()
    getSettings({} as never, c, { type: 'get_settings' })
    const reply = sent.find((m) => m.type === 'settings') as {
      hostStatus: { vendor: VendorId }[]
    }
    expect(reply.hostStatus.map((h) => h.vendor)).toEqual(['claude', 'codex', 'cursor'])
  })
})
