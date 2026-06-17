# license-server (LS)

The c3 **license authority** — a standalone Go service that owns the
authoritative commercial-entitlement record, the plan catalog, and the buyer/
admin web. It is deliberately **separate** from the c3 process: the database,
identity provider, payment integration, and public network listener it needs are
forbidden inside c3 and live here instead (see
[ADR-0026](../specs/architecture/adr/0026-product-licensing-separate-license-server.md)).

The **foundation** milestone (config, caches, schema, health, plan catalog,
static serving) is complete. The **sign-in & license-key binding** model is now
live (see the
[product-license domain spec](../specs/domains/commerce/product-license/product-license-spec.md)):
the user accepts the no-refund agreement and signs in with GitHub (sign-in only —
no longer the activation vehicle), LS creates the account and issues a default
trial license with a random **license key** shown on the page; the user pastes
that key into c3, which **binds** the installation (`POST /v1/license/bind`,
returning an Ed25519-signed entitlement token + a per-binding `aliveToken`) and
then **heartbeats** (`POST /v1/license/heartbeat`). Renewal payment (WeChat Pay)
and the admin back-office are later milestones.

## Stack

- **HTTP:** Go standard library `net/http` `ServeMux` — no framework (ADR-0026).
- **Store:** PostgreSQL, via GORM's Postgres driver. Three tables —
  `c3_ls_user` (GitHub account), `c3_ls_license` (the entitlement record, keyed
  by a random unique `license_key`, with its exclusive live binding inlined:
  `alive_install_id` / `alive_token` (sha256 hash) / `alive_time`), and
  `c3_ls_order` (purchase + no-refund acceptance, linked to the license it
  extends). Schema lives in [`database/sql/`](database/sql/) as one idempotent
  DDL file per table, applied in full on every startup (no migration ledger — see
  [`database/tables.md`](database/tables.md)).
- **Frontend:** a minimal Vue 3 + Vite app in [`web/`](web/), built to
  `web/dist/` and **embedded** into the binary (`//go:embed`), served with SPA
  fallback.
- **Caches:** in-process LRU caches (plan catalog today; license/auth/payment
  read paths wired for later).

## Layout

```
license-server/
  cmd/license-server/      entrypoint (config → caches → db/schema → http)
  internal/config/         env-driven config + redaction
  internal/cache/          generic LRU + named cache registry
  internal/plans/          the fixed plan catalog
  internal/agreement/      no-refund service agreement (single source, PL-R9)
  internal/oauth/          GitHub OAuth client for account sign-in
  internal/token/          Ed25519 entitlement token signing (PL-R5)
  internal/store/          PostgreSQL data access (users, licenses + live binding, orders)
  internal/httpapi/        ServeMux, /healthz, /v1/plans, sign-in + bind/heartbeat, static + SPA fallback
  internal/version/        build version
  scripts/gen-keypair/     Dev Ed25519 keypair generator
  database/                PostgreSQL schema — one idempotent DDL file per table (embedded) + index
  web/                     Vue source; web/dist is committed + embedded
```

## Endpoints

### Foundation

| Method | Path         | Purpose                                                          |
| ------ | ------------ | ---------------------------------------------------------------- |
| GET    | `/healthz`   | Liveness + **redacted** config (secrets shown as `set`/`unset`)  |
| GET    | `/v1/plans`  | Public plan catalog (stable ids + prices)                        |
| GET    | `/*`         | Embedded Vue frontend; non-API routes fall back to `index.html`  |

### Sign-in & license-key binding

| Method | Path                       | Purpose                                                                       |
| ------ | -------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/activate`                | Account page: renders the no-refund service agreement to accept before sign-in |
| POST   | `/activate/accept`         | Record agreement acceptance, then initiate GitHub OAuth sign-in               |
| GET    | `/auth/github/callback`    | OAuth callback → create/update account → issue trial license → render `license_key` page |
| POST   | `/v1/license/bind`         | c3: bind installation to a license — body `{licenseKey, installationId}` → signed entitlement token + `aliveToken` (once) + plan/termEnd/interval |
| POST   | `/v1/license/heartbeat`    | c3: confirm/refresh — body `{licenseKey, installationId, aliveToken}` → status active/disabled/revoked/expired (200) or 404 unknown key |

The sign-in and bind/heartbeat endpoints are only available when the database,
OAuth credentials, and signing key are all configured; otherwise they return a
clear "unavailable" status.

The full contract is documented in the
[license-server API contract](../specs/shared/api-conventions/license-server-api.md).

## Plan catalog

Served from `/v1/plans`; ids are stable and prices are in the currency's minor
unit (cents), denominated in CNY (WeChat Pay settles in CNY).

| id   | name     | duration  | price       |
| ---- | -------- | --------- | ----------- |
| `1m` | 1 Month  | 1 month   | 100 cents   |
| `6m` | 6 Months | 6 months  | 590 cents   |
| `1y` | 1 Year   | 12 months | 1090 cents  |

## Configuration

All configuration is environment-driven; there is no config file. Secrets are
never written to logs or `/healthz` (PL-R12).

| Variable                        | Required | Default  | Notes                                          |
| ------------------------------- | -------- | -------- | ---------------------------------------------- |
| `LS_DATABASE_URL`               | for DB   | —        | PostgreSQL DSN (secret). Omit to run dbless.   |
| `LS_LISTEN_ADDR`                | no       | `:8787`  | HTTP listen address                            |
| `LS_PUBLIC_URL`                 | activation | —     | External base URL (OAuth callbacks); http://localhost:8787 for dev |
| `LS_ED25519_PRIVATE_KEY`        | activation | —     | Token signing key (secret, LS-only); `go run ./scripts/gen-keypair` |
| `LS_ED25519_PUBLIC_KEY`         | activation | —     | Verification key (published for c3 embedding; use the output above) |
| `LS_GITHUB_OAUTH_CLIENT_ID`     | activation | —     | GitHub OAuth app id (create a GitHub OAuth App in Settings → Developer settings) |
| `LS_GITHUB_OAUTH_CLIENT_SECRET` | activation | —     | GitHub OAuth app secret (secret)               |
| `LS_WECHAT_PAY_MCH_ID`          | later    | —        | WeChat Pay merchant id                         |
| `LS_WECHAT_PAY_API_KEY`         | later    | —        | WeChat Pay API key (secret)                    |
| `LS_LRU_SIZE`                   | no       | `1024`   | Per-cache capacity                             |
| `LS_GRACE_MINUTES`              | no       | `30`     | Offline-grace window (PL-R4)                   |
| `LS_ADMIN_ALLOWLIST`            | no       | —        | Comma-separated admin GitHub logins (PL-R11)   |

## Build & run

```bash
make build                      # single binary at dist/license-server
make release                    # rebuild web/dist from web/src, then build
make test                       # unit/build checks
LS_TEST_DATABASE_URL=postgres://… make test   # also runs the live-DB schema test
dist/license-server             # run (set LS_DATABASE_URL to enable the store)
```

The schema is applied automatically on startup when `LS_DATABASE_URL` is set
(idempotent DDL; re-runs are no-ops — no migration ledger). The binary is built
from this directory's own Go module — it is **not** part of the pnpm workspace.
