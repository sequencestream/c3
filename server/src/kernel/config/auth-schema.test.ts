import { describe, it, expect } from 'vitest'
import type { AuthConfig } from '@ccc/shared/protocol'
import {
  authConfigSchema,
  normalizeAuth,
  deriveBasicEnabled,
  migrateLegacySessionTtl,
  DEFAULT_SESSION_TTL_SECONDS,
  LEGACY_DEFAULT_SESSION_TTL_SECONDS,
} from './auth-schema.js'

/**
 * Contract tests for the ADR-0023 auth config schema (multi-account basic +
 * unique admin). They guard: a valid basic config parses; an absent/malformed
 * block fails-soft to `null` (⇒ "no auth"); legacy single-account migration;
 * the unique-username + admin-reference invariants; `enabled` derivation; and the
 * oauth adminEmail handling (normalize does NOT drop on invalid adminEmail).
 */
describe('auth-schema', () => {
  const HASH = '$scrypt$ln=15,r=8,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'
  // A complete, valid basic config: one account, designated admin, enabled.
  const validBasic: AuthConfig = {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: [{ username: 'admin', passwordHash: HASH }],
      adminUsername: 'admin',
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_SIGNING_KEY' },
    exposure: { bindAddress: '0.0.0.0' },
  }

  it('parses a valid basic config', () => {
    expect(authConfigSchema.safeParse(validBasic).success).toBe(true)
    expect(normalizeAuth(validBasic)).toEqual(validBasic)
  })

  it('accepts a minimal config without the optional exposure block', () => {
    const minimal: AuthConfig = {
      enabled: true,
      provider: {
        kind: 'basic',
        accounts: [{ username: 'a', passwordHash: HASH }],
        adminUsername: 'a',
      },
      session: { ttlSeconds: 900, signingKeyRef: 'keyref' },
    }
    expect(normalizeAuth(minimal)).toEqual(minimal)
  })

  it('fails soft to null for an absent block (⇒ no auth, C-SEC-5 default)', () => {
    expect(normalizeAuth(undefined)).toBeNull()
    expect(normalizeAuth(null)).toBeNull()
  })

  it('rejects an unknown provider kind', () => {
    const unknownKind = { ...validBasic, provider: { kind: 'ldap', host: 'x' } }
    expect(authConfigSchema.safeParse(unknownKind).success).toBe(false)
    expect(normalizeAuth(unknownKind)).toBeNull()
  })

  it('rejects a config missing the session policy', () => {
    const noSession = { enabled: true, provider: validBasic.provider }
    expect(normalizeAuth(noSession)).toBeNull()
  })

  it('rejects a non-boolean enabled flag', () => {
    expect(normalizeAuth({ ...validBasic, enabled: 'yes' })).toBeNull()
  })

  // ---- multi-account invariants (AC2.1 / AC3.1 / AC3.3) ----
  describe('basic multi-account invariants', () => {
    it('drops a config whose adminUsername references no account (AC3.3)', () => {
      const dangling = {
        ...validBasic,
        provider: {
          kind: 'basic',
          accounts: [{ username: 'a', passwordHash: HASH }],
          adminUsername: 'ghost',
        },
      }
      expect(normalizeAuth(dangling)).toBeNull()
    })

    it('drops a config with non-empty accounts but an empty adminUsername (AC3.1)', () => {
      const noAdmin = {
        ...validBasic,
        provider: {
          kind: 'basic',
          accounts: [{ username: 'a', passwordHash: HASH }],
          adminUsername: '',
        },
      }
      expect(normalizeAuth(noAdmin)).toBeNull()
    })

    it('drops a config with duplicate usernames (AC2.1)', () => {
      const dup = {
        ...validBasic,
        provider: {
          kind: 'basic',
          accounts: [
            { username: 'a', passwordHash: HASH },
            { username: 'a', passwordHash: HASH },
          ],
          adminUsername: 'a',
        },
      }
      expect(normalizeAuth(dup)).toBeNull()
    })

    it('accepts an empty accounts set as the unconfigured state (AC2.5)', () => {
      const empty = {
        enabled: false,
        provider: { kind: 'basic', accounts: [], adminUsername: '' },
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      const n = normalizeAuth(empty)
      expect(n?.provider).toEqual({ kind: 'basic', accounts: [], adminUsername: '' })
      expect(n?.enabled).toBe(false)
    })

    it('case-sensitive usernames are distinct (AC2.1)', () => {
      const cased = {
        ...validBasic,
        provider: {
          kind: 'basic',
          accounts: [
            { username: 'Admin', passwordHash: HASH },
            { username: 'admin', passwordHash: HASH },
          ],
          adminUsername: 'Admin',
        },
      }
      expect(normalizeAuth(cased)).not.toBeNull()
    })
  })

  // ---- enabled derivation (AC3.5) ----
  describe('enabled derivation', () => {
    it('derives true for a configured admin even if disk says enabled:false', () => {
      const stale = { ...validBasic, enabled: false }
      expect(normalizeAuth(stale)?.enabled).toBe(true)
    })

    it('derives false for an empty account set even if disk says enabled:true', () => {
      const empty = {
        enabled: true,
        provider: { kind: 'basic', accounts: [], adminUsername: '' },
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      expect(normalizeAuth(empty)?.enabled).toBe(false)
    })

    it('deriveBasicEnabled: true iff accounts non-empty and admin references one', () => {
      expect(deriveBasicEnabled({ kind: 'basic', accounts: [], adminUsername: '' })).toBe(false)
      expect(
        deriveBasicEnabled({
          kind: 'basic',
          accounts: [{ username: 'a', passwordHash: HASH }],
          adminUsername: 'a',
        }),
      ).toBe(true)
      expect(
        deriveBasicEnabled({
          kind: 'basic',
          accounts: [{ username: 'a', passwordHash: HASH }],
          adminUsername: 'b',
        }),
      ).toBe(false)
    })
  })

  // ---- legacy single-account migration (AC7.1 / AC7.1b / AC7.3) ----
  describe('legacy basic migration', () => {
    it('migrates {username, passwordHash} to accounts + adminUsername (AC7.1)', () => {
      const legacy = {
        enabled: true,
        provider: { kind: 'basic', username: 'root', passwordHash: HASH },
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      const n = normalizeAuth(legacy)
      expect(n?.provider).toEqual({
        kind: 'basic',
        accounts: [{ username: 'root', passwordHash: HASH }],
        adminUsername: 'root',
      })
      expect(n?.enabled).toBe(true)
    })

    it('migrates a username-without-hash bootstrap mid-state to unconfigured, no dangling admin (AC7.1b)', () => {
      const legacy = {
        enabled: false,
        provider: { kind: 'basic', username: 'root', passwordHash: '' },
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      const n = normalizeAuth(legacy)
      expect(n?.provider).toEqual({ kind: 'basic', accounts: [], adminUsername: '' })
      expect(n?.enabled).toBe(false)
    })

    it('is idempotent — an already-migrated config is not re-wrapped (AC7.3)', () => {
      const migratedOnce = normalizeAuth(validBasic)
      expect(normalizeAuth(migratedOnce)).toEqual(migratedOnce)
    })
  })

  // ---- none provider arm — no auth (the C-SEC-5 localhost default) ----
  describe('none provider arm', () => {
    it('parses a valid none config', () => {
      const none: AuthConfig = {
        enabled: false,
        provider: { kind: 'none' },
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      expect(authConfigSchema.safeParse(none).success).toBe(true)
      expect(normalizeAuth(none)).toEqual(none)
    })

    it('forces enabled to false for a none provider (single truth source)', () => {
      const stale = {
        enabled: true,
        provider: { kind: 'none' },
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      const normalized = normalizeAuth(stale)
      expect(normalized?.provider.kind).toBe('none')
      expect(normalized?.enabled).toBe(false)
    })
  })

  // ---- oauth (generic OIDC) provider arm — contract-only (no runtime) ----
  describe('oauth provider arm', () => {
    const validOAuth: AuthConfig = {
      enabled: false,
      provider: {
        kind: 'oauth',
        issuer: 'https://accounts.example.com',
        clientId: 'c3-console',
        clientSecretRef: 'C3_OAUTH_CLIENT_SECRET',
        redirectUri: 'https://console.example.com/auth/callback',
        scopes: ['openid', 'profile', 'email'],
        usePkce: true,
        allowedEmails: ['alice@example.com'],
        adminEmail: 'alice@example.com',
      },
      session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_SIGNING_KEY' },
    }

    it('parses a complete valid oauth config', () => {
      expect(authConfigSchema.safeParse(validOAuth).success).toBe(true)
      expect(normalizeAuth(validOAuth)).toEqual(validOAuth)
    })

    it('applies defaults for scopes, usePkce, allowedEmails, adminEmail when omitted', () => {
      const minimal = {
        enabled: false,
        provider: {
          kind: 'oauth',
          issuer: 'https://accounts.example.com',
          clientId: 'c3-console',
          clientSecretRef: 'C3_OAUTH_CLIENT_SECRET',
          redirectUri: 'https://console.example.com/auth/callback',
        },
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      const normalized = normalizeAuth(minimal)
      if (normalized?.provider.kind !== 'oauth') throw new Error('expected oauth')
      expect(normalized.provider.scopes).toEqual(['openid', 'profile', 'email'])
      expect(normalized.provider.usePkce).toBe(true)
      expect(normalized.provider.allowedEmails).toEqual([])
      expect(normalized.provider.adminEmail).toBe('')
    })

    it('does NOT fail-soft on an invalid adminEmail — kept, enabled stays false (S1/AC5.4)', () => {
      // An adminEmail not in allowedEmails is rejected only at the save layer; normalize
      // keeps the block (no runtime effect, would needlessly wipe issuer/clientId).
      const badAdmin = {
        ...validOAuth,
        enabled: true,
        provider: { ...validOAuth.provider, adminEmail: 'mallory@evil.com' },
      }
      const n = normalizeAuth(badAdmin)
      expect(n?.provider.kind).toBe('oauth')
      expect(n?.enabled).toBe(false)
    })

    it('rejects an oauth config missing the issuer', () => {
      const noIssuer = {
        ...validOAuth,
        provider: {
          kind: 'oauth',
          clientId: 'c3-console',
          clientSecretRef: 'C3_OAUTH_CLIENT_SECRET',
          redirectUri: 'https://console.example.com/auth/callback',
        },
      }
      expect(normalizeAuth(noIssuer)).toBeNull()
    })

    it('stores only the secret *reference*, never a plaintext secret', () => {
      const withPlaintext = {
        ...validOAuth,
        provider: { ...validOAuth.provider, clientSecret: 'super-secret-plaintext' },
      }
      const normalized = normalizeAuth(withPlaintext)
      if (normalized?.provider.kind !== 'oauth') throw new Error('expected oauth')
      expect(normalized.provider.clientSecretRef).toBe('C3_OAUTH_CLIENT_SECRET')
      expect('clientSecret' in normalized.provider).toBe(false)
      expect(JSON.stringify(normalized)).not.toContain('super-secret-plaintext')
    })
  })

  describe('migrateLegacySessionTtl', () => {
    it('bumps the legacy 1h TTL up to the 30-day default', () => {
      const legacy: AuthConfig = {
        ...validBasic,
        session: { ttlSeconds: LEGACY_DEFAULT_SESSION_TTL_SECONDS, signingKeyRef: 'k' },
      }
      expect(migrateLegacySessionTtl(legacy).session.ttlSeconds).toBe(DEFAULT_SESSION_TTL_SECONDS)
    })

    it('leaves any other (user-chosen) TTL untouched', () => {
      const custom: AuthConfig = {
        ...validBasic,
        session: { ttlSeconds: 900, signingKeyRef: 'k' },
      }
      expect(migrateLegacySessionTtl(custom)).toBe(custom)
    })

    it('leaves the new 30-day default untouched (idempotent)', () => {
      const current: AuthConfig = {
        ...validBasic,
        session: { ttlSeconds: DEFAULT_SESSION_TTL_SECONDS, signingKeyRef: 'k' },
      }
      expect(migrateLegacySessionTtl(current).session.ttlSeconds).toBe(DEFAULT_SESSION_TTL_SECONDS)
    })
  })
})
