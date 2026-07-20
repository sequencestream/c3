import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient, SystemSettings, VendorHostStatus } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

// Mock the config layer: saveSettings passes through, loadSettings returns a
// base shape (preserveBasicProvider reads disk auth, kept absent here).
const cfg = vi.hoisted(() => ({
  saved: null as unknown as SystemSettings,
}))
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

// Mock the launcher surface the settings handler imports: probeAll drives
// hostStatus, applyVendorCliChoices records the choices it received, and
// readVendorCliStatus returns the manifest summary the panel renders.
const lz = vi.hoisted(() => ({
  applied: null as unknown,
  status: {
    claude: {
      installedVersions: [{ version: '1.0.0', status: 'installed' as const }],
      activeVersion: '1.0.0',
      downloadTargetVersion: '1.3.0',
      lastRemoteCheckAt: '2026-07-09T00:00:00.000Z',
    },
    codex: { installedVersions: [] },
  },
}))
vi.mock('../../kernel/agent/process/launcher.js', () => ({
  probeAll: () =>
    [
      {
        vendor: 'claude',
        binary: 'claude',
        path: '/x/claude',
        source: 'managed',
        present: true,
        version: '1.0.0',
        expectedVersion: '1.0.0',
        compatibleRange: '>=0.0.0 <999.0.0',
        installHint: '',
      },
      {
        vendor: 'codex',
        binary: 'codex',
        path: null,
        source: 'missing',
        present: false,
        compatibleRange: '>=0.0.0 <999.0.0',
        installHint: 'install codex',
      },
    ] as never,
  applyVendorCliChoices: (choices: unknown) => {
    lz.applied = choices
  },
  readVendorCliStatus: (vendor: string) => (lz.status as never)[vendor as 'claude'],
}))

import { saveSettingsHandler } from './index.js'

const base = {
  agents: [],
  defaultAgentId: 'x',
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  automationAgentId: '',
  sandboxDefaultAgentId: '',
  sandboxToolAgentId: '',
  sandboxIntentAgentId: '',
  sandboxSpecAgentId: '',
  sandboxAutomationAgentId: '',
} as SystemSettings

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
  cfg.saved = { ...base }
  lz.applied = null
})

describe('save_settings vendor CLI sync (multi-version)', () => {
  const KCTX = {} as never

  it('applies the saved vendorCliVersions to the manifest and refreshes probe cache', () => {
    const { conn, sent } = connFor('admin')
    const draft: SystemSettings = { ...base, vendorCliVersions: { claude: '1.0.0' } }
    saveSettingsHandler(KCTX, conn, { type: 'save_settings', settings: draft })

    // applyVendorCliChoices received the saved choices.
    expect(lz.applied).toEqual({ claude: '1.0.0' })
    // The reply carries the multi-version status fields synthesized from the
    // manifest summary (readVendorCliStatus) merged with the probe.
    const reply = sent.find((m) => m.type === 'settings') as
      { hostStatus: VendorHostStatus[] } | undefined
    expect(reply).toBeTruthy()
    const claude = reply!.hostStatus.find((h) => h.vendor === 'claude')
    expect(claude?.activeVersion).toBe('1.0.0')
    expect(claude?.downloadTargetVersion).toBe('1.3.0')
    expect(claude?.installedVersions?.map((v) => v.version)).toEqual(['1.0.0'])
    expect(claude?.lastRemoteCheckAt).toBe('2026-07-09T00:00:00.000Z')
  })

  it('passes an empty choices object when vendorCliVersions is absent', () => {
    const { conn, sent } = connFor('admin')
    saveSettingsHandler(KCTX, conn, { type: 'save_settings', settings: { ...base } })
    expect(lz.applied).toEqual({})
    expect(sent.some((m) => m.type === 'settings')).toBe(true)
  })
})
