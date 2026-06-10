# Domain: auth

Authentication for c3. Establishes **who** a connection is before it may drive agents — the
mandatory precondition for exposing the server beyond localhost (constitution C-SEC-5, ADR-0023).

> **Status: contract-only (2026-06-11).** This domain currently defines the *boundary and
> contracts* only — types, persisted config shape, and wire messages. **No runtime exists yet**:
> no middleware, no login handler, no password hashing, no token signing/verification, and the
> server's actual bind address is unchanged (still localhost-only). The runtime is split across
> later tasks (see _Roadmap_). Read this as the stable edge those tasks fill in.

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
  `signingKeyRef` is a *reference* (env var name / keystore id), never the key itself.
- **AuthExposureConfig** — `{ bindAddress? }`. Network-exposure / bind intent.
- **AuthSessionToken** — `{ tokenId, subject, issuedAt, expiresAt }`. Provider-neutral issued token.
- **Wire messages** — `login` / `logout` (client→server), `login_result` / `unauthenticated`
  (server→client). `AuthLoginRequest` and `AuthLoginResult` are reused by both the future HTTP
  `POST /auth/login` endpoint and the WS channel. `unauthenticated` is the WS analogue of HTTP 401.

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
  this rule is deferred** (Roadmap step 2); this phase only records the intent in the contract.

## Roadmap (deferred to later tasks)

1. **This task** — abstraction boundary + contracts (done).
2. Runtime: password hashing, token signing/verification, auth middleware, and the
   "enabled auth ⇒ may bind non-loopback" enforcement (the actual C-SEC-5 relaxation).
3. Login page + session lifecycle UI in the web console.
4. Harden the settings file: tighten permissions (it now carries a password hash) + log redaction.

## Shared context

- Wire protocol: `shared/src/protocol.ts` (`login`, `logout`, `login_result`, `unauthenticated`;
  `AuthConfig`, `AuthProvider`, `AuthSessionToken`, `AuthLoginRequest`, `AuthLoginResult`).
- Persists inside `~/.c3/settings.json` as `SystemSettings.auth`, through the same single
  concurrency-safe write path as the rest of system-config (`kernel/config/store.ts`).
- Validation + type-pin: `server/src/kernel/config/auth-schema.ts` (`normalizeAuth`, `authConfigSchema`).

## References

- [ADR-0023](../../../architecture/adr/0023-auth-abstraction-network-exposure.md) — the decision +
  full type structure and invariants.
- [constitution C-SEC-5](../../../constitution.md) — the clause this domain is the precondition for.
- [glossary](../../../glossary.md) — Authentication / AuthProvider / AuthConfig / Session token terms.
