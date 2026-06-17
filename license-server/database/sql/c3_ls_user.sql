-- c3_ls_user — GitHub buyer/admin identity.
-- Source of truth: license-server schema (database/sql/<table>.sql, applied idempotently).
-- Business rules: PL-R9, PL-R11.
--
-- GitHub OAuth is used ONLY to log in / register an account here; it no longer
-- carries the activation. Activation is a separate license_key + installation
-- binding (see c3_ls_license).

CREATE TABLE IF NOT EXISTS c3_ls_user (
    id           BIGSERIAL PRIMARY KEY,       -- Internal buyer identity.
    github_id    BIGINT      NOT NULL UNIQUE, -- Stable GitHub user id.
    github_login TEXT        NOT NULL,        -- Current GitHub login name for display/admin lookup.
    email        TEXT,                         -- Buyer email when GitHub provides it.
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now() -- Record creation time.
);

COMMENT ON TABLE c3_ls_user IS 'GitHub identity for license buyers and license-server admins; GitHub is used for account login/registration only.';
COMMENT ON COLUMN c3_ls_user.id IS 'Internal buyer identity.';
COMMENT ON COLUMN c3_ls_user.github_id IS 'Stable GitHub user id; unique identity key.';
COMMENT ON COLUMN c3_ls_user.github_login IS 'Current GitHub login name for display and admin lookup.';
COMMENT ON COLUMN c3_ls_user.email IS 'Buyer email when provided by GitHub.';
COMMENT ON COLUMN c3_ls_user.created_at IS 'Record creation time.';
