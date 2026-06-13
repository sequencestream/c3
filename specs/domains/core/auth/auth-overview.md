# Domain: auth

Authentication for c3. Establishes **who** a connection is before it may drive agents — the
mandatory precondition for exposing the server beyond localhost (constitution C-SEC-5, ADR-0023).

> **Status: partial runtime (2026-06-11).** The boundary + contracts (types, persisted config
> shape, wire messages) are joined by a **minimal `basic`-provider runtime** powering the System
> Settings auth panel: real password hashing (scrypt PHC), real `login` credential verification,
> and a `set_admin_password` change-password flow. **Still deferred:** token signing/verification,
> request-level auth middleware + the "enabled auth ⇒ may bind non-loopback" enforcement (so the
> server's bind address is **unchanged** — still localhost-only), full session-lifecycle UI, and
> settings-file hardening. See _Roadmap_ for what each remaining task fills in.

## Why

The Web UI has no authentication today; that is precisely why C-SEC-5 pins the server to
loopback. Preparing for network exposure requires authentication first. Rather than weld a single
auth method (`basic`) into every layer — config, protocol, validation, UI — the abstraction is
laid first so a future OAuth/SSO/multi-user provider is an additive change, not a rewrite (the
same "neutral abstraction + per-kind extension" discipline as ADR-0011's vendor model).

## Model

All types live in `shared/src/protocol.ts` (zero-runtime, ADR-0009); the zod runtime schema lives
in `server/src/kernel/config/auth-schema.ts` with a bidirectional type-pin against the wire type.

- **AuthConfig** — `{ enabled, provider, session, exposure? }`. Hung on `SystemSettings.auth?`.
  Absent block or `enabled: false` ⇒ no auth.
- **AuthProvider** — a `kind`-discriminated union. Only `kind: 'basic'`
  (**BasicAuthProvider** `{ username, passwordHash }`) this phase. The single extension point for
  OAuth/SSO/multi-user.
- **AuthSessionPolicy** — `{ ttlSeconds, signingKeyRef }`. Provider-neutral session-token policy.
  `signingKeyRef` is a _reference_ (env var name / keystore id), never the key itself. Default
  `ttlSeconds` is **30 days** (`DEFAULT_SESSION_TTL_SECONDS`) — long enough that closing the tab and
  returning later does not re-prompt; there is no TTL-editing UI yet. `normalize` migrates a
  persisted legacy `3600` (the former 1h default) up to the 30-day default one-shot
  (`migrateLegacySessionTtl`). Sessions still live only in-process (no persistent store, ADR-0006),
  so a server restart invalidates every token regardless of TTL and re-prompts on next reconnect.
- **AuthExposureConfig** — `{ bindAddress? }`. Network-exposure / bind intent.
- **AuthSessionToken** — `{ tokenId, subject, issuedAt, expiresAt }`. Provider-neutral issued token.
- **Wire messages** — `login` / `logout` / `set_admin_password` (client→server), `login_result` /
  `admin_password_result` / `unauthenticated` (server→client). `AuthLoginRequest` and
  `AuthLoginResult` are reused by both the future HTTP `POST /auth/login` endpoint and the WS
  channel. `set_admin_password { username, password, currentPassword? }` sets/changes the single
  admin's credentials (the plaintext is hashed server-side); `admin_password_result` carries
  `AdminPasswordResult` (`ok` | `{ code: 'not_authenticated' | 'invalid' }`). `unauthenticated` is
  the WS analogue of HTTP 401.

## Business rules

- **AUTH-R1 (default = disabled)** — `SystemSettings.auth` absent, `enabled: false`, or a provider
  that fails validation ⇒ "no auth", the C-SEC-5 localhost-only default. `normalize()` fails soft:
  a malformed `auth` block is dropped to `undefined`, never throwing, so an invalid config can
  never accidentally lock the user out or break boot.
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
- **AUTH-R7 (password owned by `set_admin_password`)** — the `basic` `passwordHash` is mutated ONLY
  by `set_admin_password`: it hashes the plaintext server-side (scrypt PHC) and persists the hash.
  A generic `save_settings` NEVER writes the hash — the server forces it back to the on-disk value
  (`preserveAdminPasswordHash`), so a stale/empty client draft cannot overwrite or wipe it.
- **AUTH-R8 (change-password gate)** — changing an existing admin's password requires proving the
  current password (`currentPassword` verified against the stored hash) ⇒ `not_authenticated` on
  mismatch. The first (bootstrap) set is exempt — the localhost-only default trusts the local
  operator before any credential exists. Validation is deliberately light (non-empty username +
  min length) per the ADR non-goal; failures return `invalid`.

## Roadmap (deferred to later tasks)

1. **Done** — abstraction boundary + contracts.
2. **Partial** — password hashing ✅ + `basic` login verification ✅ + `set_admin_password` ✅ done;
   **still deferred:** token signing/verification, request-level auth middleware, and the
   "enabled auth ⇒ may bind non-loopback" enforcement (the actual C-SEC-5 relaxation).
3. **Partial** — System Settings auth config panel ✅ (enable/username/change-password/exposure
   toggle); login page already shipped (件①); **still deferred:** full session-lifecycle UI.
4. Harden the settings file: tighten permissions (it now carries a password hash) + log redaction.

## Shared context

- Wire protocol: `shared/src/protocol.ts` (`login`, `logout`, `set_admin_password`, `login_result`,
  `admin_password_result`, `unauthenticated`; `AuthConfig`, `AuthProvider`, `AuthSessionToken`,
  `AuthLoginRequest`, `AuthLoginResult`, `AdminPasswordResult`).
- Runtime handlers: `server/src/features/auth/index.ts` (`login`, `logout`, `setAdminPassword`) +
  `server/src/features/auth/password.ts` (scrypt PHC `hashPassword` / `verifyPassword`). The
  password-preservation guard on save lives in `server/src/features/settings/index.ts`.
- Config panel: `web/src/pages/systemsettings/components/SettingsPanel/SettingsPanel.vue` (auth
  section); `web/src/App.vue` routes `set_admin_password` + `admin_password_result`.
- Persists inside `~/.c3/settings.json` as `SystemSettings.auth`, through the same single
  concurrency-safe write path as the rest of system-config (`kernel/config/store.ts`).
- Validation + type-pin: `server/src/kernel/config/auth-schema.ts` (`normalizeAuth`, `authConfigSchema`).

## References

- [ADR-0023](../../../architecture/adr/0023-auth-abstraction-network-exposure.md) — the decision +
  full type structure and invariants.
- [constitution C-SEC-5](../../../constitution.md) — the clause this domain is the precondition for.
- [glossary](../../../glossary.md) — Authentication / AuthProvider / AuthConfig / Session token terms.
