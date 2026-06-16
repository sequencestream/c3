-- 0001_init — license-server authoritative schema (ADR-0026).
-- Every statement is idempotent (IF NOT EXISTS) so re-running a migration on an
-- already-migrated database is a no-op. The migration runner additionally
-- records applied versions in schema_migrations and skips them.

-- Buyers: a GitHub identity (PL-R9). Single identity source for buyer + admin.
CREATE TABLE IF NOT EXISTS buyers (
    id            BIGSERIAL PRIMARY KEY,
    github_id     BIGINT      NOT NULL UNIQUE,
    github_login  TEXT        NOT NULL,
    email         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orders: the purchase record produced by the buyer payment flow (PL-R9).
-- Carries the no-refund-agreement acceptance recorded BEFORE payment (PL-R9).
CREATE TABLE IF NOT EXISTS orders (
    id                          BIGSERIAL PRIMARY KEY,
    buyer_id                    BIGINT      NOT NULL REFERENCES buyers(id),
    plan_id                     TEXT        NOT NULL,
    amount_cents                INTEGER     NOT NULL,
    currency                    TEXT        NOT NULL DEFAULT 'CNY',
    payment_ref                 TEXT,
    no_refund_agreement_version TEXT        NOT NULL,
    no_refund_accepted_at       TIMESTAMPTZ NOT NULL,
    status                      TEXT        NOT NULL DEFAULT 'pending',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);

-- Licenses: the authoritative entitlement record (PL spec core entity).
CREATE TABLE IF NOT EXISTS licenses (
    id              BIGSERIAL PRIMARY KEY,
    buyer_id        BIGINT      NOT NULL REFERENCES buyers(id),
    order_id        BIGINT      REFERENCES orders(id),
    plan_id         TEXT        NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'active', -- active | revoked | expired
    installation_id TEXT,                                  -- per-installation binding
    term_start      TIMESTAMPTZ NOT NULL DEFAULT now(),
    term_end        TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_licenses_buyer ON licenses(buyer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_installation ON licenses(installation_id);

-- Activation codes: one-time, short-lived (PL-R1/PL-R2). Stored hashed; the
-- plaintext code is only ever shown to the buyer at issuance.
CREATE TABLE IF NOT EXISTS activation_codes (
    id          BIGSERIAL PRIMARY KEY,
    license_id  BIGINT      NOT NULL REFERENCES licenses(id),
    code_hash   TEXT        NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Heartbeat tokens: the long-lived, revocable bearer credential issued at
-- activation (PL-R2). Stored hashed; never reused as an activation code.
CREATE TABLE IF NOT EXISTS heartbeat_tokens (
    id              BIGSERIAL PRIMARY KEY,
    license_id      BIGINT      NOT NULL REFERENCES licenses(id),
    installation_id TEXT        NOT NULL,
    token_hash      TEXT        NOT NULL UNIQUE,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_tokens_license ON heartbeat_tokens(license_id);

-- Heartbeats: history of each confirmation (PL-R3/PL-R8) for admin inspection.
CREATE TABLE IF NOT EXISTS heartbeats (
    id              BIGSERIAL PRIMARY KEY,
    license_id      BIGINT      NOT NULL REFERENCES licenses(id),
    installation_id TEXT        NOT NULL,
    status          TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_license ON heartbeats(license_id);
