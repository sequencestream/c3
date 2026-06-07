/**
 * `settings.sessionCapabilities` runtime overlay for OpenCode (2026-06-07-003).
 *
 * OpenCode's server-backed lifecycle ops (list/read/resume) are only as reachable
 * as its supervised REST server. When the first-class reachability signal is
 * `temporarily-unavailable`, the settings reply must downgrade those grades from
 * the SAME enum — so the console degrades opencode rows by *state*, recovering
 * automatically once the signal flips back to `full`. The IO-heavy collaborators
 * (config + launcher) are mocked; the real `opencode-status` singleton drives the
 * branch under test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionCapabilities, VendorId } from '@ccc/shared/protocol'

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn((s: unknown) => s),
  getSessionBindingStats: vi.fn(() => ({ bound: 0, pending: 0 })),
}))
vi.mock('../../kernel/agent/process/launcher.js', () => ({ probeAll: vi.fn(() => []) }))

import { getSettings } from './index.js'
import { setOpencodeStatus } from '../../opencode-status.js'

afterEach(() => {
  vi.clearAllMocks()
  setOpencodeStatus({ reachability: 'none', retrying: false })
})

function capsFromGetSettings(): Record<VendorId, SessionCapabilities> {
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  const conn = {
    viewing: null as string | null,
    deliver: () => {},
    send: (m: { type: string; [k: string]: unknown }) => sent.push(m),
    sendWorkspaces: () => {},
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettings({} as any, conn as any, { type: 'get_settings' })
  const reply = sent.find((m) => m.type === 'settings')
  return reply!.sessionCapabilities as Record<VendorId, SessionCapabilities>
}

describe('settings sessionCapabilities — opencode runtime overlay', () => {
  it('server temporarily-unavailable ⇒ opencode list/read/resume degrade to temporarily-unavailable', () => {
    setOpencodeStatus({ reachability: 'temporarily-unavailable', retrying: true })
    const caps = capsFromGetSettings()
    expect(caps.opencode.list).toBe('temporarily-unavailable')
    expect(caps.opencode.read).toBe('temporarily-unavailable')
    expect(caps.opencode.resume).toBe('temporarily-unavailable')
    // Other vendors are untouched by the opencode overlay.
    expect(caps.claude.list).toBe('full')
  })

  it('server full ⇒ opencode keeps its first-class grades', () => {
    setOpencodeStatus({ reachability: 'full', retrying: false, url: 'http://127.0.0.1:40000' })
    const caps = capsFromGetSettings()
    expect(caps.opencode.list).toBe('full')
    expect(caps.opencode.read).toBe('full')
    expect(caps.opencode.resume).toBe('full')
  })
})
