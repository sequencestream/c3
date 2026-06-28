-- 002-c3_ls_license-add-tier — add the effective tier to c3_ls_license.
--
-- A license now carries its own current entitlement tier (free | paid | enterprise)
-- so token signing reflects the active plan independent of order history. Paid
-- renewals keep the tier, free→paid/enterprise purchases and paid→enterprise
-- upgrades raise it; existing rows default to 'paid' to preserve their entitlement.
--
-- Operator-run, idempotent. A fresh database gets the final shape straight from
-- sql/c3_ls_license.sql; this script converges existing ones.
ALTER TABLE c3_ls_license ADD COLUMN IF NOT EXISTS tier VARCHAR(32) NOT NULL DEFAULT 'paid';

COMMENT ON COLUMN c3_ls_license.tier IS 'Current effective plan tier for token signing: free, paid, or enterprise.';
