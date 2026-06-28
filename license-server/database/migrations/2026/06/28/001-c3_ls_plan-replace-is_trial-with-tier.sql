-- 001-c3_ls_plan-replace-is_trial-with-tier — replace c3_ls_plan.is_trial with tier.
--
-- The free tier is no longer modeled as a purchasable "trial" plan row. It is now
-- issued directly as a license tier (c3_ls_license.tier='free') and is not in the
-- public catalog, so the is_trial flag and its partial index are obsolete. The
-- catalog instead carries a `tier` column ('paid' | 'enterprise') that drives the
-- paid/enterprise split.
--
-- Operator-run, idempotent. A fresh database gets the final shape straight from
-- sql/c3_ls_plan.sql; this script converges existing ones. Add the new column
-- before dropping the old flag so no information is lost mid-run.
ALTER TABLE c3_ls_plan ADD COLUMN IF NOT EXISTS tier VARCHAR(32) NOT NULL DEFAULT 'paid';
DROP INDEX IF EXISTS idx_c3_ls_plan_trial;
ALTER TABLE c3_ls_plan DROP COLUMN IF EXISTS is_trial;

COMMENT ON COLUMN c3_ls_plan.tier IS 'Purchasable plan tier: paid or enterprise. Free is issued directly as a license tier and is not in this catalog.';
