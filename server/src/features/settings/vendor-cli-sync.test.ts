import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient, SystemSettings, VendorId } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

/**
 * The manual npm-managed vendor CLI download / update check. The sync is stubbed
 * so the decision is tested on its own terms: whether a CLI is really installed on
 * the developer's machine must not decide whether this passes.
 */

const cfg = vi.hoisted(() => ({
  disk: null as unknown as SystemSettings,
}))

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => cfg.disk,
}))

// The settings frame re-probes host CLIs / sandbox / skill support — none of that
// is what this file is about, so the companion layer is stubbed flat, exactly as
// auto-configure-agents.test.ts does.
vi.mock('./index.js', () => ({
  settingsFrame: (settings: SystemSettings) => ({ type: 'settings', settings }),
}))

const lz = vi.hoisted(() => ({
  synced: [] as string[],
  syncCalls: 0,
  errors: [] as { vendor: string; message: string }[],
  npmManaged: new Set<string>(['claude', 'codex']),
  // The manifest summary `readVendorCliStatus` returns, keyed by vendor.
  status: {} as Record<
    string,
    { installedVersions: { version: string }[]; downloadTargetVersion?: string; lastError?: string }
  >,
  // What `syncManagedVendorCli` should resolve to (a probe), or reject with.
  syncResult: null as unknown,
  syncThrows: false,
  // Applied to `status[vendor]` synchronously when the sync starts, simulating
  // the manifest update the real sync writes before it resolves.
  afterStatus: null as null | {
    installedVersions: { version: string }[]
    downloadTargetVersion?: string
    lastError?: string
  },
}))

vi.mock('../../kernel/agent/process/launcher.js', () => ({
  isNpmManagedVendor: (v: string) => lz.npmManaged.has(v),
  readVendorCliStatus: (v: string) => (lz.status[v] ?? { installedVersions: [] }) as never,
  recordVendorCliSyncError: (v: string, m: string) => {
    lz.errors.push({ vendor: v, message: m })
  },
  syncManagedVendorCli: (v: string) => {
    lz.synced.push(v)
    lz.syncCalls++
    if (lz.afterStatus) lz.status[v] = lz.afterStatus
    if (lz.syncThrows) return Promise.reject(new Error(String(lz.syncResult)))
    if (lz.syncResult instanceof Promise) return lz.syncResult
    return Promise.resolve(lz.syncResult)
  },
}))

import { syncVendorCliHandler } from './sync-vendor-cli.js'

const base: SystemSettings = {
  agents: [],
  defaultAgentId: 'x',
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  specReviewAgentId: '',
  automationAgentId: '',
  reviewAgentId: '',
  fixAgentId: '',
}

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

function resultFrame(sent: ServerToClient[]) {
  return sent.find((m) => m.type === 'vendor_cli_sync_result') as
    | { vendor: VendorId; ok: boolean; version?: string; installed?: boolean; error?: string }
    | undefined
}

beforeEach(() => {
  cfg.disk = { ...base }
  lz.synced = []
  lz.syncCalls = 0
  lz.errors = []
  lz.syncThrows = false
  lz.syncResult = { vendor: 'claude', present: true, path: '/x/claude', version: '1.3.0' }
  lz.afterStatus = null
  lz.status = {
    claude: {
      installedVersions: [{ version: '1.0.0' }],
      downloadTargetVersion: '1.0.0',
    },
  }
})

describe('sync_vendor_cli handler — success', () => {
  const KCTX = {} as never

  it('calls the full sync and reports ok with the resolved download target and installed:true', async () => {
    lz.afterStatus = {
      installedVersions: [{ version: '1.0.0' }, { version: '1.3.0' }],
      downloadTargetVersion: '1.3.0',
    }
    const { conn, sent } = connFor('admin')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })

    expect(lz.synced).toEqual(['claude'])
    // settings first, then the result.
    expect(sent[0].type).toBe('settings')
    const result = resultFrame(sent)
    expect(result).toMatchObject({ vendor: 'claude', ok: true, version: '1.3.0', installed: true })
  })

  it('reports installed:false when the download target is unchanged and no version was gained', async () => {
    // After == before: already on the latest target, nothing new installed.
    lz.afterStatus = {
      installedVersions: [{ version: '1.0.0' }],
      downloadTargetVersion: '1.0.0',
    }
    const { conn, sent } = connFor('admin')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })

    const result = resultFrame(sent)
    expect(result).toMatchObject({ vendor: 'claude', ok: true, installed: false })
  })

  it('treats a gained version as installed even when the download target is unchanged', async () => {
    // "downloaded last time, install completed now": same target, but a new
    // installed version appears.
    lz.afterStatus = {
      installedVersions: [{ version: '1.0.0' }, { version: '1.3.0' }],
      downloadTargetVersion: '1.0.0',
    }
    const { conn, sent } = connFor('admin')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })

    const result = resultFrame(sent)
    expect(result).toMatchObject({ vendor: 'claude', ok: true, installed: true })
  })
})

describe('sync_vendor_cli handler — failure', () => {
  const KCTX = {} as never

  it('reports ok:false with the managedError and lastError source', async () => {
    lz.syncResult = {
      vendor: 'claude',
      present: false,
      path: null,
      managedError: 'managed claude install failed',
    }
    lz.afterStatus = {
      installedVersions: [{ version: '1.0.0' }],
      downloadTargetVersion: '1.3.0',
      lastError: 'managed claude install failed',
    }
    const { conn, sent } = connFor('admin')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })

    const result = resultFrame(sent)
    expect(result).toMatchObject({
      vendor: 'claude',
      ok: false,
      error: 'managed claude install failed',
    })
    expect(result?.installed).toBeUndefined()
    // The failed sync still refreshed the panel first.
    expect(sent[0].type).toBe('settings')
  })

  it('catches a thrown sync, records the error into the manifest and reports ok:false', async () => {
    lz.syncThrows = true
    lz.syncResult = 'no claude npm version satisfies >=0.0.0 <999.0.0'
    const { conn, sent } = connFor('admin')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })

    expect(lz.errors).toEqual([
      { vendor: 'claude', message: 'no claude npm version satisfies >=0.0.0 <999.0.0' },
    ])
    const result = resultFrame(sent)
    expect(result).toMatchObject({
      vendor: 'claude',
      ok: false,
      error: 'no claude npm version satisfies >=0.0.0 <999.0.0',
    })
  })
})

describe('sync_vendor_cli handler — gating', () => {
  const KCTX = {} as never
  const H = '$scrypt$ln=15,r=8,p=1$s$h'

  it('runs immediately even when the last remote check was just now (no cooldown read)', async () => {
    const { conn } = connFor('admin')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })
    // The handler never consults shouldCheckRemote — a manual trigger always runs.
    expect(lz.synced).toEqual(['claude'])
  })

  it('refuses a non-npm-managed vendor with no reply and no sync', async () => {
    const { conn, sent } = connFor('admin')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'cursor' })
    expect(lz.synced).toEqual([])
    expect(sent).toEqual([])
  })

  it('refuses a non-admin and never reaches the sync', async () => {
    cfg.disk = {
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
    const { conn, sent } = connFor('bob')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
    expect(lz.synced).toEqual([])
  })

  it('lets the admin through', async () => {
    cfg.disk = {
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
    const { conn, sent } = connFor('alice')
    await syncVendorCliHandler(KCTX, conn, { type: 'sync_vendor_cli', vendor: 'claude' })
    expect(lz.synced).toEqual(['claude'])
    expect(sent.some((m) => m.type === 'vendor_cli_sync_result')).toBe(true)
  })
})

describe('sync_vendor_cli handler — concurrent same-vendor merge', () => {
  const KCTX = {} as never

  function deferred<T>() {
    let resolve!: (v: T) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('a second trigger while one is in flight waits for the same result', async () => {
    const d = deferred<unknown>()
    lz.syncResult = d.promise
    lz.afterStatus = {
      installedVersions: [{ version: '1.0.0' }, { version: '1.3.0' }],
      downloadTargetVersion: '1.3.0',
    }

    const a = connFor('admin')
    const b = connFor('admin')
    const first = syncVendorCliHandler(KCTX, a.conn, { type: 'sync_vendor_cli', vendor: 'claude' })
    const second = syncVendorCliHandler(KCTX, b.conn, { type: 'sync_vendor_cli', vendor: 'claude' })

    // Only ONE download starts, even though two requests are in flight.
    expect(lz.syncCalls).toBe(1)
    expect(lz.synced).toEqual(['claude'])

    d.resolve({ vendor: 'claude', present: true, path: '/x/claude', version: '1.3.0' })
    await Promise.all([first, second])

    // Both connections got their own settings + result off the shared run.
    expect(a.sent.filter((m) => m.type === 'vendor_cli_sync_result')).toHaveLength(1)
    expect(b.sent.filter((m) => m.type === 'vendor_cli_sync_result')).toHaveLength(1)
    expect(resultFrame(a.sent)).toMatchObject({ ok: true, installed: true })
    expect(resultFrame(b.sent)).toMatchObject({ ok: true, installed: true })
  })
})
