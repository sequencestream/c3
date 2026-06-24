# 0026 — Product licensing as a separate license-server

- **Status:** proposed
- **Date:** 2026-06-16
- **Driver:** c3 needs a governed commercial-entitlement model with a server-side source of truth,
  established before any implementation so license, payment, and gating work cannot drift into
  conflict with the constitution.

## Context

c3 is moving from a free local tool to a **paid product**. A paid product needs to answer one
question authoritatively: _is this installation entitled to run?_ That answer cannot live only on
the local machine — a purely-local license check is shareable between machines, forgeable by a
determined user, and can never be **deactivated** after a refund/chargeback/abuse. Commercial
entitlement therefore requires a **server-side source of truth**.

The constitution's tech-stack baseline forbids — _in the c3 process_ — any database, any
auth/identity provider, any second agent runtime, and any non-loopback bind, each "forbidden without
an ADR". A licensing authority needs exactly those forbidden things (a database of orders and
licenses, an identity provider for users, a payment integration, a public network listener). The
resolution is **not** to relax c3's constraints, but to place the authority in a **separate
product** — the **license-server (LS)** — that lives entirely outside the c3 process. This ADR is
the constitution's required exception record for introducing that service and for the one small
concession the c3 side must make.

This decision must also be kept **distinct from the existing [auth domain](../../domains/core/auth/auth-overview.md)**
(ADR-0023). The two are different concerns with different lifecycles:

| Concern      | **auth** (ADR-0023)                | **product-license** (this ADR)                       |
| ------------ | ---------------------------------- | ---------------------------------------------------- |
| Question     | _Who_ may drive agents in this c3? | _Is this installation paid-for?_                     |
| Authority    | Local (c3 config)                  | Remote (license-server)                              |
| Runs when…   | Always (even with no license)      | Independent of which auth provider is active         |
| Failure mode | Reject the connection              | Gate **new** session creation; preserve running work |

Conflating them would couple two independent lifecycles into one — auth must protect a free,
unlicensed, localhost c3 the same way it protects a paid one, and licensing must apply whether auth
is disabled, `basic`, or `oauth`. They are deliberately separate domains.

## Options considered

### 1. In-c3 local license check (offline key file)

Ship a license key / signed file that c3 verifies locally with no server.

_Pro:_ no second service; no network dependency; stays inside the single process.
_Con:_ **no revocation** — a refunded or abused license keeps working forever.
_Con:_ trivially **shareable** — one key file copied to many machines.
_Con:_ **no payment path** — purchase, order records, and entitlement issuance have nowhere to live.
_Rejected:_ a commercial product cannot rely on an unrevocable, copyable local artifact.

### 2. Overload the existing auth domain

Express entitlement as another `AuthProvider` arm, or fold licensing checks into the auth runtime.

_Pro:_ reuses the existing config/login plumbing; no new domain.
_Con:_ couples two independent lifecycles — auth is local access control that must run for a free,
unlicensed c3; licensing is server-authoritative entitlement that is orthogonal to the auth method.
_Con:_ breaks single-responsibility: the auth domain's invariants (localhost trust, provider union,
single admin) have nothing to do with orders, payments, or revocation.
_Con:_ the auth domain explicitly models _access_, not _entitlement_ — overloading it would corrupt
a clean boundary that ADR-0023 just established.
_Rejected:_ entitlement is a separate bounded context, not an auth provider.

### 3. Separate license-server + c3-side gating (selected)

A distinct LS product owns the authoritative entitlement record, payment, and admin operations. c3
becomes a **client** of LS: it activates once, heartbeats periodically, verifies a signed
entitlement token offline, and gates new-session creation when not entitled.

_Pro:_ server-side source of truth ⇒ real revocation, per-installation binding, payment integration.
_Pro:_ keeps c3's local-first constraints intact — the forbidden technologies live in LS, a
separate deployable, not in the c3 process.
_Pro:_ offline-verifiable signed tokens + an offline grace window keep c3 usable through transient
network/LS outages without trusting the network for the "active" answer.
_Pro:_ cleanly separated from auth — the two domains evolve independently.
_Con:_ a second service to build and operate (plus PostgreSQL); c3 gains an outbound network
dependency and one small on-disk cache. Accepted as the cost of commercial entitlement.

## Decision

**Adopt option 3.** Product entitlement is owned by a **separate license-server (LS)**; c3 enforces
it client-side. The constitution's "forbidden without an ADR" list governs the **c3 process** — LS
is a distinct product outside that process, so the following are accepted **for LS only**:

- **Go standard-library HTTP** as the LS runtime (no heavy framework; a small, auditable surface).
- **PostgreSQL** as the LS persistent store (licenses, orders, activations, heartbeats, revocations).
- **GitHub OAuth** as the LS identity provider for **both user login and the admin back-office**
  (single identity source).
- **WeChat Pay** as the LS payment integration.
- **Ed25519** signatures on entitlement tokens — LS signs, c3 verifies with an **embedded public
  key** (the same signing discipline already used for releases, ADR-0010).

On the **c3 side**, the accepted concessions are deliberately minimal:

- **One new persistent store** — a small on-disk **entitlement cache** holding the last LS-signed
  entitlement token plus the heartbeat bearer token, so the 30-minute offline grace and restart
  continuity work. This is an accepted cost, analogous to the local configuration already carrying
  password hashes (ADR-0023). c3 still has **no general database** and **no second agent runtime**.
- **c3-side gating** — c3 verifies the Ed25519-signed token **offline**, treats entitlement as
  `active` while a valid token is within its term and the last successful heartbeat is under the
  grace window, and **gates new-session creation** when it is not. Running sessions and in-flight
  runs are **never** interrupted by gating (ADR-0006: runs are decoupled from connections and
  survive; entitlement lapse is treated the same way — it stops _new_ work, not _current_ work).

The c3 ↔ LS public boundary (activation, heartbeat, payment, error semantics) is documented once in
the [license-server API contract](../../shared/api-conventions/license-server-api.md). Activation
**auth codes are one-time and short-lived** and are **never** reused as the long-lived heartbeat
credential.

## Consequences

### Positive

- **Real entitlement control** — revocation, per-installation binding, and a payment path become
  possible because the authority is server-side.
- **c3 stays local-first** — every forbidden technology lives in a separate product; the c3 process
  keeps its no-database / single-runtime / localhost posture (the one exception, a small entitlement
  cache, is recorded here).
- **Resilient to outages** — offline Ed25519 verification + a 30-minute grace window mean a network
  blip or LS restart does not immediately stop a paying user; only a sustained lapse gates new work.
- **Clean separation from auth** — licensing and access control evolve independently.

### Negative / accepted costs

- **A second service + PostgreSQL to operate**, with its own deploy, backup, and on-call surface.
- **c3 gains an outbound network dependency** on LS. Mitigated by offline verification + grace, but
  a permanently unreachable LS eventually gates new sessions.
- **No-refund policy for MVP** — the product is sold as a virtual/digital good; the service
  agreement states it does not support refunds, and **no refund workflow is built** for the MVP.
  This is a deliberate business non-goal, recorded in the
  [product-license domain spec](../../domains/commerce/product-license/product-license-spec.md).
- **Trust boundary** — because c3 verifies a signature with an embedded public key, a forged
  "active" cannot be injected by tampering with the network. A verification failure is treated as
  **not entitled** (deny-by-default), but — balancing the C-SEC deny-by-default value against
  "never kill in-flight work" — it **gates new sessions only** and preserves running ones.

## Compliance

- c3 MUST verify the Ed25519 signature of an entitlement token against the embedded LS public key
  **before** honoring `active`; an unverifiable or tampered token is treated as not entitled.
- Activation auth codes MUST be one-time and short-lived; c3 MUST NOT reuse an activation code as a
  heartbeat credential, and LS MUST reject a consumed code.
- Gating MUST block **only** new-session creation; existing sessions and in-flight runs MUST remain
  fully usable on entitlement lapse (traceable to ADR-0006).
- No LS secret ships in the c3 binary except the **public** verification key; signing keys, OAuth
  client secrets, and payment credentials live only in LS (secret-by-reference, mirroring ADR-0023).
- The c3 ↔ LS contract is documented once in the LS API contract and cited by ID elsewhere.
- The licensing domain MUST NOT be expressed as an `AuthProvider` arm or merged into the auth runtime.

## References

- [constitution](../../constitution.md) — tech-stack baseline (forbidden-without-ADR list) + the
  C-SEC values this ADR balances; this ADR is the required exception record.
- [ADR-0023](0023-auth-abstraction-network-exposure.md) — the **auth** boundary, kept distinct here.
- [ADR-0010](0010-release-and-distribution-trust.md) — the existing Ed25519 release-signing precedent.
- [ADR-0006](0006-decouple-runs-from-connections.md) — runs survive; the basis for "preserve running
  sessions on entitlement lapse".
- [product-license domain](../../domains/commerce/product-license/product-license-overview.md) — the
  business behavior this decision governs.
- [license-server API contract](../../shared/api-conventions/license-server-api.md) — the c3 ↔ LS
  public boundary.
- [license-server architecture](../license-server-architecture.md) — the LS service's own internal
  architecture (process shape, layering, activation flow, data model, signing chain).

## Revision — 2026-06-17 (activation model simplified)

The original activation model (one-time auth code → browser loopback → server-to-server claim →
separate heartbeat token, backed by dedicated activation-code/request/heartbeat tables) has been
**simplified** to a license-key binding model. The ADR's core decision is unchanged — entitlement
remains LS-authoritative, c3 verifies an Ed25519-signed token offline, and gating blocks only
new-session creation. What changed:

- **License-key binding replaces the one-time code.** A license is identified by a random, unique,
  **shareable `licenseKey`** (a handle, not a bearer credential). The user obtains it from LS and
  pastes it into c3, which **binds** the installation (`POST /v1/license/bind` with the key + an
  installation id). There is no c3-generated auth code, no browser loopback, and no separate
  server-to-server claim step.
- **Binding state is inlined on the license row.** The license carries its **exclusive live
  binding**: the bound installation, the **sha256 hash** of a per-binding **`aliveToken`** (the
  heartbeat bearer credential, returned in plaintext once at bind and rotated on each re-bind), and
  the last-success time. Re-binding to a new installation **displaces** the old one, which is reported
  `disabled` on its next heartbeat (it cannot be recovered offline).
- **GitHub OAuth is sign-in only.** GitHub now authenticates **account login/registration** and is
  no longer the activation vehicle. On first sign-in (after the user accepts the service agreement (incl. no-refund terms))
  LS issues a **default trial license** and shows its license key to copy.
- **Renewal is order-driven.** A user may hold multiple licenses; extending a license's term and
  status requires a paid **order** linked to that license (WeChat Pay payment capture remains a later
  milestone). The no-refund acceptance is recorded on the order for renewal, and at the sign-in gate
  for the trial.
- **Schema simplified.** Tables renamed to `c3_ls_user` / `c3_ls_order` / `c3_ls_license`; the
  one-time-code and heartbeat-history helper tables are removed. The `PL-R*` rule numbers are
  retained; their wording is updated to this model.
