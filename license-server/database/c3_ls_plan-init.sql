-- c3_ls_plan-init — Seed the public plan catalog rows (operator-run, optional).
-- Source of truth: the code-owned catalog (internal/plans/plans.go).
--
-- This is a manual seed script, deliberately kept OUT of database/sql/ and NOT
-- embedded into the binary (lsdb only embeds sql/*.sql and applies them on every
-- startup). The running service already seeds this catalog on boot from the code
-- catalog (cmd/license-server seedPlans → INSERT ... ON CONFLICT (plan_key) DO
-- NOTHING), so this file is only for operators who want to seed/inspect the
-- catalog directly via psql without starting the service.
--
-- Idempotent: existing rows (including operator edits) are never clobbered, so it
-- is safe to re-run. plan_key is the stable public identifier and MUST match the
-- code catalog; sort_order keeps the served list shortest-term-first. Requires
-- the c3_ls_plan table to already exist (database/sql/c3_ls_plan.sql).
--
-- Run it with psql connected to the service database:
--   psql "$C3_LS_DATABASE_URL" -f c3_ls_plan-init.sql

INSERT INTO c3_ls_plan (plan_key, name, duration_months, price_cents, currency, sort_order, tier)
VALUES
    ('1m', '1 Month',  1,  100,  'CNY', 0, 'paid'),
    ('6m', '6 Months', 6,  590,  'CNY', 1, 'paid'),
    ('1y', '1 Year',   12, 1090, 'CNY', 2, 'paid'),
    ('enterprise-6m', 'Enterprise 6 Months', 6, 5900, 'CNY', 3, 'enterprise'),
    ('enterprise-1y', 'Enterprise 1 Year', 12, 9900, 'CNY', 4, 'enterprise')
ON CONFLICT (plan_key) DO NOTHING;
