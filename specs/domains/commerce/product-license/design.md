# product-license — Domain Design

The technical shape of how c3 enforces entitlement and how the license-server (LS) asserts it. WHAT
and WHY live in [spec.md](spec.md); this document describes HOW at boundary altitude. No source
references (C-DOC-1); external standards (Ed25519, PostgreSQL, GitHub OAuth, WeChat Pay, Go
standard-library HTTP) and the [LS API contract](../../../shared/api-conventions/license-server-api.md)
are the allowed vocabulary.

## Split of responsibility

| Concern                            | Owner | Notes                                                                                  |
| ---------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| Authoritative entitlement record   | LS    | Licenses, orders, activations, heartbeats, revocations — in PostgreSQL                 |
| Token signing                      | LS    | Ed25519 private key; signs entitlement tokens                                          |
| Buyer identity + admin identity    | LS    | GitHub OAuth (both roles, single identity source)                                      |
| Payment                            | LS    | WeChat Pay; no-refund-agreement acceptance recorded before charge                      |
| Offline token verification         | c3    | Ed25519 **public** key embedded in the binary                                          |
| Heartbeat scheduling + grace timer | c3    | In-process; bounded by the 30-minute offline grace                                     |
| New-session gating + surfacing     | c3    | Gates creation only; renders the badge/menu                                            |
| Entitlement cache                  | c3    | Small on-disk store: last signed token + heartbeat bearer token (accepted by ADR-0026) |

## c3-side mechanism

### Entitlement cache (the one accepted persistent store)

c3 keeps a **small on-disk entitlement cache** holding (a) the most recent LS-signed entitlement
token and (b) the heartbeat bearer token. This is the single new persistent store ADR-0026 accepts
on the c3 side; it exists so the 30-minute offline grace and restart continuity work. It carries
**no signing key and no OAuth/payment secret** — only the public verification key (embedded in the
binary) is needed to check the token. The file is treated as sensitive (hardening — permissions +
log redaction — is a later milestone, mirroring the auth settings-file roadmap).

### Heartbeat scheduler + grace timer

A process-local scheduler heartbeats LS at the interval LS dictates (returned on each heartbeat). It
maintains two timestamps: **last-successful-heartbeat** and the derived **grace deadline**
(last success + 30 minutes). On each successful heartbeat it updates both, caches any refreshed
token, and applies the next interval. On a failed heartbeat it retries (without crashing or
interrupting any run) and lets the grace timer run; once the grace deadline passes with no success,
the derived entitlement state lapses (see the [spec.md](spec.md) state machine). The scheduler is
**fail-soft**: heartbeat errors never propagate into the run path.

### Offline verification

Before honoring `active`, c3 verifies the entitlement token's **Ed25519** signature against the
embedded public key and checks the token's validity window. Verification is **offline** — it does
not require LS to be reachable. A verification failure is deny-by-default: the installation is
treated as not entitled, which gates _new_ sessions only (existing sessions and in-flight runs are
untouched). This is the existing release-signing discipline (ADR-0010) reused for entitlement.

### Gating point

Entitlement is consulted at exactly one decision point: **new-session creation**. When the derived
state does not permit new sessions (`Unactivated` / `Expired` / `Revoked`), creation is refused with
a clear, surfaced reason; the user is directed to the license menu. The run lifecycle, existing
sessions, and the permission gateway are never consulted or altered by this domain (ADR-0006: runs
survive independently of connections and, here, of entitlement lapse).

### Surfacing

The current derived entitlement state is pushed to the web-console, which renders a **license
badge** (entitled / grace / expired / unactivated / revoked) and a **license menu** (activate, view
status, purchase link). The badge is informational; it never blocks the UI on its own — enforcement
is the gating point above.

## License-server technical shape

- **Runtime:** Go standard-library HTTP — a small, auditable surface, no heavy framework.
- **Store:** PostgreSQL — licenses, orders, activations, heartbeat history, and revocations.
- **Identity:** GitHub OAuth for both buyer login (self-service purchase/inspection) and the admin
  back-office (issue/revoke/inspect).
- **Payment:** WeChat Pay; the **no-refund service-agreement acceptance** is recorded **before** the
  charge, and a paid order issues a one-time, short-lived activation code to the buyer.
- **Signing:** an Ed25519 private key held only by LS signs entitlement tokens; the matching public
  key is published for embedding in the c3 binary. Key custody, rotation, and the staging of public
  keys are an LS-operations concern (a later milestone), analogous to the release-signing key handoff.
- **Credentials issued at activation:** a **signed entitlement token** (offline-verifiable, with a
  validity window) plus a **heartbeat bearer token** (long-lived, revocable, presented as a bearer
  credential on every heartbeat — never the activation code).

## State machine

See the [spec.md](spec.md) § States & transitions for the authoritative c3-side Entitlement state
machine (`Unactivated → Active ⇄ Grace → Expired`, plus `Revoked`). The design adds no states; it
realizes those transitions via the heartbeat scheduler + grace timer + offline verification above.

## API design

The c3 ↔ LS boundary — activation, heartbeat, payment/order endpoints, token issuance,
bearer-token heartbeat, and error semantics — is documented once in the
[license-server API contract](../../../shared/api-conventions/license-server-api.md) and cited by
reference here (C-DOC-1: single source of truth for the external contract).

## Non-functional considerations

- **Security:** offline Ed25519 verification (trust from the signature, not the network); deny-by-
  default on verification failure; one-time/short-lived activation codes; revocable heartbeat token;
  only the public key in c3; secret-by-reference for all LS secrets. See
  [non-functional/security.md](../../../non-functional/security.md) § Product licensing.
- **Availability:** the 30-minute offline grace keeps a paying user productive through transient LS
  or network outages; only a sustained lapse gates new work. A permanently unreachable LS eventually
  gates new-session creation but never interrupts existing work.
- **Performance:** activation and heartbeat are infrequent, off the hot path, and fail-soft —
  neither blocks a run or a UI interaction.

## Dependencies

- **Outbound to LS** — required for activation and heartbeat; degrades gracefully (offline grace,
  then new-session gating) when unreachable. Never a hard boot dependency for c3.
- **Embedded LS public key** — a build-time input to c3; without a matching public key, tokens
  cannot be verified and the installation is treated as unactivated.
- **web-console** — renders the badge/menu and the activation entry.
- **session-registry** — the gating point at new-session creation.
