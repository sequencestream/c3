import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Conn } from '../../transport/handler-registry.js'
import type { AuthConfig, SystemSettings } from '@ccc/shared/protocol'

// Swap the disk layer: `isAdminConn` reads the active auth block via loadSettings.
const h = vi.hoisted(() => ({ store: null as unknown as SystemSettings }))
vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => h.store,
}))

import { configuredAdmin, isAdminConn, requireAdmin } from './authz.js'

const SESSION = { ttlSeconds: 3600, signingKeyRef: 'k' }

/** A connection carrying `subject` (the only field the gate reads). */
function connFor(subject: string | null): Conn {
  return {
    send: () => {},
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    authed: subject !== null,
    authToken: subject ? 'tok' : null,
    subject,
  }
}

function basicAuth(adminUsername: string, enabled = true): AuthConfig {
  return {
    enabled,
    provider: {
      kind: 'basic',
      accounts: [{ username: 'alice', passwordHash: 'h' }],
      adminUsername,
    },
    session: SESSION,
  }
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

describe('configuredAdmin (provider-neutral admin resolution)', () => {
  it('returns null when auth is absent or disabled (no gate ⇒ loopback trust)', () => {
    expect(configuredAdmin(undefined)).toBeNull()
    expect(configuredAdmin(basicAuth('alice', false))).toBeNull()
  })

  it('returns the basic adminUsername, or null for the unconfigured shell', () => {
    expect(configuredAdmin(basicAuth('alice'))).toBe('alice')
    expect(configuredAdmin(basicAuth(''))).toBeNull()
  })

  it('returns the oauth adminEmail, or null for the unconfigured shell', () => {
    const oauth = (adminEmail: string): AuthConfig => ({
      enabled: true,
      provider: {
        kind: 'oauth',
        issuer: 'https://i',
        clientId: 'c',
        clientSecretRef: 'r',
        redirectUri: 'https://cb',
        scopes: [],
        usePkce: true,
        allowedEmails: ['a@x.com'],
        adminEmail,
      },
      session: SESSION,
    })
    expect(configuredAdmin(oauth('a@x.com'))).toBe('a@x.com')
    expect(configuredAdmin(oauth(''))).toBeNull()
  })

  it('returns null for the none provider (no admin concept)', () => {
    expect(
      configuredAdmin({ enabled: true, provider: { kind: 'none' }, session: SESSION }),
    ).toBeNull()
  })
})

describe('isAdminConn (the admin gate — three access classes)', () => {
  it('admits the unique admin under an enabled basic provider', () => {
    h.store.auth = basicAuth('alice')
    expect(isAdminConn(connFor('alice'))).toBe(true)
  })

  it('rejects an authenticated NON-admin', () => {
    h.store.auth = basicAuth('alice')
    expect(isAdminConn(connFor('bob'))).toBe(false)
  })

  it('rejects an UNAUTHENTICATED connection (no subject) when an admin is configured', () => {
    h.store.auth = basicAuth('alice')
    expect(isAdminConn(connFor(null))).toBe(false)
  })

  it('is inert (every local connection trusted) when auth is disabled', () => {
    h.store.auth = basicAuth('alice', false)
    expect(isAdminConn(connFor(null))).toBe(true)
    expect(isAdminConn(connFor('bob'))).toBe(true)
  })

  it('is inert during the basic bootstrap window (no admin configured yet)', () => {
    h.store.auth = basicAuth('') // enabled shell, adminUsername === ''
    expect(isAdminConn(connFor(null))).toBe(true)
  })

  it('oauth enforcement is deferred: inert while no subject can be resolved (contract-only)', () => {
    h.store.auth = {
      enabled: true,
      provider: {
        kind: 'oauth',
        issuer: 'https://i',
        clientId: 'c',
        clientSecretRef: 'r',
        redirectUri: 'https://cb',
        scopes: [],
        usePkce: true,
        allowedEmails: ['admin@x.com'],
        adminEmail: 'admin@x.com',
      },
      session: SESSION,
    }
    // No OAuth runtime ⇒ conn.subject is null ⇒ gate stays inert (trusted).
    expect(isAdminConn(connFor(null))).toBe(true)
    // But the comparison branch IS wired: the day the runtime binds a subject, a
    // non-admin email is rejected and the admin email is admitted.
    expect(isAdminConn(connFor('mallory@x.com'))).toBe(false)
    expect(isAdminConn(connFor('admin@x.com'))).toBe(true)
  })
})

describe('requireAdmin (guard helper)', () => {
  it('returns true and sends nothing for an authorized connection', () => {
    h.store.auth = basicAuth('alice')
    const sent: unknown[] = []
    const conn = { ...connFor('alice'), send: (m: unknown) => sent.push(m) }
    expect(requireAdmin(conn)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('returns false and emits the auth.adminOnly error for a non-admin', () => {
    h.store.auth = basicAuth('alice')
    const sent: unknown[] = []
    const conn = { ...connFor('bob'), send: (m: unknown) => sent.push(m) }
    expect(requireAdmin(conn)).toBe(false)
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
  })
})
