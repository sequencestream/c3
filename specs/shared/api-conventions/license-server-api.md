# License-Server API Contract

The single source of truth for the **c3 ↔ license-server (LS)** public boundary. It defines the
endpoints c3 calls to bind a license and heartbeat, the buyer-facing sign-in/renewal surface on the
LS web, the credential and token lifecycle, and the error semantics. Behavior and rationale live in
the [product-license domain](../../domains/commerce/product-license/product-license-spec.md) and
[ADR-0026](../../architecture/adr/0026-product-licensing-separate-license-server.md); this document
is the **contract** — cite it by reference, do not restate the shapes elsewhere.

This is an **external HTTP contract** (a separate product, ADR-0026), not the c3 WebSocket wire
protocol. Field and endpoint names below are the external contract vocabulary (C-DOC-1).

## Transport & conventions

- **Transport:** HTTPS only. c3 never sends credentials or keys over plaintext HTTP.
- **Encoding:** JSON request and response bodies; a string `status` discriminates results.
- **Versioning:** endpoints are namespaced under a version prefix (e.g. `/v1/...`) so the contract
  can evolve without breaking activated installations.
- **Idempotency:** binding and heartbeat are safe to retry; re-binding the same license to the same
  installation is idempotent, and re-binding to a **new** installation displaces the old one (the
  old installation learns this on its next heartbeat, PL-R8).
- **Trust:** the **entitlement token** returned by binding and heartbeat is **Ed25519-signed** by LS
  and verified **offline** by c3 against an embedded public key. The HTTP channel is a transport; the
  signature — not the channel — is the basis of trust (product-license PL-R5).

## Credentials & tokens

| Credential / token    | Issued by / when                          | Lifetime                | Presented as / used for                                                                                                                                  |
| --------------------- | ----------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **License key**       | LS, when a license is created/issued      | lives with the license  | A **shareable handle** in the body of bind/heartbeat to identify the license. **Not a bearer credential** — never proves entitlement on its own (PL-R2). |
| **Alive token**       | LS, returned by binding (and rotated)     | per-binding, revocable  | In the body of every heartbeat to authenticate the bound installation. Returned in **plaintext only once** at bind; LS stores only its **sha256 hash**.  |
| **Entitlement token** | LS, signed, returned by binding/heartbeat | bounded validity window | Cached by c3; verified offline (Ed25519) to derive `active` (PL-R5).                                                                                     |
| **Installation id**   | c3, stable per installation               | stable                  | In the body of bind/heartbeat to identify which installation the license is bound to. The license binds **exclusively** to one installation at a time.   |

**Hard rule (PL-R2):** the license key and the alive token are distinct. The license key identifies
the license and may be shared or displayed; the alive token is the per-binding bearer credential
presented on every heartbeat. The license key alone can never complete a heartbeat.

## c3 → LS endpoints

### Bind

`POST /v1/license/bind` — binds an installation to a license and starts its live binding.

- **Request body:** `licenseKey` and `installationId`. No bearer credential — the license key plus a
  successful bind is the authorization.
- **LS checks:** the license **exists** and is **active** (status `active` and the term not lapsed).
- **Effect:** LS records the binding **exclusively** — it sets the license's bound installation to
  `installationId`, **rotates** the alive token (storing the new token's hash, overwriting any prior
  binding), and stamps the last-success time. A previously-bound installation is thereby **displaced**
  and will see `disabled` on its next heartbeat (PL-R8).
- **Success response (`status: "active"`):** `entitlementToken` (Ed25519-signed, with its validity
  window), `aliveToken` (plaintext, **once**), `termEnd`, and `heartbeatIntervalSeconds`. The
  response carries **no plan**: plan is purchase-catalog data (`GET /v1/plans`) that c3 neither
  consumes nor displays; the entitlement is the validity window only (product-license PL-R1).

### Heartbeat

`POST /v1/license/heartbeat` — confirms the installation still holds the binding and refreshes the
entitlement.

- **Request body:** `licenseKey`, `installationId`, and `aliveToken`.
- **LS looks up by `licenseKey`** and returns a discriminating `status` (HTTP 200 unless the key is
  unknown):
  - **`active`** — the installation id **and** alive token match the live binding, and the license is
    active and within term. LS refreshes the last-success time and returns a refreshed signed
    `entitlementToken`, `termEnd`, and the next `heartbeatIntervalSeconds` (no `plan` — see Bind).
  - **`disabled`** — the installation id or alive token does **not** match the live binding (the
    license was rebound to another installation, PL-R8). This installation must gate; it **cannot be
    recovered by going offline**.
  - **`expired`** — the license is no longer `active` (an admin force-expired it, status `expired`)
    or its term has ended.
- **Unknown `licenseKey`:** `404`.
- **Effect on c3:** a successful (`active`) heartbeat resets the **30-minute offline-grace** deadline
  and caches the refreshed token (PL-R3/PL-R4). A `disabled` / `expired` status — returned
  with **HTTP 200** so it is distinguishable from a network failure — lapses the installation to gated
  (PL-R6/PL-R8).

## Public LS surfaces (foundation)

These endpoints require no credential and are part of the LS product's foundation. They are public
because they carry no entitlement secret: the catalog is the same for every visitor and health is a
redacted operational signal.

### Plan catalog

- **`GET /v1/plans`** — the public catalog of purchasable license terms. Returns a `plans` array;
  each plan carries a **stable `id`**, a display `name`, a `durationMonths`, a `priceCents` (the
  price in the currency's minor unit), and a `currency` (ISO-4217). Plan ids are stable once
  published so orders and links can reference them. The MVP catalog is three plans: `1m` (1 month,
  100 cents), `6m` (6 months, 590 cents), and `1y` (1 year, 1090 cents), denominated in `CNY`.

### Health

- **`GET /healthz`** — liveness for operators/load-balancers. Returns a status, the LS version, and
  a **redacted** configuration view in which every secret (database DSN, signing key, OAuth secret,
  payment key) is reduced to a presence indicator and **never** its value (PL-R12).

## Sign-in & license-key issuance (LS web — buyer-facing)

GitHub sign-in is used **only** to log in / register an account and obtain a license key. It no
longer carries the activation action; activation is the separate license-key binding above.

- **`GET /activate`** — the account page: it renders the **service agreement (incl. no-refund terms)** for the
  user to read and accept **before** signing in (PL-R9).
- **`POST /activate/accept`** — records acceptance of the service agreement (incl. no-refund terms) (with version +
  timestamp) and initiates **GitHub OAuth** sign-in. Without a recorded acceptance, sign-in is
  refused.
- **`GET /auth/github/callback`** — the OAuth callback. LS exchanges the authorization code for a
  GitHub access token, fetches the GitHub identity, **creates or updates the account**, and — for a
  new account — issues a **default trial license** with a fresh **license key**. It establishes the
  buyer's browser **sign-in session** (a signed, HMAC-keyed cookie; no server-side session store) so
  the renewal checkout can be reached without re-authenticating, then **displays the license key** for
  the user to copy and paste into c3.

No signed token or bearer credential is exposed in the browser: the page shows only the
shareable license key (PL-R2), and binding happens later when the user pastes that key into c3.

## LS web (buyer & admin) surface

These endpoints are part of the LS product, not called by c3; documented here so the boundary is
complete.

### Renewal purchase flow

A user may hold **multiple licenses**; extending a license's term and status requires a paid order
(PL-R9). The flow:

1. **Sign in** — GitHub OAuth account login (PL-R9). The checkout endpoints require the signed-in
   session cookie; an unauthenticated visitor is redirected to `GET /activate`.
2. **Choose a plan + accept the service agreement (incl. no-refund terms)** — `GET /checkout` renders
   the purchasable plans (the `GET /v1/plans` catalog with the trial plan excluded) and the renewal
   target license; `POST /checkout` creates a **`pending`** order. Acceptance (with version +
   timestamp) is recorded **on the order**; a checkout without acceptance is **refused** (400). The
   order's `amountCents`/`currency` are **derived server-side from the plan** — any client-supplied
   amount is **ignored** — so a buyer can never dictate the charge (PL-R9).
3. **Pay** — WeChat Pay. On a confirmed payment, LS marks the **order** paid and **extends the linked
   license's `termEnd` and status**. (Payment capture is a later milestone; the order → license
   extension relationship is fixed now.)
4. **Inspect** — a signed-in user may view their licenses (and their license keys), orders, and
   binding status.

| Method | Path        | Purpose                                                                                                   |
| ------ | ----------- | --------------------------------------------------------------------------------------------------------- |
| GET    | `/checkout` | Renewal page: choose a plan + the target license and accept the service agreement (sign-in required)      |
| POST   | `/checkout` | Create a `pending` order — amount derived server-side from the plan; refused without agreement acceptance |

There is **no refund endpoint** in the MVP (PL-R10) — the product is a virtual/digital good and the
service agreement does not support refunds.

### Admin back-office

An admin authenticated via GitHub OAuth (PL-R11) may **issue**, **force-expire** (set status
`expired`), and **inspect** licenses, bindings, and orders. Admin changes mutate the authoritative
record; they reach a c3 installation only on its next heartbeat (PL-R8).

## Error semantics

c3 interprets LS responses fail-soft — an error never crashes c3 or interrupts a running session; it
only affects whether **new** sessions may be created once the grace window is exhausted (PL-R6/PL-R13).

| Condition                          | Meaning to c3                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **unknown license key (404)**      | The license key does not exist; binding/heartbeat rejected. Surface the reason; the user may re-check or paste a different key.                                                            |
| **expired license (bind)**         | Binding rejected because the license is not `active` (status `expired` or the term ended); remain `Unactivated`.                                                                           |
| **status `disabled` (heartbeat)**  | The installation id / alive token no longer match the live binding — the license was rebound elsewhere (PL-R8). Gate; cannot be recovered offline.                                         |
| **status `expired` (heartbeat)**   | The license is not `active` (an admin force-expired it, or the term ended); lapse to gated.                                                                                                |
| **rate-limited**                   | Too many bind/heartbeat attempts; back off and retry. Within grace, entitlement is unaffected.                                                                                             |
| **unavailable**                    | The bind/heartbeat surface is temporarily disabled (LS not fully configured, or a maintenance window). c3 surfaces a retry hint and falls back to the 30-minute offline grace.             |
| **network / unreachable**          | Not an LS verdict; treat as a failing heartbeat and rely on the 30-minute offline grace (PL-R4). Distinguished from the `disabled`/`expired` verdicts, which arrive as HTTP 200.           |
| **signature verification failure** | c3-side, not an HTTP status: a returned entitlement token whose Ed25519 signature does not verify is treated as **not entitled** (deny-by-default, PL-R5), regardless of the HTTP success. |

## Invariants (cross-referenced)

- The **license key** is a shareable **handle**, **never** a heartbeat credential; the per-binding
  **alive token** authenticates heartbeats (PL-R2).
- Binding is **exclusive**: one installation per license; re-binding displaces the previous one,
  which is reported `disabled` on its next heartbeat and cannot out-wait the grace window (PL-R8).
- Trust is the **Ed25519 signature**, verified **offline**; the HTTP channel is never the basis of
  trust (PL-R5).
- Errors are **fail-soft for current work**: they gate only **new** sessions, never interrupt
  running ones (PL-R6/PL-R13).
- Only the **public** verification key lives in c3; signing keys, OAuth secrets, and payment
  credentials live only in LS (PL-R12).

## References

- [product-license domain spec](../../domains/commerce/product-license/product-license-spec.md) — `PL-R*` rules and
  the entitlement state machine.
- [product-license design](../../domains/commerce/product-license/product-license-design.md) — c3-side mechanism and
  LS technical shape.
- [ADR-0026](../../architecture/adr/0026-product-licensing-separate-license-server.md) — why LS
  exists and the accepted technologies.
