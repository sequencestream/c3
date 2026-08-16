/**
 * Per-connection lifecycle of the workspace directory picker.
 *
 * The picker is the front door to `add_workspace`, so it carries the same
 * auth/admin gates. Beyond that, the contract worth pinning is ownership: a
 * chooser that was cancelled, superseded, or orphaned by a closed socket must
 * stay silent forever — it can neither answer a form it no longer belongs to nor
 * clear the slot of the run that replaced it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Conn } from '../../transport/handler-registry.js'
import type { ServerToClient, SystemSettings, AuthConfig } from '@ccc/shared/protocol'
import type { DirectoryChoice, DirectoryChooserRun } from './native-chooser.js'

const h = vi.hoisted(() => ({
  auth: undefined as AuthConfig | undefined,
  /** Every chooser started so far, newest last. */
  runs: [] as {
    settle: (choice: DirectoryChoice) => void
    aborted: boolean
    run: DirectoryChooserRun
  }[],
}))

vi.mock('./native-chooser.js', () => ({
  startDirectoryChooser: () => {
    let settle: (choice: DirectoryChoice) => void = () => {}
    const result = new Promise<DirectoryChoice>((resolve) => {
      settle = resolve
    })
    const entry = {
      settle,
      aborted: false,
      run: {
        result,
        abort: () => {
          entry.aborted = true
          // Mirrors the real adapter: an abort settles the run immediately.
          settle({ kind: 'cancelled' })
        },
      } as DirectoryChooserRun,
    }
    h.runs.push(entry)
    return entry.run
  },
}))
vi.mock('../../kernel/config/index.js', () => ({
  c3HomeDir: () => '/tmp/c3-picker-test',
  loadSettings: () => ({ auth: h.auth }) as SystemSettings,
}))

import {
  cancelWorkspaceDirectorySelectionHandler,
  releaseWorkspaceDirectoryPicker,
  selectWorkspaceDirectoryHandler,
} from './directory-picker.js'

const SESSION = { ttlSeconds: 3600, signingKeyRef: 'k' }
function basicAuth(admin: string): AuthConfig {
  return {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: [
        { username: admin, passwordHash: 'x' },
        { username: 'alice', passwordHash: 'x' },
      ],
      adminUsername: admin,
    },
    session: SESSION,
  }
}

function capture(
  authed = true,
  subject: string | null = null,
): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn: Conn = {
    send: (m) => sent.push(m),
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    authed,
    authToken: authed ? 'tok' : null,
    subject,
  }
  return { conn, sent }
}

const KCTX = { broadcastStatuses: () => {} } as never

const select = (conn: Conn, requestId: string): void | Promise<void> =>
  selectWorkspaceDirectoryHandler(KCTX, conn, { type: 'select_workspace_directory', requestId })
const cancel = (conn: Conn, requestId: string): void | Promise<void> =>
  cancelWorkspaceDirectorySelectionHandler(KCTX, conn, {
    type: 'cancel_workspace_directory_selection',
    requestId,
  })

/** Let the chooser's completion callback (a microtask chain) reach `conn.send`. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  h.auth = undefined
  h.runs = []
})

describe('picker auth and admin gates', () => {
  it('refuses an unauthenticated connection and starts no chooser', () => {
    const { conn, sent } = capture(false)
    select(conn, 'r1')
    expect(sent[0]).toEqual({ type: 'unauthenticated', reason: 'missing' })
    expect(h.runs).toHaveLength(0)
  })

  it('refuses a non-admin member with auth.adminOnly and starts no chooser', () => {
    h.auth = basicAuth('admin')
    const { conn, sent } = capture(true, 'alice')
    select(conn, 'r1')
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
    expect(h.runs).toHaveLength(0)
  })

  it('admits the configured admin', () => {
    h.auth = basicAuth('admin')
    const { conn, sent } = capture(true, 'admin')
    select(conn, 'r1')
    expect(sent).toEqual([])
    expect(h.runs).toHaveLength(1)
  })

  it('admits any authenticated connection when no admin gate applies', () => {
    const { conn } = capture(true)
    select(conn, 'r1')
    expect(h.runs).toHaveLength(1)
  })
})

describe('correlated replies', () => {
  it('answers a selection with the chosen absolute path', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    h.runs[0].settle({ kind: 'selected', path: '/abs/proj' })
    await flush()
    expect(sent).toEqual([
      {
        type: 'workspace_directory_selection',
        requestId: 'r1',
        result: { kind: 'selected', path: '/abs/proj' },
      },
    ])
  })

  it('answers a native dismissal as cancelled, with no error', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    h.runs[0].settle({ kind: 'cancelled' })
    await flush()
    expect(sent).toEqual([
      { type: 'workspace_directory_selection', requestId: 'r1', result: { kind: 'cancelled' } },
    ])
  })

  it('maps a launch failure to an opaque code and keeps the diagnostic off the wire', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { conn, sent } = capture()
    select(conn, 'r1')
    h.runs[0].settle({ kind: 'failed', detail: 'zenity ENOENT' })
    await flush()
    expect(sent).toEqual([
      {
        type: 'workspace_directory_selection',
        requestId: 'r1',
        result: { kind: 'failed', error: { code: 'workspace.directoryPickerFailed' } },
      },
    ])
    expect(JSON.stringify(sent)).not.toContain('zenity')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('replies at most once per request', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    h.runs[0].settle({ kind: 'selected', path: '/abs/proj' })
    await flush()
    h.runs[0].settle({ kind: 'selected', path: '/other' })
    await flush()
    expect(sent).toHaveLength(1)
  })
})

describe('cancellation by the client', () => {
  it('aborts the chooser, frees the slot, and suppresses the reply', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    cancel(conn, 'r1')
    await flush()
    expect(h.runs[0].aborted).toBe(true)
    expect(sent).toEqual([])
  })

  it('lets the next request start immediately after a cancel', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    cancel(conn, 'r1')
    select(conn, 'r2')
    h.runs[1].settle({ kind: 'selected', path: '/abs/next' })
    await flush()
    expect(sent).toEqual([
      {
        type: 'workspace_directory_selection',
        requestId: 'r2',
        result: { kind: 'selected', path: '/abs/next' },
      },
    ])
  })

  it('ignores a cancel that does not own the active slot', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    cancel(conn, 'stale')
    expect(h.runs[0].aborted).toBe(false)
    h.runs[0].settle({ kind: 'selected', path: '/abs/proj' })
    await flush()
    expect(sent).toHaveLength(1)
  })

  it('is inert for a connection that is not authorized', () => {
    h.auth = basicAuth('admin')
    const { conn: admin } = capture(true, 'admin')
    select(admin, 'r1')
    const { conn: alice } = capture(true, 'alice')
    cancel(alice, 'r1')
    expect(h.runs[0].aborted).toBe(false)
  })
})

describe('a superseding request', () => {
  it('aborts the old chooser before launching the new one', () => {
    const { conn } = capture()
    select(conn, 'r1')
    select(conn, 'r2')
    expect(h.runs[0].aborted).toBe(true)
    expect(h.runs).toHaveLength(2)
  })

  it('does not fail the new request just because the old dialog was open', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    select(conn, 'r2')
    h.runs[1].settle({ kind: 'selected', path: '/abs/second' })
    await flush()
    expect(sent).toEqual([
      {
        type: 'workspace_directory_selection',
        requestId: 'r2',
        result: { kind: 'selected', path: '/abs/second' },
      },
    ])
  })

  it('drops a late answer from the superseded chooser', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    select(conn, 'r2')
    h.runs[0].settle({ kind: 'selected', path: '/abs/stale' })
    await flush()
    expect(sent).toEqual([])
    // …and the replacement still owns its slot and can answer.
    h.runs[1].settle({ kind: 'selected', path: '/abs/fresh' })
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ requestId: 'r2' })
  })

  it('keeps each connection on its own slot', async () => {
    const a = capture()
    const b = capture()
    select(a.conn, 'a1')
    select(b.conn, 'b1')
    expect(h.runs[0].aborted).toBe(false)
    h.runs[0].settle({ kind: 'selected', path: '/abs/a' })
    h.runs[1].settle({ kind: 'selected', path: '/abs/b' })
    await flush()
    expect(a.sent).toMatchObject([{ requestId: 'a1' }])
    expect(b.sent).toMatchObject([{ requestId: 'b1' }])
  })
})

describe('connection teardown', () => {
  it('aborts the chooser and sends nothing to the dead socket', async () => {
    const { conn, sent } = capture()
    select(conn, 'r1')
    releaseWorkspaceDirectoryPicker(conn)
    await flush()
    expect(h.runs[0].aborted).toBe(true)
    expect(sent).toEqual([])
  })

  it('is a no-op for a connection that never opened a picker', () => {
    const { conn } = capture()
    expect(() => releaseWorkspaceDirectoryPicker(conn)).not.toThrow()
  })
})

describe('event-loop safety', () => {
  it('returns before the chooser settles, so other frames keep flowing', async () => {
    const { conn, sent } = capture()
    const other = capture()
    // A chooser left open on the host…
    select(conn, 'r1')
    // …must not stop another connection from being served.
    select(other.conn, 'r2')
    h.runs[1].settle({ kind: 'selected', path: '/abs/other' })
    await flush()
    expect(other.sent).toHaveLength(1)
    expect(sent).toEqual([])
  })
})
