# Domain: auth

Authentication for c3. Establishes **who** a connection is before it may drive agents — the
mandatory precondition for exposing the server beyond localhost (constitution C-SEC-5, ADR-0023).

> **Status: partial runtime (2026-06-16).** The boundary + contracts (config shape, wire messages)
> are joined by a **`basic`-provider runtime** powering the System Settings
> auth panel: real password hashing (scrypt PHC), real `login` credential verification, and
> **multiple accounts with exactly one admin** (add/change-password/remove account + designate the
> single admin), plus an `oauth` `adminEmail` (contract-only). A first **request-level authorization**
> slice has also landed: **only the admin may change system configuration** (AUTH-R10) — enforced for
> `basic`, encoded-but-inert for the deferred `oauth` runtime. **Still deferred:** token signing/verification,
> the general auth middleware + the "enabled auth ⇒ may bind non-loopback" enforcement (so the
> server's bind address is **unchanged** — still localhost-only), full session-lifecycle UI, and
> settings-file hardening. See _Roadmap_ for what each remaining task fills in.

## Why

The Web UI has no authentication today; that is precisely why C-SEC-5 pins the server to
loopback. Preparing for network exposure requires authentication first. Rather than weld a single
auth method (`basic`) into every layer — config, protocol, validation, UI — the abstraction is
laid first so a future OAuth/SSO/multi-user provider is an additive change, not a rewrite (the
same "neutral abstraction + per-kind extension" discipline as ADR-0011's vendor model).

## Model

All auth types are part of the shared wire/config contract (zero-runtime, ADR-0009); the server's
runtime schema validates and type-pins against that contract bidirectionally.

- **AuthConfig** — `{ enabled, provider, session, exposure? }`. Hung on `SystemSettings.auth?`.
  Absent block or `enabled: false` ⇒ no auth.
- **AuthProvider** — a `kind`-discriminated union, the single extension point for OAuth/SSO/multi-user.
  - `kind: 'none'` (**NoneAuthProvider** `{}`) — no auth, the first-class expression of the C-SEC-5
    localhost-only default (sign-in disabled). Carries no config. Invariant: `kind:'none' ⇔
enabled:false`, enforced during normalization (a stale `enabled:true` is re-pinned to `false`), so
    the dropdown's "no auth" choice and the master switch can never disagree (the UI reads the
    provider kind, never a second flag).
  - `kind: 'basic'` (**BasicAuthProvider** `{ accounts: { username, passwordHash }[], adminUsername }`) —
    **multiple accounts, exactly one admin**, runtime-live. Every account may sign in (the admin is the
    authority for system-config changes, not a login privilege — no RBAC); `adminUsername` references one
    account (`''` when `accounts` is empty = the unconfigured state). Usernames are trimmed and
    case-sensitive-unique. Account credentials are mutated ONLY by the dedicated messages
    (`set_admin_password` upsert / `remove_account` / `set_admin_account`), never by `save_settings`.
  - `kind: 'oauth'` (**OAuthAuthProvider** `{ issuer, clientId, clientSecretRef, redirectUri, scopes, usePkce, allowedEmails, adminEmail }`)
    — generic OIDC, **contract-only**: the config persists, but with no OAuth runtime yet (the callback
    endpoint, discovery, PKCE/state, token exchange, JWKS verification, and session minting are all
    deferred) enabling auth still works only with `basic`. `issuer` is the OIDC discovery base URL;
    `clientSecretRef` is a _reference_ (env var name / keystore id) to the client secret, never the
    plaintext (same discipline as `signingKeyRef`); `scopes` defaults to `['openid','profile','email']`;
    `usePkce` defaults to `true`; `allowedEmails` is the authorization allowlist (empty ⇒ nobody
    authorized — the future runtime enforces this). `adminEmail` is the single admin's email (the OAuth
    analogue of `adminUsername`) — it must be non-empty and a member of `allowedEmails` (validated at the
    save layer). Authorization is by email allowlist only this phase (no sub allowlist / roles).
- **AuthSessionPolicy** — `{ ttlSeconds, signingKeyRef }`. Provider-neutral session-token policy.
  `signingKeyRef` is a _reference_ (env var name / keystore id), never the key itself. Default
  `ttlSeconds` is **30 days** — long enough that closing the tab and returning later does not re-prompt;
  there is no TTL-editing UI yet. Normalization migrates a persisted legacy `3600` (the former 1h
  default) up to the 30-day default one-shot. Sessions still live only in-process (no persistent store,
  ADR-0006), so a server restart invalidates every token regardless of TTL and re-prompts on next
  reconnect.
- **AuthExposureConfig** — `{ bindAddress? }`. Network-exposure / bind intent.
- **AuthSessionToken** — `{ tokenId, subject, issuedAt, expiresAt }`. Provider-neutral issued token.
- **Wire messages** — `login` / `logout` / `set_admin_password` / `remove_account` / `set_admin_account`
  (client→server), `login_result` / `admin_password_result` / `account_op_result` / `unauthenticated`
  (server→client). The login request/result shapes are reused by both the future HTTP login endpoint and
  the WS channel. `set_admin_password { username, password, currentPassword? }` **upserts** an account's
  password — adds the account when the username is new (the first one becomes the admin), changes it when
  it exists (`admin_password_result`: `ok` | `{ code: 'not_authenticated' | 'invalid' }`).
  `remove_account { username }` / `set_admin_account { username }` manage the set + admin designation
  (`account_op_result`: `ok` | `{ code: 'not_found' | 'admin_must_reassign' | 'invalid' }`).
  `unauthenticated` is the WS analogue of HTTP 401.

## Business rules

- **AUTH-R1 (default = disabled)** — `SystemSettings.auth` absent, `enabled: false`, a `none`
  provider, or a provider that fails validation ⇒ "no auth", the C-SEC-5 localhost-only default.
  Normalization fails soft: a malformed `auth` block is dropped (treated as absent), never throwing,
  so an invalid config can never accidentally lock the user out or break boot. A `none` provider is the
  explicit, first-class form of "no auth": normalization pins its `enabled` to `false` so the provider
  kind is the single truth source (no second flag to contradict it).
- **AUTH-R2 (backward compatible)** — an existing `settings.json` with no `auth` field round-trips
  through load → normalize → save with identical behaviour (no auth). Adding this domain changes
  no existing config's meaning.
- **AUTH-R3 (never plaintext)** — passwords are stored only as a hash (`BasicAuthProvider.passwordHash`,
  a PHC string). The plaintext `AuthLoginRequest.password` exists in transit only — verified against
  the hash, never persisted. No type, example, or test carries a real plaintext password as a stored
  value.
- **AUTH-R4 (key by reference)** — the token signing secret is never persisted in `settings.json`;
  `AuthSessionPolicy.signingKeyRef` references it (env var name / keystore id). The runtime resolves
  the real key (deferred).
- **AUTH-R5 (provider-neutral session/messages)** — `AuthSessionToken`, `AuthLoginRequest/Result`,
  and the login/logout/unauthenticated messages carry no provider-specific fields. A new provider
  adds only an `AuthProvider` arm + a server zod arm; the session model and wire messages are untouched.
- **AUTH-R6 (auth ⇒ exposure precondition)** — a non-loopback `exposure.bindAddress` (e.g. `0.0.0.0`)
  expresses intent to expose c3 to a network, which requires `enabled` auth. **Runtime enforcement of
  this rule is deferred** (Roadmap step 2); the panel only gates the toggle in the UI (an admin must
  be configured before exposure can be enabled) — the server's bind address is still unchanged.
- **AUTH-R7 (basic account store owned by the dedicated messages)** — the `basic` account set
  (usernames, password hashes, admin designation) is mutated ONLY by `set_admin_password` /
  `remove_account` / `set_admin_account` (the password messages hash the plaintext server-side, scrypt
  PHC). A generic `save_settings` NEVER touches it — the server forces the **entire basic provider**
  back to the on-disk value, so a stale/empty client draft cannot overwrite, reassign, or wipe accounts.
  (When the on-disk provider is not `basic` — a just-switched none/oauth→basic
  draft — the fresh empty-shell `{ accounts: [], adminUsername: '' }` is kept; accounts are then filled
  via the dedicated messages.)
- **AUTH-R8 (change-password gate)** — changing an existing account's password requires proving that
  account's current password (`currentPassword` verified against its stored hash) ⇒ `not_authenticated`
  on mismatch. Validation is deliberately light (non-empty username + min length) per the ADR non-goal;
  failures return `invalid`. (Roster mutations are additionally gated by AUTH-R10 — only the admin may
  add/remove accounts or reassign the admin once one is configured; during the bootstrap window — no
  admin yet — that gate is inert, so the first account can be created.)
- **AUTH-R9 (single-admin reference integrity + method exclusivity)** — exactly one auth method is
  active at a time (the single `provider` union — `basic` and `oauth` can never both be enabled).
  Under `basic`, when `accounts` is non-empty `adminUsername` MUST reference exactly one account and
  usernames MUST be unique; under `oauth`, `adminEmail` MUST be non-empty and a member of `allowedEmails`.
  Two layers enforce this: the **save layer** rejects a UI-driven violation with a structured code
  (`account_op_result` / `auth.oauthAdminInvalid`); normalization is the **fail-soft backstop** for a
  hand-edited `settings.json` — a `basic` block with a dangling/duplicate admin is dropped (no auth),
  while an `oauth` block with an invalid `adminEmail` is kept (it has no runtime effect —
  `oauth.enabled` is always false — and dropping it would needlessly wipe the rest of the config).
  `basic.enabled` is derived: true ⇔ `accounts` non-empty AND `adminUsername` references an account.
  Removing the admin account is refused while other accounts remain (`admin_must_reassign`); removing it
  when it is the only account empties the store back to the unconfigured state. A legacy single-account
  `{ username, passwordHash }` config migrates one-shot to `{ accounts: [...], adminUsername }`.
- **AUTH-R10 (admin-only system-config mutations)** — **only the unique admin may change system
  configuration.** Every config-mutating handler (`save_settings`, `set_admin_password`,
  `remove_account`, `set_admin_account`, `save_workspace_setting`, `save_workspace_mcp_config`) passes a
  provider-neutral admin gate before mutating; a non-admin or unauthenticated connection is rejected with
  the `auth.adminOnly` error and nothing changes. **Adding / removing a workspace is admin-only too**
  (`add_workspace` / `remove_workspace`): establishing or tearing down a trust root passes the same admin
  gate, so a non-admin is rejected with `auth.adminOnly` and an unauthenticated connection with
  `unauthenticated`; viewing, entering, and editing a workspace stay open to any authenticated user (the
  gate narrows the registry mutations only). The gate compares the connection's authenticated **subject**
  (bound at the handshake / on `login`) to the active provider's admin (`basic.adminUsername` /
  `oauth.adminEmail`). It is **inert — every local connection trusted — whenever no admin can apply**:
  auth disabled / `none` / an unconfigured `basic` shell (the bootstrap window, AUTH-R2 loopback
  trust). **`basic` is fully enforced.** **`oauth` is deferred** (contract-only): with no OAuth login
  runtime, no subject is resolvable, so the gate stays inert for `oauth`; the `adminEmail` comparison
  branch is already wired, so enforcement activates automatically once the OAuth runtime binds a
  subject. The gate is **never the sole defense** — it composes with the handshake/dispatch auth gate
  (an unauthenticated connection cannot reach these handlers when auth is enabled). The server enforces
  this regardless of the client: the console additionally hides/disables the controls for a non-admin
  (driven by `ready.isAdmin`), but that is UX only — never the authority.

## Roadmap (deferred to later tasks)

1. **Done** — abstraction boundary + contracts.
2. **Partial** — password hashing ✅ + `basic` login verification ✅ + `set_admin_password` ✅ +
   the **admin-only system-config gate** (AUTH-R10, `basic`) ✅ done; **still deferred:** token
   signing/verification, the general auth middleware (the per-frame token check beyond the handshake),
   and the "enabled auth ⇒ may bind non-loopback" enforcement (the actual C-SEC-5 relaxation).
3. **Partial** — System Settings auth config panel ✅ (three-state provider dropdown
   **none/basic/oauth** as the single auth on/off control — no separate enable checkbox —
   - username/change-password/exposure toggle + the `oauth` provider config form ✅); login page
     already shipped (件①); **still deferred:** full session-lifecycle UI.
4. Harden the settings file: tighten permissions (it now carries a password hash) + log redaction.
5. **OAuth runtime** (deferred) — the `oauth` provider is **contract-only**. Building the runtime means:
   `/auth/callback` endpoint, OIDC discovery fetch, PKCE + `state` generation/verification, the
   authorization-code → token exchange, JWKS signature verification, email-allowlist authorization, and
   session minting. Library choice (`openid-client` vs `arctic`, plus `bun build --compile` compatibility)
   is recorded in ADR-0023 and not yet locked.

## Shared context

- **Wire protocol** — the auth messages (`login`, `logout`, `set_admin_password`, `remove_account`,
  `set_admin_account`, `login_result`, `admin_password_result`, `account_op_result`, `unauthenticated`)
  and the config/token contract types (AuthConfig, AuthProvider, BasicAuthProvider, account, session
  token, login request/result, admin-password result, account-op result) are part of the single shared
  wire/config contract.
- **Runtime** — the server hashes and verifies passwords (scrypt PHC), runs the login / logout /
  account-management handlers, and applies the admin gate (AUTH-R10) in every config-mutating handler.
  The connection's `subject` is bound at the WebSocket handshake and on `login`, and the `ready.isAdmin`
  flag carries the UX hint to the console. Basic-provider preservation, OAuth save validation, the
  derived `basic.enabled`, the legacy single-account migration, and the cross-field invariants all live
  in the server's config-validation layer.
- **Config panel** — the System Settings page hosts the auth section and routes the
  account-management messages and their results.
- Persists inside `~/.c3/settings.json` as `SystemSettings.auth`, through the same single
  concurrency-safe write path as the rest of system-config.

## References

- [ADR-0023](../../../architecture/adr/0023-auth-abstraction-network-exposure.md) — the decision +
  full type structure and invariants.
- [constitution C-SEC-5](../../../constitution.md) — the clause this domain is the precondition for.
- [glossary](../../../glossary.md) — Authentication / AuthProvider / AuthConfig / Session token terms.
