-- c3_ls_license — Authoritative entitlement record + the live binding.
-- Source of truth: license-server schema (database/sql/<table>.sql, applied idempotently).
-- Business rules: PL-R1, PL-R3, PL-R8, PL-R11.
--
-- Simplified model: the license is the only entitlement row. It is identified to
-- c3 by a random unique license_key (the handle passed on the bind/heartbeat
-- API), and it carries its own live binding inline:
--   * alive_install_id — the single c3 installation currently bound (exclusive).
--   * alive_token       — sha256 hash of the per-binding validity token; the
--                         plaintext is returned to c3 once at bind and presented
--                         on every heartbeat. Rotated on each (re)bind, so a stale
--                         binding's token stops validating.
--   * alive_time        — last successful heartbeat time for the current binding.
-- Binding to a new installation overwrites alive_install_id + alive_token, so the
-- previously-bound c3 discovers it has been displaced on its next heartbeat
-- (install/token mismatch ⇒ that c3 disables — "one license, one installation").

CREATE TABLE IF NOT EXISTS c3_ls_license (
    id               BIGSERIAL PRIMARY KEY,       -- Internal license identity.
    user_id          BIGINT      NOT NULL,         -- User that owns the license (references c3_ls_user.id).
    license_key      TEXT        NOT NULL UNIQUE,  -- Random unique handle passed on the c3<->LS bind/heartbeat API.
    status           VARCHAR(32) NOT NULL DEFAULT 'active', -- License status: active or expired.
    alive_install_id TEXT,                         -- The single c3 installation currently bound (exclusive).
    alive_token      TEXT,                         -- sha256 hash of the current binding's validity token (plaintext returned once at bind).
    alive_time       TIMESTAMPTZ,                  -- Last successful heartbeat time for the current binding.
    term_start       TIMESTAMPTZ NOT NULL DEFAULT now(), -- License term start time.
    term_end         TIMESTAMPTZ NOT NULL,         -- License term end time.
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(), -- Record creation time.
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()  -- Last update time (bumped on every bind/heartbeat write).
);

CREATE INDEX IF NOT EXISTS idx_c3_ls_license_user ON c3_ls_license(user_id);
CREATE INDEX IF NOT EXISTS idx_c3_ls_license_alive_install ON c3_ls_license(alive_install_id);

COMMENT ON TABLE c3_ls_license IS 'Authoritative product entitlement record keyed by license_key, carrying its exclusive live installation binding (alive_install_id/alive_token/alive_time).';
COMMENT ON COLUMN c3_ls_license.id IS 'Internal license identity.';
COMMENT ON COLUMN c3_ls_license.user_id IS 'User that owns the license (references c3_ls_user.id).';
COMMENT ON COLUMN c3_ls_license.license_key IS 'Random unique handle passed on the c3<->LS bind/heartbeat API.';
COMMENT ON COLUMN c3_ls_license.status IS 'License status: active or expired.';
COMMENT ON COLUMN c3_ls_license.alive_install_id IS 'The single c3 installation currently bound (exclusive); rebinding displaces the previous one.';
COMMENT ON COLUMN c3_ls_license.alive_token IS 'sha256 hash of the current binding validity token; plaintext is returned to c3 once at bind and presented on each heartbeat.';
COMMENT ON COLUMN c3_ls_license.alive_time IS 'Last successful heartbeat time for the current binding.';
COMMENT ON COLUMN c3_ls_license.term_start IS 'License term start time.';
COMMENT ON COLUMN c3_ls_license.term_end IS 'License term end time.';
COMMENT ON COLUMN c3_ls_license.created_at IS 'Record creation time.';
COMMENT ON COLUMN c3_ls_license.updated_at IS 'Last update time (bumped on every bind/heartbeat write).';
