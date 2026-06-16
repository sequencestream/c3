# license-server database

The license-server's PostgreSQL schema, kept **separate** from c3's `database/`
area (ADR-0026). Migrations are embedded into the LS binary and applied
idempotently on startup by `lsdb.Migrate`.

- DDL: `migrations/<NNNN>_<name>.sql` — append-only; never edit an applied file,
  add a new numbered migration instead.
- Applied versions are tracked in `schema_migrations`.

## Tables

| Table              | Purpose                                                                 | Key columns                                                    |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| buyers             | GitHub identity for buyer + admin (PL-R9)                               | github_id (unique), github_login, email                        |
| orders             | Purchase record + no-refund acceptance recorded before payment (PL-R9)  | buyer_id, plan_id, amount_cents, no_refund_accepted_at, status |
| licenses           | Authoritative entitlement record with term + status                     | buyer_id, plan_id, status, installation_id, term_end           |
| activation_codes   | One-time, short-lived codes, stored hashed (PL-R1/PL-R2)                | license_id, code_hash (unique), expires_at, consumed_at        |
| heartbeat_tokens   | Long-lived revocable bearer credential, stored hashed (PL-R2)          | license_id, installation_id, token_hash (unique), revoked_at   |
| heartbeats         | Heartbeat history for admin inspection (PL-R3/PL-R8)                    | license_id, installation_id, status                            |
| schema_migrations  | Applied-migration ledger (runner-managed)                              | version (pk), applied_at                                       |

## Migrations

| Version          | Description                          |
| ---------------- | ------------------------------------ |
| 0001_init.sql    | Initial LS authority-core schema     |
