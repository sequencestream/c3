/**
 * Connection lifecycle + security tests for the one-click registration.
 *
 * The orchestration itself is replaced with a double; what is pinned here is
 * the per-connection ownership: admin gating before any task starts, one
 * active task per connection, progress/secret results ONLY to the initiating
 * connection, cancel by requestId, socket-close cleanup, and the dropped
 * late/mismatched frames after the task reference is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import {
  abortAppRegistrationForConn,
  cancelAppRegistration,
  cancelAppRegistrationHandler,
  startAppRegistration,
  startAppRegistrationHandler,
} from './app-registration.js'
import { runFeishuAppRegistration } from './providers/feishu/register.js'

const authStore = vi.hoisted(() => ({
  value: {
    agents: [],
    defaultAgentId: '',
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
    specReviewAgentId: '',
    automationAgentId: '',
    auth: {
      enabled: true,
      provider: { kind: 'basic', adminUsername: 'alice', accounts: [] },
      session: { ttlSeconds: 3600, signingKeyRef: 'k' },
    },
  },
}))

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => authStore.value,
  // The feishu provider module installs its SDK HTTP agent at import; give it
  // the proxy config it reads so the registry can load in the test.
  getProxyConfig: () => ({ enabled: false, httpProxy: '', httpsProxy: '' }),
}))

vi.mock('./providers/feishu/register.js', () => ({
  runFeishuAppRegistration: vi.fn(),
}))

const runMock = vi.mocked(runFeishuAppRegistration)

function makeConn(subject: string | null): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (msg: ServerToClient) => sent.push(msg),
    subject,
    authed: subject !== null,
    authToken: null,
    viewing: null,
    deliver: (msg: ServerToClient) => sent.push(msg),
    sendWorkspaces: () => {},
    sendSessions: async () => {},
  } as Conn
  return { conn, sent }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  runMock.mockReset()
  runMock.mockResolvedValue(undefined)
})

describe('app registration lifecycle', () => {
  it('refuses a non-admin start without touching the provider runner', async () => {
    const { conn, sent } = makeConn('bob')
    startAppRegistrationHandler({} as never, conn, {
      type: 'start_app_registration',
      requestId: 'req-1',
      platform: 'feishu',
    })
    expect(runMock).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'error', error: { code: 'auth.adminOnly' } }])
  })

  it('starts a task and delivers progress + credential result only to the initiator', async () => {
    const { conn, sent } = makeConn('alice')
    const { conn: other, sent: otherSent } = makeConn('alice')
    startAppRegistration(conn, 'feishu', 'req-1')
    const opts = runMock.mock.calls[0][0]
    opts.onProgress({ status: 'starting' })
    opts.onProgress({
      status: 'waiting_scan',
      verificationUrl: 'https://example.com/qr',
      expiresAt: 1234,
    })
    opts.onResult({ kind: 'ready', appId: 'cli_new', appSecret: 'new-secret' })
    await flush()

    expect(sent).toEqual([
      { type: 'app_registration_progress', requestId: 'req-1', status: 'starting' },
      {
        type: 'app_registration_progress',
        requestId: 'req-1',
        status: 'waiting_scan',
        verificationUrl: 'https://example.com/qr',
        expiresAt: 1234,
      },
      {
        type: 'app_registration_result',
        requestId: 'req-1',
        outcome: 'ready',
        appId: 'cli_new',
        appSecret: 'new-secret',
      },
    ])
    expect(otherSent).toEqual([])
  })

  it('refuses a duplicate start with server_error and runs a single task', async () => {
    const { conn, sent } = makeConn('alice')
    startAppRegistration(conn, 'feishu', 'req-1')
    startAppRegistrationHandler({} as never, conn, {
      type: 'start_app_registration',
      requestId: 'req-2',
      platform: 'feishu',
    })
    expect(runMock).toHaveBeenCalledTimes(1)
    expect(sent).toContainEqual({
      type: 'app_registration_result',
      requestId: 'req-2',
      outcome: 'failed',
      reason: 'server_error',
      detail: 'an app registration is already active on this connection',
    })
  })

  it('cancel aborts only the matching requestId and still delivers the cancelled result', async () => {
    const { conn, sent } = makeConn('alice')
    startAppRegistration(conn, 'feishu', 'req-1')
    const opts = runMock.mock.calls[0][0]

    // A wrong requestId is an idempotent no-op.
    cancelAppRegistration(conn, 'req-other')
    expect(opts.signal.aborted).toBe(false)

    cancelAppRegistration(conn, 'req-1')
    expect(opts.signal.aborted).toBe(true)
    opts.onResult({ kind: 'failed', reason: 'cancelled' })
    await flush()
    expect(sent).toContainEqual({
      type: 'app_registration_result',
      requestId: 'req-1',
      outcome: 'failed',
      reason: 'cancelled',
    })
  })

  it('socket close aborts the task and drops any later result frame', async () => {
    const { conn, sent } = makeConn('alice')
    startAppRegistration(conn, 'feishu', 'req-1')
    const opts = runMock.mock.calls[0][0]
    abortAppRegistrationForConn(conn)
    expect(opts.signal.aborted).toBe(true)

    const before = sent.length
    opts.onResult({ kind: 'ready', appId: 'cli_late', appSecret: 'late-secret' })
    await flush()
    expect(sent.slice(before)).toEqual([])
  })

  it('the wire cancel handler also enforces the admin gate', async () => {
    const { conn, sent } = makeConn('bob')
    cancelAppRegistrationHandler({} as never, conn, {
      type: 'cancel_app_registration',
      requestId: 'req-1',
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'auth.adminOnly' } }])
  })
})
