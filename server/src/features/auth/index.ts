/**
 * `auth` feature handlers (ADR-0023, runtime slice).
 *
 * This phase adds the MINIMAL `basic`-provider runtime the System-Settings auth
 * panel needs end-to-end — no session middleware / handshake enforcement yet
 * (still deferred per ADR-0023; the server stays loopback-only):
 *
 * - `login` verifies credentials against ANY account in the persisted `basic`
 *   provider (multi-account; the admin is the config authority, not a login
 *   privilege) and mints an opaque session token on success (token *signing* is
 *   still deferred — the token is an opaque random id with a TTL-derived expiry).
 * - `set_admin_password` upserts an account's password: adds the account when the
 *   username is new (the first one becomes the admin), or changes its password
 *   when it exists. It hashes the plaintext server-side (plaintext never persists).
 *   The sensitive-operation gate is "prove the current password" — required for a
 *   change, skipped when adding (localhost bootstrap-trust).
 * - `remove_account` / `set_admin_account` manage the account set + the single
 *   admin designation, preserving the admin-reference invariant (never orphaned).
 * - `logout` revokes the in-process session.
 */
import type { AuthConfig, AuthSessionPolicy, BasicAuthProvider } from '@ccc/shared/protocol'
import type { Handler } from '../../transport/handler-registry.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import { DEFAULT_SESSION_TTL_SECONDS, deriveBasicEnabled } from '../../kernel/config/auth-schema.js'
import { hashPassword, verifyPassword } from './password.js'
import { mintSession, revokeSession } from './session-store.js'
import { requireAdmin } from './authz.js'

/** Minimum new-password length. Deliberately light (ADR-0023 non-goal: no
 *  complex strength policy) — just non-empty username + a floor on length. */
const MIN_PASSWORD_LEN = 4

/** Default session policy stamped onto a freshly-created auth block. The signing
 *  key is a *reference* (resolved by the future token-signing runtime), never the
 *  key itself (ADR-0023 — `signingKeyRef` is an env-var name / keystore id). */
const DEFAULT_SESSION: AuthSessionPolicy = {
  ttlSeconds: DEFAULT_SESSION_TTL_SECONDS,
  signingKeyRef: 'C3_AUTH_KEY',
}

export const login: Handler<'login'> = (_ctx, conn, msg) => {
  const auth = loadSettings().auth
  if (!auth || !auth.enabled || auth.provider.kind !== 'basic') {
    conn.send({ type: 'login_result', result: { ok: false, code: 'auth_disabled' } })
    return
  }
  const { username, password } = msg.request
  // Any account in the set may sign in (the admin is the authority for config, not
  // a login privilege — there is no RBAC this phase). Match by exact username.
  const account = auth.provider.accounts.find((a) => a.username === username)
  if (!account || !verifyPassword(password, account.passwordHash)) {
    conn.send({ type: 'login_result', result: { ok: false, code: 'invalid_credentials' } })
    return
  }
  // Mint an opaque session the in-process store remembers so the handshake can
  // verify the token a (re)connecting client presents (token *signing* is still
  // deferred — ADR-0023). Bind it to THIS connection too, so the post-login
  // reconnect that re-presents the token sails through the handshake gate. The
  // subject is the signed-in account's username (not necessarily the admin).
  const { token, expiresAt } = mintSession(account.username, auth.session.ttlSeconds)
  conn.authed = true
  conn.authToken = token
  // Bind the subject so the admin gate (ADR-0023 authz) recognizes this connection
  // before its post-login reconnect re-derives it from the handshake token.
  conn.subject = account.username
  conn.send({ type: 'login_result', result: { ok: true, token, expiresAt } })
}

export const logout: Handler<'logout'> = (_ctx, conn) => {
  // Revoke the server-side session so the token can never re-authenticate a
  // future handshake. When auth is enabled, also drop this connection back to
  // unauthenticated so its subsequent frames hit the dispatch gate; when auth
  // is disabled the connection was never gated (AUTH-R2) so we leave it admitted.
  revokeSession(conn.authToken)
  conn.authToken = null
  conn.subject = null
  const auth = loadSettings().auth
  if (auth?.enabled && auth.provider.kind === 'basic') conn.authed = false
}

/** Persist a mutated `basic` provider, re-deriving `enabled` (AC3.5) and creating
 *  a default auth block when none exists yet (bootstrap). */
function persistBasicProvider(
  settings: ReturnType<typeof loadSettings>,
  provider: BasicAuthProvider,
): void {
  const enabled = deriveBasicEnabled(provider)
  const nextAuth: AuthConfig = settings.auth
    ? { ...settings.auth, provider, enabled }
    : { enabled, provider, session: DEFAULT_SESSION }
  saveSettings({ ...settings, auth: nextAuth })
}

export const setAdminPassword: Handler<'set_admin_password'> = (_ctx, conn, msg) => {
  // The account roster IS system configuration — only the admin may mutate it
  // (ADR-0023 authz). Inert in the bootstrap window (no admin configured yet:
  // `isAdminConn` is true), so the first account can still be created; once an
  // admin exists, only that admin adds/changes accounts.
  if (!requireAdmin(conn)) return
  const settings = loadSettings()
  const existing = settings.auth?.provider.kind === 'basic' ? settings.auth.provider : null
  const isFirstAdmin = !existing?.adminUsername

  const username = msg.username.trim()
  if (!username || msg.password.length < MIN_PASSWORD_LEN) {
    conn.send({ type: 'admin_password_result', result: { ok: false, code: 'invalid' } })
    return
  }

  const accounts = existing ? existing.accounts.map((a) => ({ ...a })) : []
  const idx = accounts.findIndex((a) => a.username === username)

  if (idx >= 0) {
    // Changing an existing account's password — sensitive-operation gate: prove
    // THAT account's current password (the 1:1 generalization of AUTH-R8).
    if (!msg.currentPassword || !verifyPassword(msg.currentPassword, accounts[idx].passwordHash)) {
      conn.send({ type: 'admin_password_result', result: { ok: false, code: 'not_authenticated' } })
      return
    }
    accounts[idx] = { username, passwordHash: hashPassword(msg.password) }
  } else {
    // Adding a new account — no proof (localhost bootstrap-trust; the server is
    // still loopback-only and request-level authz is deferred, ADR-0023).
    accounts.push({ username, passwordHash: hashPassword(msg.password) })
  }

  // The first account configured becomes the admin (AC3.4 — never an
  // accounts-non-empty-but-no-admin mid-state).
  const adminUsername = existing?.adminUsername || username
  persistBasicProvider(settings, { kind: 'basic', accounts, adminUsername })

  conn.send({ type: 'admin_password_result', result: { ok: true } })
  if (isFirstAdmin) {
    conn.authed = false
    conn.authToken = null
    conn.subject = null
    conn.send({ type: 'unauthenticated', reason: 'missing' })
  }
}

export const removeAccount: Handler<'remove_account'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const settings = loadSettings()
  const existing = settings.auth?.provider.kind === 'basic' ? settings.auth.provider : null
  if (!existing || !existing.accounts.some((a) => a.username === msg.username)) {
    conn.send({ type: 'account_op_result', result: { ok: false, code: 'not_found' } })
    return
  }
  const isAdmin = existing.adminUsername === msg.username
  // Refuse to orphan the admin reference: removing the admin while other accounts
  // remain requires designating a new admin first (the "block + prompt" guard).
  if (isAdmin && existing.accounts.length > 1) {
    conn.send({ type: 'account_op_result', result: { ok: false, code: 'admin_must_reassign' } })
    return
  }
  const accounts = existing.accounts.filter((a) => a.username !== msg.username)
  // Removing the admin (only when it is the sole account, per the guard above)
  // empties the store back to the unconfigured state (AC2.5); else keep the admin.
  const adminUsername = isAdmin ? '' : existing.adminUsername
  persistBasicProvider(settings, { kind: 'basic', accounts, adminUsername })
  conn.send({ type: 'account_op_result', result: { ok: true } })
}

export const setAdminAccount: Handler<'set_admin_account'> = (_ctx, conn, msg) => {
  if (!requireAdmin(conn)) return
  const settings = loadSettings()
  const existing = settings.auth?.provider.kind === 'basic' ? settings.auth.provider : null
  if (!existing || !existing.accounts.some((a) => a.username === msg.username)) {
    conn.send({ type: 'account_op_result', result: { ok: false, code: 'not_found' } })
    return
  }
  persistBasicProvider(settings, { ...existing, adminUsername: msg.username })
  conn.send({ type: 'account_op_result', result: { ok: true } })
}
