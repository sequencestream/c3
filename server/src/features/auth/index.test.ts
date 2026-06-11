import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Conn } from '../../transport/handler-registry.js'
import type { ServerToClient, SystemSettings } from '@ccc/shared/protocol'

// In-memory settings store, swapped in for the kernel/config disk layer.
const h = vi.hoisted(() => ({ store: null as unknown as SystemSettings }))
vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => h.store,
  saveSettings: (next: SystemSettings) => {
    h.store = next
    return next
  },
}))

import { login, setAdminPassword } from './index.js'
import { hashPassword } from './password.js'

function capture(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn: Conn = {
    send: (m) => sent.push(m),
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
  }
  return { conn, sent }
}

const KCTX = {} as never

beforeEach(() => {
  h.store = { agents: [], defaultAgentId: 'x' } as SystemSettings
})

describe('login (ADR-0023 runtime)', () => {
  it('replies auth_disabled when no auth block exists', () => {
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'pw' } })
    expect(sent[0]).toEqual({ type: 'login_result', result: { ok: false, code: 'auth_disabled' } })
  })

  it('replies auth_disabled when auth exists but is disabled', () => {
    h.store.auth = {
      enabled: false,
      provider: { kind: 'basic', username: 'admin', passwordHash: hashPassword('secret123') },
      session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
    }
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'secret123' } })
    expect(sent[0]).toMatchObject({ result: { ok: false, code: 'auth_disabled' } })
  })

  it('rejects wrong credentials with invalid_credentials', () => {
    h.store.auth = {
      enabled: true,
      provider: { kind: 'basic', username: 'admin', passwordHash: hashPassword('secret123') },
      session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
    }
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'WRONG' } })
    expect(sent[0]).toMatchObject({ result: { ok: false, code: 'invalid_credentials' } })
    // wrong username too
    const c2 = capture()
    login(KCTX, c2.conn, { type: 'login', request: { username: 'nope', password: 'secret123' } })
    expect(c2.sent[0]).toMatchObject({ result: { ok: false, code: 'invalid_credentials' } })
  })

  it('accepts correct credentials and mints a token with a future expiry', () => {
    h.store.auth = {
      enabled: true,
      provider: { kind: 'basic', username: 'admin', passwordHash: hashPassword('secret123') },
      session: { ttlSeconds: 60, signingKeyRef: 'C3_AUTH_KEY' },
    }
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'secret123' } })
    const result = (sent[0] as Extract<ServerToClient, { type: 'login_result' }>).result
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token).toMatch(/^[0-9a-f]{48}$/)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    }
  })
})

describe('set_admin_password (ADR-0023 runtime)', () => {
  function setPw(msg: {
    username: string
    password: string
    currentPassword?: string
  }): ServerToClient[] {
    const { conn, sent } = capture()
    setAdminPassword(KCTX, conn, { type: 'set_admin_password', ...msg })
    return sent
  }

  it('bootstrap: sets credentials with no current password and stores only a hash', () => {
    const sent = setPw({ username: 'admin', password: 'secret123' })
    expect(sent[0]).toEqual({ type: 'admin_password_result', result: { ok: true } })
    const provider = h.store.auth?.provider
    expect(provider).toMatchObject({ kind: 'basic', username: 'admin' })
    expect(provider?.kind === 'basic' && provider.passwordHash.startsWith('$scrypt$')).toBe(true)
    expect(JSON.stringify(h.store.auth)).not.toContain('secret123')
    // bootstrap does not auto-enable auth
    expect(h.store.auth?.enabled).toBe(false)
  })

  it('rejects empty username or too-short password as invalid', () => {
    expect(setPw({ username: '  ', password: 'longenough' })[0]).toMatchObject({
      result: { ok: false, code: 'invalid' },
    })
    expect(setPw({ username: 'admin', password: 'ab' })[0]).toMatchObject({
      result: { ok: false, code: 'invalid' },
    })
  })

  it('change: requires the correct current password once an admin exists', () => {
    setPw({ username: 'admin', password: 'oldpassword' })
    // missing current password
    expect(setPw({ username: 'admin', password: 'newpassword' })[0]).toMatchObject({
      result: { ok: false, code: 'not_authenticated' },
    })
    // wrong current password
    expect(
      setPw({ username: 'admin', password: 'newpassword', currentPassword: 'WRONG' })[0],
    ).toMatchObject({ result: { ok: false, code: 'not_authenticated' } })
    // correct current password
    expect(
      setPw({ username: 'admin', password: 'newpassword', currentPassword: 'oldpassword' })[0],
    ).toEqual({ type: 'admin_password_result', result: { ok: true } })
  })

  it('new credentials take effect immediately for login (acceptance #2)', () => {
    // bootstrap, then enable auth (the panel toggle would do this via save_settings)
    setPw({ username: 'admin', password: 'freshpass' })
    h.store.auth!.enabled = true
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'freshpass' } })
    expect((sent[0] as Extract<ServerToClient, { type: 'login_result' }>).result.ok).toBe(true)
  })
})
