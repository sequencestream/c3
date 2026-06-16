# Domain: product-license

| Field          | Value                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Responsibility | Govern whether a c3 installation is **commercially entitled** to create new work, and surface that state to the user. Enforced in c3; the authoritative record lives in the separate **license-server (LS)**.                        |
| API            | Outbound to LS over the [license-server API contract](../../../shared/api-conventions/license-server-api.md); inbound surfacing over the c3 WebSocket (see [shared protocol](../../../shared/api-conventions/websocket-protocol.md)) |
| Status         | in progress — LS service foundation built (config, caches, PostgreSQL migrations, health, public plan catalog, embedded web, single binary); activation/heartbeat/payment/OAuth flows pending                                        |

The product-license domain answers one question authoritatively: **is this installation paid-for?**
A c3 installation is **activated** once against the license-server, then **heartbeats**
periodically to confirm the entitlement is still valid and not revoked. Between heartbeats — and
through transient network or LS outages — c3 trusts an **LS-signed entitlement token** that it
verifies **offline** (Ed25519), within a **30-minute offline grace** of the last successful
heartbeat. When entitlement is not `active`, c3 **gates creation of new sessions** while leaving
existing sessions and in-flight runs untouched.

This is **not** authentication. The [auth domain](../../core/auth/auth-overview.md) controls _who_
may drive agents on a c3 instance (local access control, present even for a free/unlicensed
install); product-license controls _whether the product is paid for_ (server-authoritative
entitlement, independent of which auth provider is active). The two are deliberately separate
bounded contexts (ADR-0026).

**Scope:** activation, the heartbeat + offline-grace lifecycle, offline signature verification of
the entitlement token, new-session gating, the license badge/menu surfacing, the buyer payment +
no-refund-agreement flow (LS side), and admin license operations (LS side).

**Boundary — what this domain is NOT:**

- **Not authentication** ([auth](../../core/auth/auth-overview.md)) — it never decides who may
  connect or sign in.
- **Not the permission gateway** ([permission-gateway](../../core/permission-gateway/spec.md)) — it
  never decides individual tool calls; it only gates whether a **new** session may be created.
- **Not a run controller** — it never interrupts an in-flight run or an existing session
  (ADR-0006 runs survive; entitlement lapse stops _new_ work, not _current_ work).

## Index

- [spec.md](spec.md) — entities, the entitlement state machine, business rules `PL-R*`, the
  no-refund policy, admin operations, security invariants, user scenarios, and non-goals.
- [design.md](design.md) — c3-side gating mechanism, on-disk entitlement cache, heartbeat scheduler
  and grace timer, offline Ed25519 verification, and the license-server technical shape.
- [license-server API contract](../../../shared/api-conventions/license-server-api.md) — the
  c3 ↔ LS public boundary (activation, heartbeat, payment, error semantics).

## Roadmap (rollout milestones)

1. **This deliverable — architecture/spec foundation.** ADR-0026 records why LS exists and the
   accepted technologies; this domain + the LS API contract define the behavior and boundary. No
   runtime.
2. **LS MVP (authority core).** _Foundation in place_ — the standalone Go service boots from
   environment config, applies idempotent PostgreSQL migrations, serves a redacted health signal and
   the public plan catalog (`1m`/`6m`/`1y`), and embeds its web as a single binary. _Pending_ —
   License + activation + heartbeat records in PostgreSQL; Ed25519 signing of entitlement tokens;
   one-time/short-lived activation codes; heartbeat bearer tokens; admin issue/revoke/inspect over
   the GitHub-OAuth back-office.
3. **Buyer payment flow (LS web).** GitHub OAuth buyer login; WeChat Pay checkout; mandatory
   **no-refund service-agreement acceptance** before payment; order → activation-code issuance.
4. **c3-side enforcement.** Activation, the heartbeat scheduler, the on-disk entitlement cache, the
   30-minute offline grace, offline Ed25519 verification, new-session gating, and the license
   badge/menu in the console.
5. **Hardening.** Entitlement-cache file permissions + log redaction; activation rate-limiting;
   per-installation binding; revocation propagation latency targets.

Each milestone's acceptance criteria trace back to the rules and invariants in [spec.md](spec.md)
and the decision in [ADR-0026](../../../architecture/adr/0026-product-licensing-separate-license-server.md).
