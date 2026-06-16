# license-server (LS)

The c3 **license authority** — a standalone Go service that owns the
authoritative commercial-entitlement record, the plan catalog, and the buyer/
admin web. It is deliberately **separate** from the c3 process: the database,
identity provider, payment integration, and public network listener it needs are
forbidden inside c3 and live here instead (see
[ADR-0026](../specs/architecture/adr/0026-product-licensing-separate-license-server.md)).

This is the **foundation** milestone — config, caches, migrations, health, the
public plan catalog, and embedded static serving. Activation, heartbeat,
payment, and OAuth business flows land in later milestones (see the
[product-license roadmap](../specs/domains/commerce/product-license/product-license-overview.md)).

## Stack

- **HTTP:** Go standard library `net/http` `ServeMux` — no framework (ADR-0026).
- **Store:** PostgreSQL, via a pgx-backed `database/sql` handle. Schema lives in
  [`database/`](database/) and is applied idempotently on startup.
- **Frontend:** a minimal Vue 3 + Vite app in [`web/`](web/), built to
  `web/dist/` and **embedded** into the binary (`//go:embed`), served with SPA
  fallback.
- **Caches:** in-process LRU caches (plan catalog today; license/auth/payment
  read paths wired for later).

## Layout

```
license-server/
  cmd/license-server/      entrypoint (config → caches → db/migrate → http)
  internal/config/         env-driven config + redaction
  internal/cache/          generic LRU + named cache registry
  internal/plans/          the fixed plan catalog
  internal/httpapi/        ServeMux, /healthz, /v1/plans, static + SPA fallback
  internal/version/        build version
  database/                PostgreSQL migrations (embedded) + schema index
  web/                     Vue source; web/dist is committed + embedded
```

## Endpoints (foundation)

| Method | Path         | Purpose                                                          |
| ------ | ------------ | ---------------------------------------------------------------- |
| GET    | `/healthz`   | Liveness + **redacted** config (secrets shown as `set`/`unset`)  |
| GET    | `/v1/plans`  | Public plan catalog (stable ids + prices)                        |
| GET    | `/*`         | Embedded Vue frontend; non-API routes fall back to `index.html`  |

The c3 ↔ LS activation/heartbeat contract is documented in the
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
| `LS_PUBLIC_URL`                 | no       | —        | External base URL (OAuth/payment callbacks)    |
| `LS_ED25519_PRIVATE_KEY`        | later    | —        | Token signing key (secret, LS-only)            |
| `LS_ED25519_PUBLIC_KEY`         | later    | —        | Verification key (published for c3 embedding)  |
| `LS_GITHUB_OAUTH_CLIENT_ID`     | later    | —        | GitHub OAuth app id                            |
| `LS_GITHUB_OAUTH_CLIENT_SECRET` | later    | —        | GitHub OAuth app secret (secret)               |
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
LS_TEST_DATABASE_URL=postgres://… make test   # also runs the live-DB migration test
dist/license-server             # run (set LS_DATABASE_URL to enable the store)
```

Migrations run automatically on startup when `LS_DATABASE_URL` is set
(idempotent; re-runs are no-ops). The binary is built from this directory's
own Go module — it is **not** part of the pnpm workspace.
