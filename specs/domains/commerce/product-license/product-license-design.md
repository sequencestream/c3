# product-license — Domain Design

The technical shape of how c3 enforces entitlement and how the license-server (LS) asserts it. WHAT
and WHY live in [product-license-spec.md](product-license-spec.md); this document describes HOW at boundary altitude. No source
references (C-DOC-1); external standards (Ed25519, PostgreSQL, GitHub OAuth, WeChat Pay, Go
standard-library HTTP) and the [LS API contract](../../../shared/api-conventions/license-server-api.md)
are the allowed vocabulary.

## Split of responsibility

| Concern                            | Owner | Notes                                                                                |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------ |
| Authoritative entitlement record   | LS    | Licenses (with their live binding), orders, revocations — in PostgreSQL              |
| Token signing                      | LS    | Ed25519 private key; signs entitlement tokens                                        |
| Account identity + admin identity  | LS    | GitHub OAuth — used **only** for sign-in/registration (both roles, single source)    |
| Payment (renewal)                  | LS    | WeChat Pay; no-refund-agreement acceptance recorded on the order before charge       |
| Offline token verification         | c3    | Ed25519 **public** key embedded in the binary                                        |
| Heartbeat scheduling + grace timer | c3    | In-process; bounded by the 30-minute offline grace                                   |
| New-session gating + surfacing     | c3    | Gates creation only; renders the badge/menu                                          |
| Entitlement cache                  | c3    | Small on-disk store: signed token + license key + alive token (accepted by ADR-0026) |

## c3-side mechanism

### Entitlement cache (the one accepted persistent store)

c3 keeps a **small on-disk entitlement cache** holding the installation identifier, the **license
key**, the most recent LS-signed **entitlement token**, the **alive token**, and the derived
state/term/last-success metadata. This is the single new persistent store ADR-0026 accepts on the c3
side; it exists so the 30-minute offline grace and restart continuity work. It carries **no signing
key and no OAuth/payment secret** — only the public verification key (embedded in the binary) is
needed to check the token. The file is treated as sensitive: it is written with **0600** permissions
(owner read/write only) to protect the alive token (the heartbeat bearer credential) from other
users on the same machine. Log redaction is a later milestone, mirroring the auth settings-file
roadmap.

### Heartbeat scheduler + grace timer

A process-local scheduler heartbeats LS at the interval LS dictates (returned on each heartbeat). It
maintains two timestamps: **last-successful-heartbeat** and the derived **grace deadline**
(last success + 30 minutes). On each successful heartbeat it updates both, caches any refreshed
token, and applies the next interval. On a failed heartbeat it retries (without crashing or
interrupting any run) and lets the grace timer run; once the grace deadline passes with no success,
the derived entitlement state lapses (see the [product-license-spec.md](product-license-spec.md) state machine). The scheduler is
**fail-soft**: heartbeat errors never propagate into the run path.

### Offline verification

Before honoring `active`, c3 verifies the entitlement token's **Ed25519** signature against the
embedded public key and checks the token's validity window. Verification is **offline** — it does
not require LS to be reachable. A verification failure is deny-by-default: the installation is
treated as not entitled, which gates _new_ sessions only (existing sessions and in-flight runs are
untouched). This is the existing release-signing discipline (ADR-0010) reused for entitlement.

### Gating point

Entitlement is consulted at exactly one decision point: **new-session creation**. When the derived
state does not permit new sessions (`Unactivated` / `Expired` / `Disabled`, the last being a license
rebound to another installation — a displaced binding), creation is refused with a clear, surfaced
reason; the user is directed to the license menu. The run lifecycle, existing sessions, and the
permission gateway are never consulted or altered by this domain (ADR-0006: runs survive
independently of connections and, here, of entitlement lapse).

### Surfacing

The current derived entitlement state is pushed to the web-console, which renders a **license
badge** (entitled / grace / expired / unactivated / disabled) and a **license menu** (activate, view
status, purchase link). For an entitled badge (`active`/`grace`) the console also renders the
**term-end date** carried in the pushed `LicenseStatus.termEnd` (unix seconds; `0` ⇒ no date), so
the user sees the validity/expiry of the purchased service. The badge is informational; it never
blocks the UI on its own — enforcement is the gating point above.

## License-server technical shape

- **Runtime:** Go standard-library HTTP — a small, auditable surface, no heavy framework.
- **Foundation surface:** the authority core boots from environment-driven configuration only (no
  config file), applies its PostgreSQL schema via **idempotent** migrations on startup, and serves a
  redacted **health** signal plus the public **plan catalog**. All secrets (signing key, OAuth and
  payment credentials, database DSN) are presence-only in any health/log output (PL-R12). The whole
  service — including the embedded web — ships as a **single binary**.
- **Plan catalog:** the public, fixed set of purchasable terms is **persisted** in its own table and
  served over the LS API contract's `GET /v1/plans`. A code-owned set (`internal/plans`) is the
  bootstrap source: it is seeded into the table on startup with `INSERT ... ON CONFLICT DO NOTHING`,
  so a fresh database is populated while existing rows survive — the database is the live store after
  the first seed, and `GET /v1/plans` falls back to the code catalog only when the database is
  unavailable. Prices are integer minor units (cents) in CNY (WeChat Pay's settlement currency); plan
  ids are stable once published.
- **Caching:** infrequently-changing read paths (the plan catalog today; license, auth, and payment
  lookups as those surfaces land) are served through bounded in-process LRU caches.
- **Embedded web:** the buyer/admin frontend is built and embedded into the binary and served with a
  single-page-app fallback; no external asset directory is required at runtime.
- **Store:** PostgreSQL — four tables. The **account** record (GitHub identity), the **plan** record
  (the persisted public catalog, bootstrapped from code), the **license** record (the only entitlement
  row, identified by a random unique **license key** and carrying its **live binding inline**: the
  bound installation id, the **sha256 hash** of the current alive token, and the last-success time),
  and the **order** record (purchase + no-refund acceptance, linked to the license it extends). The alive token's raw value is bearer-equivalent, so only its hash is
  stored — limiting exposure if the database is compromised. There are no separate one-time-code or
  heartbeat-history tables; binding/heartbeat state lives on the license row. LS data is kept in its
  own schema area, separate from any c3 store.
- **Identity:** GitHub OAuth used **only** for account sign-in/registration — buyer login
  (purchase/inspection) and the admin back-office (issue/force-expire/inspect). It no longer carries the
  activation action.
- **Trial issuance:** on first sign-in (after the user accepts the no-refund agreement) LS creates
  the account and, **when a trial plan is configured** (the first catalog plan flagged `is_trial`),
  issues a **default trial license** with a fresh license key, then displays the key for the user to
  copy and paste into c3. With no trial plan configured, no trial is issued and the buyer must purchase.
- **Payment (renewal):** WeChat Pay; the **no-refund service-agreement acceptance** is recorded on
  the **order before** the charge, and a paid order **extends the linked license's term and status**.
  Payment capture is a later milestone — the order → license-extension relationship is defined now.
- **Signing:** an Ed25519 private key held only by LS signs entitlement tokens; the matching public
  key is published for embedding in the c3 binary. Key custody, rotation, and the staging of public
  keys are an LS-operations concern (a later milestone), analogous to the release-signing key handoff.
- **Credentials issued at binding:** a **signed entitlement token** (offline-verifiable, with a
  validity window) plus an **alive token** (the per-binding bearer credential, returned in plaintext
  only once at bind, rotated on each re-bind, presented on every heartbeat — never the license key
  alone).

## State machine

See the [product-license-spec.md](product-license-spec.md) § States & transitions for the authoritative c3-side Entitlement state
machine (`Unactivated → Active ⇄ Grace → Expired`, plus `Disabled`). The design adds no states; it
realizes those transitions via the heartbeat scheduler + grace timer + offline verification above.

## API design

The c3 ↔ LS boundary — license-key binding, heartbeat, payment/order endpoints, token issuance,
alive-token heartbeat, and error semantics — is documented once in the
[license-server API contract](../../../shared/api-conventions/license-server-api.md) and cited by
reference here (C-DOC-1: single source of truth for the external contract).

## Non-functional considerations

- **Security:** offline Ed25519 verification (trust from the signature, not the network); deny-by-
  default on verification failure; license key as a non-bearer handle; exclusive binding with a
  rotated, hash-stored alive token; only the public key in c3; secret-by-reference for all LS
  secrets. See
  [non-functional/security.md](../../../non-functional/security.md) § Product licensing.
- **Availability:** the 30-minute offline grace keeps a paying user productive through transient LS
  or network outages; only a sustained lapse gates new work. A permanently unreachable LS eventually
  gates new-session creation but never interrupts existing work.
- **Performance:** activation and heartbeat are infrequent, off the hot path, and fail-soft —
  neither blocks a run or a UI interaction.

## Dependencies

- **Outbound to LS** — required for license-key binding and heartbeat; degrades gracefully (offline
  grace, then new-session gating) when unreachable. Never a hard boot dependency for c3.
- **Embedded LS public key** — a build-time input to c3; without a matching public key, tokens
  cannot be verified and the installation is treated as unactivated.
- **web-console** — renders the badge/menu and the activation entry.
- **session-registry** — the gating point at new-session creation.
