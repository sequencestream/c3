# Domain: product-license

| Field          | Value                                                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responsibility | Govern whether a c3 installation is **commercially entitled** to create new work, and surface that state to the user. Enforced in c3; the authoritative record lives in the separate **license-server (LS)**.                                                                                                                |
| API            | Outbound to LS over the [license-server API contract](../../../shared/api-conventions/license-server-api.md); inbound surfacing over the c3 WebSocket (see [shared protocol](../../../shared/api-conventions/websocket-protocol.md))                                                                                         |
| Status         | in progress — LS foundation built (config, caches, PostgreSQL schema, health, public plan catalog, embedded web, single binary); browser-mediated GitHub sign-in + default-license provisioning + activate/bind/checkbind + heartbeat; renewal payment (WeChat Pay Native) + order reconcile live; admin back-office pending |

The product-license domain answers one question authoritatively: **is this installation paid-for?**
Binding is **browser-mediated**: c3 generates an `installId` + `requestId`, opens the browser to the
license-server where the user signs in and **selects a license to bind**, then c3 server collects the
binding via **checkbind** and **heartbeats** periodically (with `installId` + alive token) to confirm
the entitlement is still valid and not expired or displaced. Between heartbeats — and through transient
network or LS outages — c3 trusts an **LS-signed entitlement token** that it verifies **offline**
(Ed25519), within a **30-minute offline grace** of the last successful heartbeat. When entitlement
is not `active`, c3 **gates creation of new sessions** while leaving existing sessions and in-flight
runs untouched.

This is **not** authentication. The [auth domain](../../core/auth/auth-overview.md) controls _who_
may drive agents on a c3 instance (local access control, present even for a free/unlicensed
install); product-license controls _whether the product is paid for_ (server-authoritative
entitlement, independent of which auth provider is active). The two are deliberately separate
bounded contexts (ADR-0026).

**Scope:** account sign-in + trial issuance (LS side), license-key binding, the heartbeat +
offline-grace lifecycle, offline signature verification of the entitlement token, new-session
gating, the license badge/menu surfacing, the renewal payment + no-refund-agreement flow (LS side),
and admin license operations (LS side).

**Boundary — what this domain is NOT:**

- **Not authentication** ([auth](../../core/auth/auth-overview.md)) — it never decides who may
  connect or sign in.
- **Not the permission gateway** ([permission-gateway](../../core/permission-gateway/permission-gateway-spec.md)) — it
  never decides individual tool calls; it only gates whether a **new** session may be created.
- **Not a run controller** — it never interrupts an in-flight run or an existing session
  (ADR-0006 runs survive; entitlement lapse stops _new_ work, not _current_ work).

## Index

- [product-license-spec.md](product-license-spec.md) — entities, the entitlement state machine, business rules `PL-R*`, the
  no-refund policy, admin operations, security invariants, user scenarios, and non-goals.
- [product-license-design.md](product-license-design.md) — c3-side gating mechanism, on-disk entitlement cache, heartbeat scheduler
  and grace timer, offline Ed25519 verification, and the license-server technical shape.
- [license-server API contract](../../../shared/api-conventions/license-server-api.md) — the
  c3 ↔ LS public boundary (license-key binding, heartbeat, error semantics).

## Roadmap (rollout milestones)

1. **This deliverable — architecture/spec foundation.** ADR-0026 records why LS exists and the
   accepted technologies; this domain + the LS API contract define the behavior and boundary. No
   runtime.
2. **LS MVP (authority core).** _In place_ — the standalone Go service boots from environment config,
   applies the idempotent PostgreSQL schema, serves a redacted health signal and the public plan
   catalog (`1m`/`6m`/`1y`), embeds its web as a single binary; **GitHub sign-in/registration** with
   **trial-license issuance** (random license key shown to the user); **license-key binding**
   (Ed25519-signed entitlement token + alive token, exclusive per installation); and **heartbeat**
   (active / disabled / expired). _Pending_ — admin issue/force-expire/inspect over the
   GitHub-OAuth back-office.
3. **Renewal payment flow (LS web).** GitHub-account checkout; WeChat Pay; mandatory **no-refund
   service-agreement acceptance on the order** before payment; a paid order → extension of the linked
   license's term and status.
4. **c3-side enforcement.** License-key binding, the heartbeat scheduler, the on-disk entitlement
   cache, the 30-minute offline grace, offline Ed25519 verification, new-session gating, and the
   license badge/menu in the console.
5. **Hardening.** Entitlement-cache file permissions + log redaction; bind/heartbeat rate-limiting;
   displacement/revocation propagation latency targets.

Each milestone's acceptance criteria trace back to the rules and invariants in [product-license-spec.md](product-license-spec.md)
and the decision in [ADR-0026](../../../architecture/adr/0026-product-licensing-separate-license-server.md).
