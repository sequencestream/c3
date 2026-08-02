/**
 * Authentication contracts — provider config, session token, and operation results.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

// ===========================================================================
// Authentication (ADR-0023) — contract-only, zero runtime.
//
// An extensible auth abstraction so the single-admin `basic` provider this phase
// does not weld one auth method into every layer. The session-token model and
// the login/logout/unauthenticated messages are PROVIDER-NEUTRAL (reused by any
// provider); a future provider only appends a `kind` arm to
// {@link AuthProvider}. Runtime (middleware, login page, password hashing, token
// signing/verification) is NOT in this phase. The matching zod schema +
// type-pin lives server-side in `kernel/config/auth-schema.ts` (ADR-0009).
// ===========================================================================

/**
 * Auth provider kinds — the extension point. `none` (no auth — the C-SEC-5
 * localhost-only default) and `basic` (single admin) are defined; other
 * providers remain reserved (add a `kind` here + an arm to {@link AuthProvider}
 * + a server zod arm; nothing else changes — same shape as the ADR-0011 vendor
 * extension point).
 */
export const AUTH_PROVIDER_KINDS = ['none', 'basic'] as const
export type AuthProviderKind = (typeof AUTH_PROVIDER_KINDS)[number]

/**
 * The `none` provider: no authentication — the first-class expression of the
 * C-SEC-5 localhost-only default (sign-in not required, anyone reaching the
 * server may drive it). Carries no config; `kind` alone is the whole shape.
 * Invariant: `kind:'none' ⇔ AuthConfig.enabled === false` (enforced by
 * `normalizeAuth`), so the dropdown's "no auth" choice and the master switch can
 * never disagree.
 */
export interface NoneAuthProvider {
  kind: 'none'
}

/**
 * One `basic` account: a login name + a password **hash** (a PHC string such as
 * `$scrypt$...`, encoding its own algorithm/params/salt). The plaintext password
 * is NEVER stored here — only the hash.
 */
export interface BasicAuthAccount {
  /** The account's login name. `trim`med, case-sensitive, unique within {@link BasicAuthProvider.accounts}. */
  username: string
  /** PHC-format password hash. Never plaintext. */
  passwordHash: string
}

/**
 * The `basic` provider: **multiple accounts, exactly one admin**. `accounts` may
 * hold 0..n entries — every account can sign in; `adminUsername` designates the
 * single account whose holder is the authority source for system-config changes
 * (no RBAC / multiple admins this phase). Invariants (enforced by `normalizeAuth`
 * + the save-layer handlers): usernames are unique; when `accounts` is non-empty
 * `adminUsername` MUST reference exactly one of them; an empty `accounts` is the
 * "unconfigured" state (`adminUsername` is `''`, auth is not effectively enabled).
 * Account credentials are mutated ONLY by the dedicated auth messages
 * (`set_admin_password` upsert / `remove_account` / `set_admin_account`), never by
 * a generic `save_settings` (AUTH-R7).
 */
export interface BasicAuthProvider {
  kind: 'basic'
  /** The account set. `0..n`; empty ⇒ unconfigured (auth not effectively enabled). */
  accounts: BasicAuthAccount[]
  /** The single admin account's username. Must reference an entry in `accounts`; `''` when `accounts` is empty. */
  adminUsername: string
}

/**
 * The active auth provider — a `kind`-discriminated union. Narrow on `kind`
 * before reading provider-specific fields. `none` is no-auth (the localhost-only
 * default); `basic` is runtime-live.
 */
export type AuthProvider = NoneAuthProvider | BasicAuthProvider

/**
 * Session-token policy — provider-neutral. The signing secret itself is NEVER
 * persisted in settings; `signingKeyRef` is a *reference* (an env var name or a
 * keystore id) the runtime resolves the real key from (deferred to a later task).
 */
export interface AuthSessionPolicy {
  /** Session token lifetime in seconds. */
  ttlSeconds: number
  /** Reference (env var name / keystore id) to the signing key — not the key itself. */
  signingKeyRef: string
}

/**
 * Network-exposure / bind-address intent. A non-loopback `bindAddress` signals
 * intent to expose c3 to a network, which (per ADR-0023) requires `enabled`
 * auth — the runtime enforcement of that rule is deferred to a later task.
 */
export interface AuthExposureConfig {
  /**
   * Intended server bind address. Absent ⇒ `127.0.0.1` (the C-SEC-5 default).
   * A non-loopback value (e.g. `0.0.0.0`) expresses network-exposure intent.
   */
  bindAddress?: string
}

/**
 * Authentication configuration (ADR-0023), hung on {@link SystemSettings.auth}.
 * `enabled: false` (or an absent block) ⇒ no auth, the C-SEC-5 localhost-only
 * default. This is the extensible boundary: only `provider` differs across auth
 * methods; everything else (session policy, exposure, the wire messages) is
 * provider-neutral.
 */
export interface AuthConfig {
  /** Master switch. `false` / absent block ⇒ no auth (C-SEC-5 default). A
   *  `none` provider pins this to `false` (see {@link NoneAuthProvider}). */
  enabled: boolean
  /** The active auth provider (`none` ⇒ no auth; `basic` runtime-live). */
  provider: AuthProvider
  /** Session-token policy (TTL + signing-key reference). */
  session: AuthSessionPolicy
  /** Network-exposure / bind-address intent. Absent ⇒ loopback only. */
  exposure?: AuthExposureConfig
}

/**
 * The issued session-token model — provider-neutral. An opaque, signed token
 * the runtime mints on successful login and verifies on each request (signing/
 * verification is deferred to a later task). All instants are absolute Unix ms.
 */
export interface AuthSessionToken {
  /** Opaque token id (jti). */
  tokenId: string
  /** Subject — the authenticated principal (the signed-in account's username under `basic`; not necessarily the admin). */
  subject: string
  /** Issued-at instant (Unix ms). */
  issuedAt: number
  /** Expiry instant (Unix ms) = `issuedAt + ttlSeconds * 1000`. */
  expiresAt: number
}

/**
 * Login request payload — provider-neutral. Shared by the future HTTP
 * `POST /auth/login` endpoint and the WS `login` message. The plaintext
 * `password` exists ONLY in transit: it is verified against the stored hash and
 * never persisted.
 */
export interface AuthLoginRequest {
  username: string
  password: string
}

/**
 * Login failure codes — the structured reasons a login is rejected. Distinct
 * from a successful result so the UI can localize each case.
 */
export const AUTH_FAILURE_CODES = ['invalid_credentials', 'auth_disabled', 'rate_limited'] as const
export type AuthFailureCode = (typeof AUTH_FAILURE_CODES)[number]

/**
 * Login result — `ok` discriminates. On success carries the issued session
 * token (the opaque string the client presents on later requests) plus its
 * absolute expiry; on failure carries a structured {@link AuthFailureCode}.
 */
export type AuthLoginResult =
  { ok: true; token: string; expiresAt: number } | { ok: false; code: AuthFailureCode }

/**
 * Admin-password change failure codes (ADR-0023, runtime slice). `not_authenticated`
 * ⇒ an admin already exists and the supplied `currentPassword` did not verify (the
 * sensitive-operation gate); `invalid` ⇒ the new username/password failed a basic
 * non-empty/length check. A bootstrap change (no admin configured yet) skips the gate.
 */
export const ADMIN_PASSWORD_FAILURE_CODES = ['not_authenticated', 'invalid'] as const
export type AdminPasswordFailureCode = (typeof ADMIN_PASSWORD_FAILURE_CODES)[number]

/**
 * Result of a `set_admin_password` attempt (ADR-0023). `ok` discriminates: on
 * success the server has hashed the new password server-side and persisted it
 * (the plaintext never lands on disk); on failure a structured code the UI localizes.
 */
export type AdminPasswordResult = { ok: true } | { ok: false; code: AdminPasswordFailureCode }

/**
 * Account-operation failure codes for the dedicated `basic` account messages
 * (`remove_account` / `set_admin_account`). `not_found` ⇒ the target username is
 * not in `accounts`; `admin_must_reassign` ⇒ refused to remove the admin account
 * while other accounts remain (designate a new admin first — the "block + prompt"
 * form of the delete-admin guard); `invalid` ⇒ a malformed request (e.g. empty
 * username). Removing the admin when it is the ONLY account is allowed (it empties
 * the store back to the unconfigured state), so it is NOT an error.
 */
export const ACCOUNT_OP_FAILURE_CODES = ['not_found', 'admin_must_reassign', 'invalid'] as const
export type AccountOpFailureCode = (typeof ACCOUNT_OP_FAILURE_CODES)[number]

/**
 * Result of a `remove_account` / `set_admin_account` attempt. `ok` discriminates:
 * on success the basic provider has been mutated + persisted (a fresh `settings`
 * frame follows); on failure a structured {@link AccountOpFailureCode} the UI localizes.
 */
export type AccountOpResult = { ok: true } | { ok: false; code: AccountOpFailureCode }
