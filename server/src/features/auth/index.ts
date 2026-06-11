/**
 * `auth` feature handlers (ADR-0023, runtime slice).
 *
 * This phase adds the MINIMAL `basic`-provider runtime the System-Settings auth
 * panel needs end-to-end — no session middleware / handshake enforcement yet
 * (still deferred per ADR-0023; the server stays loopback-only):
 *
 * - `login` verifies credentials against the persisted `basic` provider hash and
 *   mints an opaque session token on success (token *signing* is still deferred —
 *   the token is an opaque random id with a TTL-derived expiry).
 * - `set_admin_password` sets/changes the single admin's credentials: it hashes
 *   the plaintext server-side (plaintext never persists) and writes the hash. The
 *   sensitive-operation gate is "prove the current password" — required once an
 *   admin exists, skipped on the first (localhost bootstrap) set.
 * - `logout` stays a no-op (no server-side session store exists yet).
 */
import { randomBytes } from 'node:crypto'
import type { AuthConfig, AuthSessionPolicy } from '@ccc/shared/protocol'
import type { Handler } from '../../transport/handler-registry.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import { hashPassword, verifyPassword } from './password.js'

/** Minimum new-password length. Deliberately light (ADR-0023 non-goal: no
 *  complex strength policy) — just non-empty username + a floor on length. */
const MIN_PASSWORD_LEN = 4

/** Default session policy stamped onto a freshly-created auth block. The signing
 *  key is a *reference* (resolved by the future token-signing runtime), never the
 *  key itself (ADR-0023 — `signingKeyRef` is an env-var name / keystore id). */
const DEFAULT_SESSION: AuthSessionPolicy = { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' }

export const login: Handler<'login'> = (_ctx, conn, msg) => {
  const auth = loadSettings().auth
  if (!auth || !auth.enabled || auth.provider.kind !== 'basic') {
    conn.send({ type: 'login_result', result: { ok: false, code: 'auth_disabled' } })
    return
  }
  const { username, password } = msg.request
  if (
    username !== auth.provider.username ||
    !verifyPassword(password, auth.provider.passwordHash)
  ) {
    conn.send({ type: 'login_result', result: { ok: false, code: 'invalid_credentials' } })
    return
  }
  // Token signing is deferred (ADR-0023): mint an opaque random id with a
  // TTL-derived expiry. Handshake enforcement lands with the middleware slice.
  const token = randomBytes(24).toString('hex')
  const expiresAt = Date.now() + auth.session.ttlSeconds * 1000
  conn.send({ type: 'login_result', result: { ok: true, token, expiresAt } })
}

export const logout: Handler<'logout'> = () => {
  // Contract-only: no session token is ever issued server-side yet, so there is
  // nothing to invalidate. Token revocation arrives with the middleware slice.
}

export const setAdminPassword: Handler<'set_admin_password'> = (_ctx, conn, msg) => {
  const settings = loadSettings()
  const existing = settings.auth?.provider.kind === 'basic' ? settings.auth.provider : null
  const adminConfigured = !!(existing && existing.username && existing.passwordHash)

  const username = msg.username.trim()
  if (!username || msg.password.length < MIN_PASSWORD_LEN) {
    conn.send({ type: 'admin_password_result', result: { ok: false, code: 'invalid' } })
    return
  }

  // Sensitive-operation gate: once an admin exists, prove the current password.
  // The first (bootstrap) set is exempt — the localhost-only default trusts the
  // local operator before any credential exists.
  if (adminConfigured) {
    if (!msg.currentPassword || !verifyPassword(msg.currentPassword, existing.passwordHash)) {
      conn.send({ type: 'admin_password_result', result: { ok: false, code: 'not_authenticated' } })
      return
    }
  }

  const provider = { kind: 'basic' as const, username, passwordHash: hashPassword(msg.password) }
  const nextAuth: AuthConfig = settings.auth
    ? { ...settings.auth, provider }
    : { enabled: false, provider, session: DEFAULT_SESSION }
  saveSettings({ ...settings, auth: nextAuth })

  conn.send({ type: 'admin_password_result', result: { ok: true } })
}
