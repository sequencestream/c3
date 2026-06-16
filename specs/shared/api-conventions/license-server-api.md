# License-Server API Contract

The single source of truth for the **c3 ↔ license-server (LS)** public boundary. It defines the
endpoints c3 calls to activate and heartbeat, the buyer-facing payment/order surface on the LS web,
the credential and token lifecycle, and the error semantics. Behavior and rationale live in the
[product-license domain](../../domains/commerce/product-license/spec.md) and
[ADR-0026](../../architecture/adr/0026-product-licensing-separate-license-server.md); this document
is the **contract** — cite it by reference, do not restate the shapes elsewhere.

This is an **external HTTP contract** (a separate product, ADR-0026), not the c3 WebSocket wire
protocol. Field and endpoint names below are the external contract vocabulary (C-DOC-1).

## Transport & conventions

- **Transport:** HTTPS only. c3 never sends credentials or codes over plaintext HTTP.
- **Encoding:** JSON request and response bodies; a string `type`/`status` discriminates results.
- **Versioning:** endpoints are namespaced under a version prefix (e.g. `/v1/...`) so the contract
  can evolve without breaking activated installations.
- **Idempotency:** activation and heartbeat are safe to retry; a retried activation with an
  already-consumed code returns the consumed-code error, never a second activation.
- **Trust:** the **entitlement token** returned by activation and heartbeat is **Ed25519-signed** by
  LS and verified **offline** by c3 against an embedded public key. The HTTP channel is a transport;
  the signature — not the channel — is the basis of trust (product-license PL-R5).

## Credentials & tokens

| Credential / token    | Issued by / when                             | Lifetime                  | Presented as / used for                                                       |
| --------------------- | -------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| **Activation code**   | LS, on a paid order or admin issuance        | **short-lived, one-time** | Body of the activation request only. **Never** a heartbeat credential.        |
| **Heartbeat token**   | LS, returned by activation                   | long-lived, revocable     | `Authorization: Bearer <token>` on every heartbeat. The long-term credential. |
| **Entitlement token** | LS, signed, returned by activation/heartbeat | bounded validity window   | Cached by c3; verified offline (Ed25519) to derive `active` (PL-R5).          |

**Hard rule (PL-R2):** the activation code and the heartbeat token are distinct. The activation
code authorizes a one-time activation and is consumed; the heartbeat token is the credential for the
ongoing heartbeat. c3 must discard the activation code after activation; LS must reject any attempt
to present an activation code as a heartbeat bearer credential.

## c3 → LS endpoints

### Activate

Redeems a one-time activation code and binds the installation.

- **Request:** the **activation code** plus an installation identifier (a stable per-installation
  value used to bind the entitlement). No bearer credential — the code is the authorization.
- **Success response:** a **signed entitlement token** (with its validity window), a **heartbeat
  token** (bearer), and the **heartbeat interval** to use until told otherwise.
- **Effect:** the activation code is **consumed** (single-use). A subsequent activation requires a
  new code.

### Heartbeat

Confirms the installation is still entitled and refreshes the entitlement.

- **Request:** `Authorization: Bearer <heartbeat token>` plus the installation identifier. The
  activation code is **never** sent here.
- **Success response:** the current entitlement **status** (`active` / `revoked` / `expired`), and —
  when still entitled — a refreshed **signed entitlement token** and the **next heartbeat interval**.
- **Effect on c3:** a successful heartbeat resets the **30-minute offline-grace** deadline and caches
  any refreshed token (PL-R3/PL-R4). A `revoked`/`expired` status lapses the installation to gated
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

## LS web (buyer & admin) surface

These endpoints are part of the LS product, not called by c3; documented here so the boundary is
complete.

### Buyer purchase flow

1. **Buyer login** — GitHub OAuth (PL-R9).
2. **Accept no-refund agreement** — the buyer must record acceptance of the no-refund service
   agreement **before** payment; the acceptance (with version + timestamp) is stored on the order
   (PL-R9). A payment attempt without a recorded acceptance is refused.
3. **Pay** — WeChat Pay. On a confirmed payment, LS creates the **order** and issues a one-time,
   short-lived **activation code** to the buyer.
4. **Inspect** — a logged-in buyer may view their licenses, orders, and activation status.

There is **no refund endpoint** in the MVP (PL-R10) — the product is a virtual/digital good and the
service agreement does not support refunds.

### Admin back-office

An admin authenticated via GitHub OAuth (PL-R11) may **issue**, **revoke**, and **inspect**
licenses, activations, orders, and heartbeat history. Admin changes mutate the authoritative record;
they reach a c3 installation only on its next heartbeat (PL-R8).

## Error semantics

c3 interprets LS responses fail-soft — an error never crashes c3 or interrupts a running session; it
only affects whether **new** sessions may be created once the grace window is exhausted (PL-R6/PL-R13).

| Condition                          | Meaning to c3                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **invalid / unknown code**         | Activation rejected; remain `Unactivated`. Surface the reason; the user may retry with a new code.                                                                                         |
| **expired code**                   | Activation rejected (short-lived code lapsed, PL-R1); remain `Unactivated`.                                                                                                                |
| **consumed code**                  | Activation rejected (single-use, PL-R1); remain `Unactivated`.                                                                                                                             |
| **unauthorized heartbeat**         | The heartbeat token is missing/invalid/revoked; treat as a failing heartbeat — run the grace timer, then gate (PL-R4/PL-R8).                                                               |
| **revoked**                        | Entitlement revoked (PL-R8); lapse to gated. Recovery needs admin re-issue + re-activation.                                                                                                |
| **expired entitlement**            | The license term ended; lapse to gated after the cached token's window/grace.                                                                                                              |
| **rate-limited**                   | Too many activation/heartbeat attempts; back off and retry. Within grace, entitlement is unaffected.                                                                                       |
| **network / unreachable**          | Not an LS verdict; treat as a failing heartbeat and rely on the 30-minute offline grace (PL-R4).                                                                                           |
| **signature verification failure** | c3-side, not an HTTP status: a returned entitlement token whose Ed25519 signature does not verify is treated as **not entitled** (deny-by-default, PL-R5), regardless of the HTTP success. |

## Invariants (cross-referenced)

- Activation codes are **one-time + short-lived** and **never** heartbeat credentials (PL-R1/PL-R2).
- Trust is the **Ed25519 signature**, verified **offline**; the HTTP channel is never the basis of
  trust (PL-R5).
- Errors are **fail-soft for current work**: they gate only **new** sessions, never interrupt
  running ones (PL-R6/PL-R13).
- Only the **public** verification key lives in c3; signing keys, OAuth secrets, and payment
  credentials live only in LS (PL-R12).

## References

- [product-license domain spec](../../domains/commerce/product-license/spec.md) — `PL-R*` rules and
  the entitlement state machine.
- [product-license design](../../domains/commerce/product-license/design.md) — c3-side mechanism and
  LS technical shape.
- [ADR-0026](../../architecture/adr/0026-product-licensing-separate-license-server.md) — why LS
  exists and the accepted technologies.
