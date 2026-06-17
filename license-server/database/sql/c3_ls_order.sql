-- c3_ls_order — Purchase and no-refund agreement record.
-- Source of truth: license-server schema (database/sql/<table>.sql, applied idempotently).
-- Business rules: PL-R9, PL-R10.
--
-- An order extends a license: a paid order updates the linked license's term_end
-- and status (PL-R9). The user can hold many licenses; each renewal is a fresh
-- order against one license_id. Payment capture (WeChat Pay) is a later milestone;
-- the row + linkage are defined now so the term-extension path is unambiguous.

CREATE TABLE IF NOT EXISTS c3_ls_order (
    id                          BIGSERIAL PRIMARY KEY,             -- Internal order identity.
    order_no                    VARCHAR(40),                       -- Business order number (C3+YYYYMMDDHHmmssSSS+random4); WeChat out_trade_no.
    user_id                     BIGINT      NOT NULL,              -- User that placed the order (references c3_ls_user.id).
    license_id                  BIGINT,                            -- License this order extends, once known.
    plan_key                    VARCHAR(32) NOT NULL,              -- Purchased plan (references c3_ls_plan.plan_key).
    amount_cents                INTEGER     NOT NULL,              -- Charged amount in minor currency units.
    currency                    VARCHAR(32) NOT NULL DEFAULT 'CNY', -- ISO-like currency code for the charged amount.
    payment_ref                 TEXT,                              -- External payment provider reference (WeChat transaction id).
    agreement_version           VARCHAR(32) NOT NULL,              -- Service agreement version accepted before payment.
    agreement_accepted_at       TIMESTAMPTZ NOT NULL,              -- Time the user accepted the service agreement.
    status                      VARCHAR(32) NOT NULL DEFAULT 'pending', -- Payment/order status: pending, paid, failed, or expired.
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now() -- Record creation time.
);

-- Additive evolution for existing databases (idempotent): the business order
-- number used as the WeChat out_trade_no and the payment-association handle.
ALTER TABLE c3_ls_order ADD COLUMN IF NOT EXISTS order_no VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_c3_ls_order_user ON c3_ls_order(user_id);
CREATE INDEX IF NOT EXISTS idx_c3_ls_order_license ON c3_ls_order(license_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_c3_ls_order_order_no ON c3_ls_order(order_no);
CREATE INDEX IF NOT EXISTS idx_c3_ls_order_status ON c3_ls_order(status);

COMMENT ON TABLE c3_ls_order IS 'Purchase record with no-refund acceptance; a paid order extends the linked license term and status.';
COMMENT ON COLUMN c3_ls_order.id IS 'Internal order identity.';
COMMENT ON COLUMN c3_ls_order.order_no IS 'Business order number (C3+YYYYMMDDHHmmssSSS+random4); used as the WeChat out_trade_no and the payment-association handle.';
COMMENT ON COLUMN c3_ls_order.user_id IS 'User that placed the order (references c3_ls_user.id).';
COMMENT ON COLUMN c3_ls_order.license_id IS 'License this order extends, once known.';
COMMENT ON COLUMN c3_ls_order.plan_key IS 'Purchased plan (references c3_ls_plan.plan_key).';
COMMENT ON COLUMN c3_ls_order.amount_cents IS 'Charged amount in minor currency units.';
COMMENT ON COLUMN c3_ls_order.currency IS 'Currency code for the charged amount.';
COMMENT ON COLUMN c3_ls_order.payment_ref IS 'External payment provider reference.';
COMMENT ON COLUMN c3_ls_order.agreement_version IS 'Service agreement version accepted before payment.';
COMMENT ON COLUMN c3_ls_order.agreement_accepted_at IS 'Time the user accepted the service agreement.';
COMMENT ON COLUMN c3_ls_order.status IS 'Payment/order status: pending, paid, failed, or expired (15-minute payment window lapsed).';
COMMENT ON COLUMN c3_ls_order.created_at IS 'Record creation time.';
