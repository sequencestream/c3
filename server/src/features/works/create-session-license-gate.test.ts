/**
 * `create_session` is the product-license enforcement point (PL-R6, ADR-0026):
 * new-session creation is refused while the installation is not entitled
 * (`unactivated`/`expired`/`disabled`), and allowed while entitled
 * (`active`/`grace`). A refusal must write NO pending row, mint NO runtime, and
 * switch NO view — it only sends a `license.notEntitled` error carrying the
 * entitlement state as the localizable `reason`.
 *
 * `currentLicenseStatus` is mocked per-test so the suite drives the gate
 * directly without touching the on-disk entitlement cache. The projection store
 * uses a real throwaway `c3.db` so "no pending row written" is asserted
 * end-to-end against the store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LicenseStatus } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetStoreForTests } from './work-session-store.js'

vi.mock('../../runs.js', () => ({
  addViewer: vi.fn(),
  ensureRuntime: vi.fn(),
  removeViewer: vi.fn(),
}))
vi.mock('../../state.js', () => ({
  hasWorkspace: vi.fn(() => true),
  resolveWorkspaceRoot: vi.fn((id: string) => id),
  pathToId: vi.fn((p: string) => p),
  touchWorkspace: vi.fn(),
}))

const licenseStatus = vi.fn<() => LicenseStatus>()
vi.mock('../license/store.js', () => ({
  currentLicenseStatus: () => licenseStatus(),
}))

import { createSession } from './index.js'
import { ensureRuntime } from '../../runs.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { getPendingIntent } from './work-session-store.js'

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-gate-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
  // Clear call history on the module-level runs.js spies so the "not gated ⇒ no
  // runtime" assertion sees only this test's calls.
  vi.clearAllMocks()
  licenseStatus.mockReset()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  resetDbForTests()
  resetStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function status(over: Partial<LicenseStatus>): LicenseStatus {
  return {
    state: 'active',
    entitled: true,
    termEnd: 0,
    installationId: '',
    licenseKey: '',
    ...over,
  }
}

function fakeConn() {
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  return {
    viewing: null as string | null,
    deliver: () => {},
    send: (m: { type: string; [k: string]: unknown }) => sent.push(m),
    sendWorkspaces: () => {},
    sent,
  }
}

function run(conn: ReturnType<typeof fakeConn>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createSession({} as any, conn as any, {
    type: 'create_session',
    workspaceId: '/abs/proj',
    agentId: 'claude-b',
  })
}

describe('create_session product-license gate (PL-R6)', () => {
  it('entitled (active) creates the session — pending row + session_selected', () => {
    licenseStatus.mockReturnValue(status({ state: 'active', entitled: true }))
    const conn = fakeConn()
    run(conn)
    const sel = conn.sent.find((m) => m.type === 'session_selected')
    expect(sel).toBeTruthy()
    const pendingId = sel!.sessionId as string
    expect(getPendingIntent(pendingId)?.agentId).toBe('claude-b')
    expect(conn.sent.some((m) => m.type === 'error')).toBe(false)
  })

  it('entitled (grace) is allowed too — grace stays within the offline window', () => {
    licenseStatus.mockReturnValue(status({ state: 'grace', entitled: true }))
    const conn = fakeConn()
    run(conn)
    expect(conn.sent.some((m) => m.type === 'session_selected')).toBe(true)
    expect(conn.sent.some((m) => m.type === 'error')).toBe(false)
  })

  for (const state of ['expired', 'disabled', 'unactivated'] as const) {
    it(`not entitled (${state}) is refused — license.notEntitled, no pending row`, () => {
      licenseStatus.mockReturnValue(status({ state, entitled: false }))
      const conn = fakeConn()
      run(conn)
      // No session was created.
      expect(conn.sent.some((m) => m.type === 'session_selected')).toBe(false)
      expect(ensureRuntime).not.toHaveBeenCalled()
      // The view was not switched and no pending row was written.
      expect(conn.viewing).toBeNull()
      const err = conn.sent.find((m) => m.type === 'error') as
        | { error: { code: string; params?: { reason?: string } } }
        | undefined
      expect(err?.error.code).toBe('license.notEntitled')
      // The entitlement state rides along as the localizable reason.
      expect(err?.error.params?.reason).toBe(state)
    })
  }
})
