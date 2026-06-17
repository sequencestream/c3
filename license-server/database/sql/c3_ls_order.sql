-- c3_ls_order — Purchase and no-refund agreement record.
-- Source of truth: license-server schema (database/sql/<table>.sql, applied idempotently).
-- Business rules: PL-R9, PL-R10.
--
-- An order extends a license: a paid order updates the linked license's term_end
-- and status (PL-R9). The buyer can hold many licenses; each renewal is a fresh
-- order against one license_id. Payment capture (WeChat Pay) is a later milestone;
-- the row + linkage are defined now so the term-extension path is unambiguous.

CREATE TABLE IF NOT EXISTS c3_ls_order (
    id                          BIGSERIAL PRIMARY KEY,             -- Internal order identity.
    buyer_id                    BIGINT      NOT NULL,              -- Buyer that placed the order.
    license_id                  BIGINT,                            -- License this order extends, once known.
    plan_id                     TEXT        NOT NULL,              -- Purchased public catalog plan id.
    amount_cents                INTEGER     NOT NULL,              -- Charged amount in minor currency units.
    currency                    TEXT        NOT NULL DEFAULT 'CNY', -- ISO-like currency code for the charged amount.
    payment_ref                 TEXT,                              -- External payment provider reference.
    no_refund_agreement_version TEXT        NOT NULL,              -- Service agreement version accepted before payment.
    no_refund_accepted_at       TIMESTAMPTZ NOT NULL,              -- Time the buyer accepted the no-refund agreement.
    status                      TEXT        NOT NULL DEFAULT 'pending', -- Payment/order status.
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now() -- Record creation time.
);

CREATE INDEX IF NOT EXISTS idx_c3_ls_order_buyer ON c3_ls_order(buyer_id);
CREATE INDEX IF NOT EXISTS idx_c3_ls_order_license ON c3_ls_order(license_id);

COMMENT ON TABLE c3_ls_order IS 'Purchase record with no-refund acceptance; a paid order extends the linked license term and status.';
COMMENT ON COLUMN c3_ls_order.id IS 'Internal order identity.';
COMMENT ON COLUMN c3_ls_order.buyer_id IS 'Buyer that placed the order.';
COMMENT ON COLUMN c3_ls_order.license_id IS 'License this order extends, once known.';
COMMENT ON COLUMN c3_ls_order.plan_id IS 'Purchased public catalog plan id.';
COMMENT ON COLUMN c3_ls_order.amount_cents IS 'Charged amount in minor currency units.';
COMMENT ON COLUMN c3_ls_order.currency IS 'Currency code for the charged amount.';
COMMENT ON COLUMN c3_ls_order.payment_ref IS 'External payment provider reference.';
COMMENT ON COLUMN c3_ls_order.no_refund_agreement_version IS 'Service agreement version accepted before payment.';
COMMENT ON COLUMN c3_ls_order.no_refund_accepted_at IS 'Time the buyer accepted the no-refund agreement.';
COMMENT ON COLUMN c3_ls_order.status IS 'Payment/order status, for example pending or paid.';
COMMENT ON COLUMN c3_ls_order.created_at IS 'Record creation time.';
