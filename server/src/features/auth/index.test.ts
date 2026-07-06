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

function capture(subject: string | null = null): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn: Conn = {
    send: (m) => sent.push(m),
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    authed: subject !== null,
    authToken: subject ? 'tok' : null,
    // The authenticated subject the admin gate (ADR-0023 authz) checks. Roster
    // mutations after an admin exists must run AS that admin.
    subject,
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
    specAgentId: '',
    automationAgentId: '',
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
  function setPw(
    msg: {
      username: string
      password: string
      currentPassword?: string
    },
    // Subject performing the op. `null` ⇒ bootstrap window (no admin yet, gate inert);
    // once an admin exists, the caller passes the admin's username.
    subject: string | null = null,
  ): ServerToClient[] {
    const { conn, sent } = capture(subject)
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
    setPw({ username: 'admin', password: 'oldpassword' }) // bootstrap
    expect(setPw({ username: 'admin', password: 'newpassword' }, 'admin')[0]).toMatchObject({
      result: { ok: false, code: 'not_authenticated' },
    })
    expect(
      setPw({ username: 'admin', password: 'newpassword', currentPassword: 'WRONG' }, 'admin')[0],
    ).toMatchObject({ result: { ok: false, code: 'not_authenticated' } })
    expect(
      setPw(
        { username: 'admin', password: 'newpassword', currentPassword: 'oldpassword' },
        'admin',
      )[0],
    ).toEqual({ type: 'admin_password_result', result: { ok: true } })
  })

  it('the admin adds a second account without proof; the admin is unchanged (AC2.2)', () => {
    setPw({ username: 'alice', password: 'alicepass' }) // bootstrap ⇒ alice is admin
    setPw({ username: 'bob', password: 'bobpass' }, 'alice')
    const p = basicProvider()
    expect(p.accounts.map((a) => a.username).sort()).toEqual(['alice', 'bob'])
    expect(p.adminUsername).toBe('alice')
  })

  it('changing one account password preserves the other accounts hashes (AC2.7)', () => {
    setPw({ username: 'alice', password: 'alicepass' }) // bootstrap
    setPw({ username: 'bob', password: 'bobpass' }, 'alice')
    const bobHashBefore = basicProvider().accounts.find((a) => a.username === 'bob')!.passwordHash
    setPw({ username: 'alice', password: 'newalice', currentPassword: 'alicepass' }, 'alice')
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
  // These cases all seed admin 'alice'; run the removals AS alice (the admin gate).
  function remove(username: string, subject: string | null = 'alice'): ServerToClient[] {
    const { conn, sent } = capture(subject)
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
  // Seeds admin 'alice'; reassignments are performed AS the current admin.
  function setAdmin(username: string, subject: string | null = 'alice'): ServerToClient[] {
    const { conn, sent } = capture(subject)
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
    // after reassignment, the former admin can be removed (AC4.2 unblocked) — now
    // by the NEW admin bob (the gate moved with the designation).
    const { conn, sent } = capture('bob')
    removeAccount(KCTX, conn, { type: 'remove_account', username: 'alice' })
    expect(sent[0]).toEqual({ type: 'account_op_result', result: { ok: true } })
  })
})

describe('admin gate on account-management handlers (ADR-0023 authz)', () => {
  const ADMIN_ONLY = { type: 'error', error: { code: 'auth.adminOnly' } }

  beforeEach(() => {
    // Two accounts, admin alice — a configured, enabled basic provider so the gate
    // is live (not in the bootstrap window).
    seedBasic(
      [
        { username: 'alice', password: 'alicepass' },
        { username: 'bob', password: 'bobpass' },
      ],
      'alice',
    )
  })

  /** Drive every roster-mutating handler with a connection carrying `subject`. */
  function mutateAs(subject: string | null): ServerToClient[][] {
    const add = capture(subject)
    setAdminPassword(KCTX, add.conn, {
      type: 'set_admin_password',
      username: 'carol',
      password: 'carolpass',
    })
    const rm = capture(subject)
    removeAccount(KCTX, rm.conn, { type: 'remove_account', username: 'bob' })
    const adm = capture(subject)
    setAdminAccount(KCTX, adm.conn, { type: 'set_admin_account', username: 'bob' })
    return [add.sent, rm.sent, adm.sent]
  }

  it('rejects an authenticated NON-admin (bob) with auth.adminOnly and mutates nothing', () => {
    for (const sent of mutateAs('bob')) expect(sent[0]).toEqual(ADMIN_ONLY)
    // Roster untouched: still exactly alice + bob, admin still alice.
    expect(
      basicProvider()
        .accounts.map((a) => a.username)
        .sort(),
    ).toEqual(['alice', 'bob'])
    expect(basicProvider().adminUsername).toBe('alice')
  })

  it('rejects an UNAUTHENTICATED connection (no subject) with auth.adminOnly', () => {
    for (const sent of mutateAs(null)) expect(sent[0]).toEqual(ADMIN_ONLY)
    expect(
      basicProvider()
        .accounts.map((a) => a.username)
        .sort(),
    ).toEqual(['alice', 'bob'])
    expect(basicProvider().adminUsername).toBe('alice')
  })

  it('admits the admin (alice): the mutations succeed', () => {
    const [add, rm, adm] = mutateAs('alice')
    expect(add[0]).toEqual({ type: 'admin_password_result', result: { ok: true } })
    expect(rm[0]).toEqual({ type: 'account_op_result', result: { ok: true } })
    // bob was just removed, so re-designating bob now reports not_found (the gate
    // passed; the failure is the roster-integrity check, not authz).
    expect(adm[0]).toMatchObject({ type: 'account_op_result', result: { ok: false } })
    // carol was added, bob removed.
    expect(
      basicProvider()
        .accounts.map((a) => a.username)
        .sort(),
    ).toEqual(['alice', 'carol'])
  })
})
