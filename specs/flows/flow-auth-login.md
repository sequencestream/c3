# Flow — Auth Login Gate

**Scenario.** Before a connection may drive agents, it authenticates. This is the mandatory
precondition for exposing c3 beyond localhost (constitution C-SEC-5, ADR-0023).

**Domains.** auth · web-console · system-config.

> **Status: partial runtime (2026-06-11).** The boundary + contracts and a **minimal `basic`
> provider** are live (real scrypt-PHC hashing, real `login` verification, `set_admin_password`).
> **Still deferred:** token signing/verification, request-level auth middleware, and the
> "enabled auth ⇒ may bind non-loopback" enforcement — so the server's bind address is **unchanged,
> still localhost-only**. See [auth-overview](../domains/core/auth/auth-overview.md) _Roadmap_. This
> flow documents the live slice and marks deferred steps inline.

## Flow graph

```mermaid
flowchart TD
    CFG[set_admin_password] --> HASH[scrypt PHC hash persisted]
    HASH --> LOGIN[login — verify plaintext in transit]
    LOGIN -- ok --> TOK[issue session token<br/>signing deferred]
    LOGIN -- fail --> UA[unauthenticated · 401 analogue]
    TOK --> EXP{non-loopback exposure?}
    EXP -- yes --> NEED[requires enabled auth<br/>runtime enforcement deferred]
    EXP -- no --> LOOP[localhost-only default]
```

## Configure the admin (bootstrap)

1. **web-console → auth.** In the System Settings auth panel the operator enables auth, sets a
   username, and sets a password via `set_admin_password { username, password, currentPassword? }`.
   The plaintext is hashed **server-side** (scrypt PHC) and only the hash is persisted
   (`AUTH-R3`/`AUTH-R7`).
2. **Change-password gate.** Changing an existing admin's password requires proving the current
   password (`currentPassword` verified against the stored hash) ⇒ `not_authenticated` on mismatch
   (`AUTH-R8`). The first bootstrap set is exempt — the localhost-only default trusts the local
   operator before any credential exists.
3. **Hash ownership.** `passwordHash` is mutated **only** by `set_admin_password`; a generic
   `save_settings` never writes it — the server forces it back to the on-disk value
   (`preserveAdminPasswordHash`), so a stale/empty client draft cannot wipe it (`AUTH-R7`).

## Login

1. **web-console → auth.** The login page sends `login` (`AuthLoginRequest`). The server verifies
   the plaintext against the stored hash; the plaintext exists in transit only, never persisted
   (`AUTH-R3`).
2. **Result.** `login_result` (`AuthLoginResult`) — success issues a provider-neutral
   `AuthSessionToken` (`{ tokenId, subject, issuedAt, expiresAt }`); the token signing secret is
   referenced by `signingKeyRef`, never persisted in `settings.json` (`AUTH-R4`). **Token
   signing/verification is deferred.**
3. **Unauthenticated.** `unauthenticated` is the WS analogue of HTTP 401; `logout` ends a session.
   **Request-level enforcement is deferred** — today the gate is UI-level only.

## Exposure precondition

A non-loopback `exposure.bindAddress` (e.g. `0.0.0.0`) expresses intent to expose c3 to a network,
which **requires** enabled auth (`AUTH-R6`, C-SEC-5). Today the panel only gates the toggle in the
UI (an admin must be configured before exposure can be enabled); **runtime enforcement of the bind
relaxation is deferred** — the server still binds localhost-only.

## Branches & exceptions (anti-scenarios)

- **Default = disabled, fail-soft.** `SystemSettings.auth` absent / `enabled: false` / a provider
  that fails validation ⇒ "no auth", the localhost-only default. `normalize()` drops a malformed
  `auth` block to `undefined` and never throws — an invalid config can never lock the user out or
  break boot (`AUTH-R1`).
- **Backward compatible.** An existing `settings.json` with no `auth` field round-trips with
  identical (no-auth) behaviour (`AUTH-R2`).
- **Never plaintext.** No type, example, or test carries a real plaintext password as a stored
  value; only the PHC hash is persisted (`AUTH-R3`).
- **Provider-neutral.** A future OAuth/SSO/multi-user provider adds only an `AuthProvider` arm + a
  server zod arm; the session model and wire messages are untouched (`AUTH-R5`).
