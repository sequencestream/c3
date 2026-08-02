/**
 * Authentication wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  AccountOpResult,
  AdminPasswordResult,
  AuthLoginRequest,
  AuthLoginResult,
} from './auth.js'

/**
 * Authenticate this connection (ADR-0023). Carries an {@link AuthLoginRequest}
 * (plaintext password in transit only). Server replies with `login_result`.
 * Provider-neutral: the same message logs in under any future provider.
 * Contract-only this phase — no server-side verification exists yet.
 */
export type ClientLogin = { type: 'login'; request: AuthLoginRequest }

/** Invalidate this connection's session token (ADR-0023). No reply required. */
export type ClientLogout = { type: 'logout' }

/**
 * Upsert a `basic` account's password (ADR-0023). When `username` is not yet in
 * `accounts` it ADDS the account (the first account also becomes the admin);
 * when it exists it CHANGES that account's password. The plaintext `password`
 * exists ONLY in transit — the server hashes it and persists the hash; plaintext
 * never lands on disk. `currentPassword` is the sensitive-operation gate: required
 * (verified against THAT account's stored hash) when changing an existing account,
 * omitted when adding a new account (localhost bootstrap-trust). Server replies
 * `admin_password_result`, then echoes a fresh `settings` on success.
 *
 * (Name kept for wire/back-compat; it now sets ANY account's password, not only
 * the admin's. Account removal / admin designation use the messages below.)
 */
export type ClientSetAdminPassword = {
  type: 'set_admin_password'
  username: string
  password: string
  currentPassword?: string
}

/**
 * Remove a `basic` account (ADR-0023). Reply: `account_op_result`. Removing a
 * non-admin account succeeds; removing the admin while other accounts remain is
 * refused (`admin_must_reassign` — designate a new admin first); removing the
 * admin when it is the only account empties the store (allowed, ⇒ unconfigured).
 * On success a fresh `settings` frame follows.
 */
export type ClientRemoveAccount = { type: 'remove_account'; username: string }

/**
 * Designate which `basic` account is the single admin (ADR-0023). Reply:
 * `account_op_result` (`not_found` if `username` is not in `accounts`). On
 * success a fresh `settings` frame follows.
 */
export type ClientSetAdminAccount = { type: 'set_admin_account'; username: string }

/**
 * Result of a `login` attempt (ADR-0023). Carries an {@link AuthLoginResult}:
 * on success the issued session token + its absolute expiry, on failure a
 * structured {@link AuthFailureCode}.
 */
export type ServerLoginResult = { type: 'login_result'; result: AuthLoginResult }

/**
 * Result of a `set_admin_password` attempt (ADR-0023). On success the new
 * credentials are already hashed + persisted (a fresh `settings` frame
 * follows); on failure carries a structured {@link AdminPasswordFailureCode}.
 */
export type ServerAdminPasswordResult = {
  type: 'admin_password_result'
  result: AdminPasswordResult
}

/**
 * Result of a `remove_account` / `set_admin_account` attempt (ADR-0023). On
 * success the basic provider was mutated + persisted (a fresh `settings` frame
 * follows); on failure carries a structured {@link AccountOpFailureCode}.
 */
export type ServerAccountOpResult = { type: 'account_op_result'; result: AccountOpResult }

/**
 * The connection is not authenticated (ADR-0023) — the WS analogue of HTTP
 * 401. Emitted when an action requires auth but the connection presents no
 * valid session token. `reason` distinguishes a missing / expired / otherwise
 * invalid token so the client can decide whether to re-prompt for login.
 */
export type ServerUnauthenticated = {
  type: 'unauthenticated'
  reason: 'missing' | 'expired' | 'invalid'
}
