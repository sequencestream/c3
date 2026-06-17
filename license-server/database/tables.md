# license-server database

The license-server's PostgreSQL schema, kept **separate** from c3's `database/`
area (ADR-0026). The schema is embedded into the LS binary and applied
idempotently on startup by `lsdb.EnsureSchema`.

- Runtime DDL: `sql/<table-name>.sql` — one table per file, every statement
  written with `IF NOT EXISTS`, including table/column comments. To evolve a
  table, **edit its file additively** (new columns/indexes stay `IF NOT EXISTS`
  so existing databases converge on the next start).
- Every file is re-applied on every startup; re-running is a no-op. There is
  **intentionally no migration ledger** (no `schema_migrations` table) — the
  idempotent DDL makes tracking "what was applied" unnecessary, keeping the
  service simple.
- Table relationships are enforced in business logic; LS tables intentionally do
  not define database foreign-key constraints, so file apply order does not
  matter (the runner applies them in name order for stable logs).

The schema was simplified: activation + heartbeat state now lives inline on the
license row (no separate one-time-code, heartbeat-token, or heartbeat-history
tables), and a license is identified to c3 by a random unique `license_key`. The
`00_drop_legacy.sql` file idempotently drops the pre-simplification tables
(`activation_codes`, `activation_requests`, `heartbeat_tokens`, `heartbeats`, and
the old `user`/`orders`/`licenses`) on every startup.

## Tables

| Table          | Purpose                                                                                   | Key columns                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| c3_ls_user     | GitHub identity for buyer + admin; GitHub is account login/registration only (PL-R9/R11)  | github_id (unique), github_login, email                                                      |
| c3_ls_order    | Purchase record + no-refund acceptance; a paid order extends the linked license (PL-R9)   | buyer_id, license_id, plan_id, amount_cents, no_refund_accepted_at, status                   |
| c3_ls_license  | Authoritative entitlement keyed by license_key, carrying its exclusive live binding       | license_key (unique), buyer_id, plan_id, status, alive_install_id, alive_token, alive_time, term_end |
