import { describe, it, expect } from 'vitest'
import type { AuthConfig } from '@ccc/shared/protocol'
import { authConfigSchema, normalizeAuth } from './auth-schema.js'

/**
 * Contract tests for the ADR-0023 auth config schema. They guard the three
 * behaviours `normalize()` relies on: a valid basic config parses, an
 * absent/malformed block fails-soft to `null` (⇒ "no auth", C-SEC-5 default),
 * and an unknown provider kind is rejected.
 */
describe('auth-schema', () => {
  // A complete, valid single-admin basic config. The password is stored as a
  // PHC *hash*, never plaintext (ADR-0023 invariant).
  const validBasic: AuthConfig = {
    enabled: true,
    provider: {
      kind: 'basic',
      username: 'admin',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2g',
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_SIGNING_KEY' },
    exposure: { bindAddress: '0.0.0.0' },
  }

  it('parses a valid basic config', () => {
    const parsed = authConfigSchema.safeParse(validBasic)
    expect(parsed.success).toBe(true)
    expect(normalizeAuth(validBasic)).toEqual(validBasic)
  })

  it('accepts a minimal config without the optional exposure block', () => {
    const minimal: AuthConfig = {
      enabled: false,
      provider: { kind: 'basic', username: 'admin', passwordHash: '$argon2id$x' },
      session: { ttlSeconds: 900, signingKeyRef: 'keyref' },
    }
    expect(normalizeAuth(minimal)).toEqual(minimal)
  })

  it('fails soft to null for an absent block (⇒ no auth, C-SEC-5 default)', () => {
    expect(normalizeAuth(undefined)).toBeNull()
    expect(normalizeAuth(null)).toBeNull()
  })

  it('rejects an unknown provider kind', () => {
    const unknownKind = {
      ...validBasic,
      provider: { kind: 'oauth', clientId: 'x' },
    }
    expect(authConfigSchema.safeParse(unknownKind).success).toBe(false)
    expect(normalizeAuth(unknownKind)).toBeNull()
  })

  it('rejects a basic provider missing the password hash', () => {
    const noHash = {
      ...validBasic,
      provider: { kind: 'basic', username: 'admin' },
    }
    expect(normalizeAuth(noHash)).toBeNull()
  })

  it('rejects a config missing the session policy', () => {
    const noSession = { enabled: true, provider: validBasic.provider }
    expect(normalizeAuth(noSession)).toBeNull()
  })

  it('rejects a non-boolean enabled flag', () => {
    const badEnabled = { ...validBasic, enabled: 'yes' }
    expect(normalizeAuth(badEnabled)).toBeNull()
  })
})
