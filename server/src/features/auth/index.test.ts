import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Conn } from '../../transport/handler-registry.js'
import type { BasicAuthProvider, ServerToClient, SystemSettings } from '@ccc/shared/protocol'

// In-memory settings store, swapped in for the kernel/config disk layer.
const h = vi.hoisted(() => ({ store: null as unknown as SystemSettings }))
vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => h.store,
  saveSettings: (next: SystemSettings) => {
    h.store = next
    return next
  },
}))

import { login, setAdminPassword, removeAccount, setAdminAccount } from './index.js'
import { hashPassword } from './password.js'

function capture(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn: Conn = {
    send: (m) => sent.push(m),
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    authed: false,
    authToken: null,
  }
  return { conn, sent }
}

const KCTX = {} as never

/** Seed a basic auth block with the given accounts + admin (enabled per caller). */
function seedBasic(
  accounts: { username: string; password: string }[],
  adminUsername: string,
  enabled = true,
): void {
  h.store.auth = {
    enabled,
    provider: {
      kind: 'basic',
      accounts: accounts.map((a) => ({
        username: a.username,
        passwordHash: hashPassword(a.password),
      })),
      adminUsername,
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
  }
}

function basicProvider(): BasicAuthProvider {
  const p = h.store.auth?.provider
  if (p?.kind !== 'basic') throw new Error('not basic')
  return p
}

beforeEach(() => {
  h.store = {
    agents: [],
    defaultAgentId: 'x',
    toolAgentId: '',
    intentAgentId: '',
  } as SystemSettings
})

describe('login (ADR-0023 runtime, multi-account)', () => {
  it('replies auth_disabled when no auth block exists', () => {
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'pw' } })
    expect(sent[0]).toEqual({ type: 'login_result', result: { ok: false, code: 'auth_disabled' } })
  })

  it('replies auth_disabled when auth exists but is disabled', () => {
    seedBasic([{ username: 'admin', password: 'secret123' }], 'admin', false)
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'secret123' } })
    expect(sent[0]).toMatchObject({ result: { ok: false, code: 'auth_disabled' } })
  })

  it('rejects wrong password and unknown username with invalid_credentials', () => {
    seedBasic([{ username: 'admin', password: 'secret123' }], 'admin')
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'WRONG' } })
    expect(sent[0]).toMatchObject({ result: { ok: false, code: 'invalid_credentials' } })
    const c2 = capture()
    login(KCTX, c2.conn, { type: 'login', request: { username: 'nope', password: 'secret123' } })
    expect(c2.sent[0]).toMatchObject({ result: { ok: false, code: 'invalid_credentials' } })
  })

  it('accepts correct credentials and mints a token with a future expiry', () => {
    seedBasic([{ username: 'admin', password: 'secret123' }], 'admin')
    h.store.auth!.session.ttlSeconds = 60
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'secret123' } })
    const result = (sent[0] as Extract<ServerToClient, { type: 'login_result' }>).result
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.token).toMatch(/^[0-9a-f]{48}$/)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it('any account (admin or not) can sign in — no RBAC this phase', () => {
    // admin is alice; bob is a non-admin account, but still a valid login.
    seedBasic(
      [
        { username: 'alice', password: 'alicepass' },
        { username: 'bob', password: 'bobpass' },
      ],
      'alice',
    )
    const a = capture()
    login(KCTX, a.conn, { type: 'login', request: { username: 'alice', password: 'alicepass' } })
    expect((a.sent[0] as Extract<ServerToClient, { type: 'login_result' }>).result.ok).toBe(true)
    const b = capture()
    login(KCTX, b.conn, { type: 'login', request: { username: 'bob', password: 'bobpass' } })
    expect((b.sent[0] as Extract<ServerToClient, { type: 'login_result' }>).result.ok).toBe(true)
  })
})

describe('set_admin_password (ADR-0023, upsert account)', () => {
  function setPw(msg: {
    username: string
    password: string
    currentPassword?: string
  }): ServerToClient[] {
    const { conn, sent } = capture()
    setAdminPassword(KCTX, conn, { type: 'set_admin_password', ...msg })
    return sent
  }

  it('bootstrap: adds the first account, makes it admin, stores only a hash, derives enabled (AC3.4/AC3.5)', () => {
    const sent = setPw({ username: 'admin', password: 'secret123' })
    expect(sent[0]).toEqual({ type: 'admin_password_result', result: { ok: true } })
    const p = basicProvider()
    expect(p.accounts).toHaveLength(1)
    expect(p.accounts[0].username).toBe('admin')
    expect(p.adminUsername).toBe('admin')
    expect(p.accounts[0].passwordHash.startsWith('$scrypt$')).toBe(true)
    expect(JSON.stringify(h.store.auth)).not.toContain('secret123')
    // A configured admin ⇒ effectively enabled (AC3.5).
    expect(h.store.auth?.enabled).toBe(true)
  })

  it('rejects empty username or too-short password as invalid', () => {
    expect(setPw({ username: '  ', password: 'longenough' })[0]).toMatchObject({
      result: { ok: false, code: 'invalid' },
    })
    expect(setPw({ username: 'admin', password: 'ab' })[0]).toMatchObject({
      result: { ok: false, code: 'invalid' },
    })
  })

  it('change: requires the correct current password for that account', () => {
    setPw({ username: 'admin', password: 'oldpassword' })
    expect(setPw({ username: 'admin', password: 'newpassword' })[0]).toMatchObject({
      result: { ok: false, code: 'not_authenticated' },
    })
    expect(
      setPw({ username: 'admin', password: 'newpassword', currentPassword: 'WRONG' })[0],
    ).toMatchObject({ result: { ok: false, code: 'not_authenticated' } })
    expect(
      setPw({ username: 'admin', password: 'newpassword', currentPassword: 'oldpassword' })[0],
    ).toEqual({ type: 'admin_password_result', result: { ok: true } })
  })

  it('adds a second account without proof; the admin is unchanged (AC2.2)', () => {
    setPw({ username: 'alice', password: 'alicepass' })
    setPw({ username: 'bob', password: 'bobpass' })
    const p = basicProvider()
    expect(p.accounts.map((a) => a.username).sort()).toEqual(['alice', 'bob'])
    expect(p.adminUsername).toBe('alice')
  })

  it('changing one account password preserves the other accounts hashes (AC2.7)', () => {
    setPw({ username: 'alice', password: 'alicepass' })
    setPw({ username: 'bob', password: 'bobpass' })
    const bobHashBefore = basicProvider().accounts.find((a) => a.username === 'bob')!.passwordHash
    setPw({ username: 'alice', password: 'newalice', currentPassword: 'alicepass' })
    const bobHashAfter = basicProvider().accounts.find((a) => a.username === 'bob')!.passwordHash
    expect(bobHashAfter).toBe(bobHashBefore)
    // bob still logs in with the original password
    const b = capture()
    login(KCTX, b.conn, { type: 'login', request: { username: 'bob', password: 'bobpass' } })
    expect((b.sent[0] as Extract<ServerToClient, { type: 'login_result' }>).result.ok).toBe(true)
  })

  it('new credentials take effect immediately for login (acceptance #2)', () => {
    setPw({ username: 'admin', password: 'freshpass' })
    const { conn, sent } = capture()
    login(KCTX, conn, { type: 'login', request: { username: 'admin', password: 'freshpass' } })
    expect((sent[0] as Extract<ServerToClient, { type: 'login_result' }>).result.ok).toBe(true)
  })
})

describe('remove_account (ADR-0023, delete-account integrity)', () => {
  function remove(username: string): ServerToClient[] {
    const { conn, sent } = capture()
    removeAccount(KCTX, conn, { type: 'remove_account', username })
    return sent
  }

  it('replies not_found when the account is absent', () => {
    seedBasic([{ username: 'alice', password: 'a' }], 'alice')
    expect(remove('ghost')[0]).toMatchObject({ result: { ok: false, code: 'not_found' } })
  })

  it('removes a non-admin account and leaves the admin reference intact (AC4.1)', () => {
    seedBasic(
      [
        { username: 'alice', password: 'a' },
        { username: 'bob', password: 'b' },
      ],
      'alice',
    )
    expect(remove('bob')[0]).toEqual({ type: 'account_op_result', result: { ok: true } })
    const p = basicProvider()
    expect(p.accounts.map((a) => a.username)).toEqual(['alice'])
    expect(p.adminUsername).toBe('alice')
  })

  it('refuses to remove the admin while other accounts remain (AC4.2)', () => {
    seedBasic(
      [
        { username: 'alice', password: 'a' },
        { username: 'bob', password: 'b' },
      ],
      'alice',
    )
    expect(remove('alice')[0]).toMatchObject({ result: { ok: false, code: 'admin_must_reassign' } })
    // nothing changed
    expect(basicProvider().adminUsername).toBe('alice')
    expect(basicProvider().accounts).toHaveLength(2)
  })

  it('removing the admin when it is the only account empties the store (AC2.5)', () => {
    seedBasic([{ username: 'alice', password: 'a' }], 'alice')
    expect(remove('alice')[0]).toEqual({ type: 'account_op_result', result: { ok: true } })
    const p = basicProvider()
    expect(p.accounts).toHaveLength(0)
    expect(p.adminUsername).toBe('')
    // unconfigured ⇒ not enabled (AC3.5)
    expect(h.store.auth?.enabled).toBe(false)
  })
})

describe('set_admin_account (ADR-0023, reassign admin)', () => {
  function setAdmin(username: string): ServerToClient[] {
    const { conn, sent } = capture()
    setAdminAccount(KCTX, conn, { type: 'set_admin_account', username })
    return sent
  }

  it('replies not_found for an unknown username', () => {
    seedBasic([{ username: 'alice', password: 'a' }], 'alice')
    expect(setAdmin('ghost')[0]).toMatchObject({ result: { ok: false, code: 'not_found' } })
  })

  it('reassigns the admin to another existing account; stays enabled', () => {
    seedBasic(
      [
        { username: 'alice', password: 'a' },
        { username: 'bob', password: 'b' },
      ],
      'alice',
    )
    expect(setAdmin('bob')[0]).toEqual({ type: 'account_op_result', result: { ok: true } })
    expect(basicProvider().adminUsername).toBe('bob')
    expect(h.store.auth?.enabled).toBe(true)
    // after reassignment, the former admin can be removed (AC4.2 unblocked)
    const { conn, sent } = capture()
    removeAccount(KCTX, conn, { type: 'remove_account', username: 'alice' })
    expect(sent[0]).toEqual({ type: 'account_op_result', result: { ok: true } })
  })
})
