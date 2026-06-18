-- 001-c3_ls_license-drop-plan-order — drop order_id and plan_key from c3_ls_license.
--
-- These columns were redundant: the purchase that funds a license already records
-- the plan (c3_ls_order.plan_key) and links the renewed license (c3_ls_order.
-- license_id), so the plan/order association lives on the order, not the license.
-- The license row now carries only identity + term + live binding.
--
-- Operator-run, idempotent (DROP COLUMN IF EXISTS). A fresh database gets the final
-- shape straight from sql/c3_ls_license.sql; this script converges existing ones.
ALTER TABLE c3_ls_license DROP COLUMN IF EXISTS order_id;
ALTER TABLE c3_ls_license DROP COLUMN IF EXISTS plan_key;
