-- c3_ls_plan — The persisted public plan catalog (purchasable license terms).
-- Source of truth: license-server schema (database/sql/<table>.sql, applied idempotently).
-- Business rules: PL-R9 (orders reference a plan_key from this catalog).
--
-- The catalog is small, stable, and identical for every buyer. It is bootstrapped
-- from the code catalog (internal/plans) on startup with INSERT ... ON CONFLICT
-- DO NOTHING, so the database becomes the live store after the first seed and any
-- operator edit is never clobbered on restart. The public GET /v1/plans reads this
-- table (falling back to the code catalog only when the database is unavailable).
-- id is the internal auto-increment identity; plan_key is the stable public plan
-- identifier (referenced by orders/licenses) and MUST NOT change once published.

CREATE TABLE IF NOT EXISTS c3_ls_plan (
    id              BIGSERIAL    PRIMARY KEY,          -- Internal auto-increment plan identity.
    plan_key        VARCHAR(32)  NOT NULL UNIQUE,      -- Stable public plan key (referenced by orders/licenses); never changes once published.
    name            VARCHAR(64)  NOT NULL,             -- Short human-readable label.
    duration_months INTEGER      NOT NULL,             -- License term length in whole months.
    price_cents     INTEGER      NOT NULL,             -- Price in the currency's minor unit (cents).
    currency        VARCHAR(32)  NOT NULL DEFAULT 'CNY', -- ISO-4217 currency code the price is denominated in.
    sort_order      INTEGER     NOT NULL DEFAULT 0,   -- Display order for the served catalog (shortest term first).
    is_trial        BOOLEAN     NOT NULL DEFAULT false, -- Whether this plan is the free trial granted at sign-in.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(), -- Record creation time.
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now() -- Last update time.
);

CREATE INDEX IF NOT EXISTS idx_c3_ls_plan_trial ON c3_ls_plan (is_trial) WHERE is_trial;

COMMENT ON TABLE c3_ls_plan IS 'Persisted public plan catalog (purchasable license terms), bootstrapped from the code catalog and served from GET /v1/plans.';
COMMENT ON COLUMN c3_ls_plan.id IS 'Internal auto-increment plan identity.';
COMMENT ON COLUMN c3_ls_plan.plan_key IS 'Stable public plan key, referenced by orders/licenses; never changes once published.';
COMMENT ON COLUMN c3_ls_plan.name IS 'Short human-readable label.';
COMMENT ON COLUMN c3_ls_plan.duration_months IS 'License term length in whole months.';
COMMENT ON COLUMN c3_ls_plan.price_cents IS 'Price in the currency minor unit (cents).';
COMMENT ON COLUMN c3_ls_plan.currency IS 'ISO-4217 currency code the price is denominated in.';
COMMENT ON COLUMN c3_ls_plan.sort_order IS 'Display order for the served catalog (shortest term first).';
COMMENT ON COLUMN c3_ls_plan.is_trial IS 'Whether this plan is the free trial granted at sign-in; the first such plan (if any) is issued, otherwise the buyer must purchase.';
COMMENT ON COLUMN c3_ls_plan.created_at IS 'Record creation time.';
COMMENT ON COLUMN c3_ls_plan.updated_at IS 'Last update time.';
