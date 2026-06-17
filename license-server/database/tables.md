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
- Change records: `sql/<table>.sql` is the live schema, but column **renames /
  type changes** cannot converge an existing database through `CREATE TABLE IF
  NOT EXISTS` alone. Such changes are recorded as one-off, operator-run scripts
  under `migrations/<YYYY>/<MM>/<DD>/<NNN>-<change>.sql` (idempotent ALTERs); a
  fresh database gets the final shape straight from `sql/`.

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
| c3_ls_plan     | Persisted public plan catalog (purchasable terms); bootstrapped from code, served at GET /v1/plans | id (PK, auto), plan_key (unique), name, duration_months, price_cents, currency, sort_order, is_trial |
| c3_ls_order    | Purchase record + service-agreement acceptance; status machine `pending→paid/failed`, a paid order extends the linked license (PL-R9) | user_id, license_id, plan_key, amount_cents, agreement_version, agreement_accepted_at, status, payment_ref |
| c3_ls_license  | Authoritative entitlement keyed by license_key, carrying its exclusive live binding       | license_key (unique), user_id, plan_key, status, alive_install_id, alive_token, alive_time, term_end |

An order moves through `pending → paid` (or `pending → failed`) under the WeChat
Pay callback: a verified payment success records the WeChat transaction id in
`payment_ref`, flips `status` to `paid`, and extends the linked license's
`term_end`/`status` in one transaction. The transition is idempotent (a
redelivered callback finds the order already `paid` and does not re-extend), and
`payment_ref` is the **only** payment artifact stored — no credentials (PL-R12).

The plan catalog is bootstrapped from the code-owned set (`internal/plans`) into
`c3_ls_plan` on every startup with `INSERT ... ON CONFLICT (plan_key) DO NOTHING`,
so a fresh database is seeded while existing rows (operator edits) survive. The
public `GET /v1/plans` reads `c3_ls_plan`, falling back to the code catalog only
when the database is unavailable.
