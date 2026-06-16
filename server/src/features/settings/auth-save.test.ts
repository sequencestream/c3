import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient, SystemSettings } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'

// Stub the disk layer: preserveBasicProvider reads the on-disk auth provider.
const h = vi.hoisted(() => ({ disk: null as unknown as SystemSettings }))
vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => h.disk,
  saveSettings: (s: SystemSettings) => s,
  getSessionBindingStats: () => ({}),
  loadWorkspaceSetting: () => ({}),
  saveWorkspaceSetting: (_p: string, c: unknown) => c,
}))

import { preserveBasicProvider, validateAuthForSave, saveSettingsHandler } from './index.js'

const H = '$scrypt$ln=15,r=8,p=1$s$h'
const base = {
  agents: [],
  defaultAgentId: 'x',
  toolAgentId: '',
  intentAgentId: '',
} as SystemSettings

beforeEach(() => {
  h.disk = { ...base }
})

describe('preserveBasicProvider (AUTH-R7 multi-account)', () => {
  it('restores the entire basic provider from disk — a stale client draft cannot mutate accounts/admin', () => {
    h.disk = {
      ...base,
      auth: {
        enabled: true,
        provider: {
          kind: 'basic',
          accounts: [
            { username: 'alice', passwordHash: H },
            { username: 'bob', passwordHash: H },
          ],
          adminUsername: 'alice',
        },
        session: { ttlSeconds: 3600, signingKeyRef: 'k' },
      },
    }
    // Client tries to wipe accounts + change admin via save_settings.
    const draft: SystemSettings = {
      ...base,
      auth: {
        enabled: true,
        provider: { kind: 'basic', accounts: [], adminUsername: 'bob' },
        session: { ttlSeconds: 3600, signingKeyRef: 'k' },
      },
    }
    const out = preserveBasicProvider(draft)
    if (out.auth?.provider.kind !== 'basic') throw new Error('expected basic')
    expect(out.auth.provider.accounts.map((a) => a.username)).toEqual(['alice', 'bob'])
    expect(out.auth.provider.adminUsername).toBe('alice')
  })

  it('keeps the fresh empty shell when switching none → basic (disk is not basic)', () => {
    h.disk = { ...base } // no auth on disk
    const draft: SystemSettings = {
      ...base,
      auth: {
        enabled: false,
        provider: { kind: 'basic', accounts: [], adminUsername: '' },
        session: { ttlSeconds: 3600, signingKeyRef: 'k' },
      },
    }
    const out = preserveBasicProvider(draft)
    expect(out.auth?.provider).toEqual({ kind: 'basic', accounts: [], adminUsername: '' })
  })

  it('passes non-basic drafts through untouched', () => {
    const draft: SystemSettings = {
      ...base,
      auth: {
        enabled: false,
        provider: { kind: 'none' },
        session: { ttlSeconds: 3600, signingKeyRef: 'k' },
      },
    }
    expect(preserveBasicProvider(draft)).toBe(draft)
  })
})

describe('validateAuthForSave (oauth admin ∈ allowedEmails — AC5.3)', () => {
  function oauth(adminEmail: string, allowedEmails: string[]): SystemSettings {
    return {
      ...base,
      auth: {
        enabled: false,
        provider: {
          kind: 'oauth',
          issuer: 'https://i',
          clientId: 'c',
          clientSecretRef: 'r',
          redirectUri: 'https://cb',
          scopes: [],
          usePkce: true,
          allowedEmails,
          adminEmail,
        },
        session: { ttlSeconds: 3600, signingKeyRef: 'k' },
      },
    }
  }

  it('accepts an adminEmail that is in the allowlist', () => {
    expect(validateAuthForSave(oauth('a@x.com', ['a@x.com', 'b@x.com']))).toBeNull()
  })

  it('rejects an empty adminEmail', () => {
    expect(validateAuthForSave(oauth('', ['a@x.com']))).toBe('auth.oauthAdminInvalid')
  })

  it('rejects an adminEmail absent from the allowlist', () => {
    expect(validateAuthForSave(oauth('mallory@evil.com', ['a@x.com']))).toBe(
      'auth.oauthAdminInvalid',
    )
  })

  it('does not constrain basic / none providers', () => {
    expect(validateAuthForSave({ ...base })).toBeNull()
    const basic: SystemSettings = {
      ...base,
      auth: {
        enabled: true,
        provider: {
          kind: 'basic',
          accounts: [{ username: 'a', passwordHash: H }],
          adminUsername: 'a',
        },
        session: { ttlSeconds: 3600, signingKeyRef: 'k' },
      },
    }
    expect(validateAuthForSave(basic)).toBeNull()
  })
})

describe('save_settings admin gate (ADR-0023 authz)', () => {
  const KCTX = {} as never

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
    // A live, enabled basic provider with admin 'alice' ⇒ the gate is active.
    h.disk = {
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
  })

  it('rejects a non-admin save with auth.adminOnly (no settings frame)', () => {
    const { conn, sent } = connFor('bob')
    saveSettingsHandler(KCTX, conn, { type: 'save_settings', settings: { ...base } })
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
    expect(sent.some((m) => m.type === 'settings')).toBe(false)
  })

  it('rejects an unauthenticated save with auth.adminOnly', () => {
    const { conn, sent } = connFor(null)
    saveSettingsHandler(KCTX, conn, { type: 'save_settings', settings: { ...base } })
    expect(sent[0]).toEqual({ type: 'error', error: { code: 'auth.adminOnly' } })
  })
})
