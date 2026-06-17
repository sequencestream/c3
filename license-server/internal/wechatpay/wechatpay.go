// Package wechatpay is the license-server's WeChat Pay gateway port. It adapts
// the vogo/vwechatpay NativeClient (vwxpayments/vwxnative) behind a small
// [Gateway] interface so the HTTP surface depends on an intent-revealing
// contract — "create a Native order", "parse a callback" — rather than the
// vendor types, and so tests can substitute a fake.
//
// The MVP takes renewal payment via WeChat Pay **Native** (a scan-to-pay QR
// suited to PC web): a pending order drives a unified order that returns a
// `code_url`, rendered as a QR; WeChat later POSTs an asynchronous payment
// result to the callback endpoint, which this package verifies and decrypts
// before the order state machine advances (product-license PL-R9, PL-R12).
//
// Payment credentials live only here, sourced from the environment; they are
// never persisted and never logged (PL-R12).
package wechatpay

import (
	"context"
	"errors"
)

// WeChat `trade_state` values the reconcile/callback paths discriminate on.
// SUCCESS settles the order paid; CLOSED/REVOKED/PAYERROR are terminal failures;
// NOTPAY/USERPAYING mean still awaiting payment (left pending until the window
// lapses). See §11.
const (
	TradeStateSuccess  = "SUCCESS"
	TradeStateClosed   = "CLOSED"
	TradeStateRevoked  = "REVOKED"
	TradeStatePayError = "PAYERROR"
	TradeStateNotPay   = "NOTPAY"
	TradeStateUserPay  = "USERPAYING"
)

// ErrUnconfigured is returned when a gateway operation is attempted without the
// full set of WeChat Pay credentials. The HTTP surface degrades to a clear
// "unavailable" rather than half-working.
var ErrUnconfigured = errors.New("wechatpay: gateway not configured")

// ErrSignatureInvalid is returned by [Gateway.ParseNotify] when the callback's
// signature does not verify or its envelope is malformed. A forged or tampered
// notification must never advance an order (PL-R12).
var ErrSignatureInvalid = errors.New("wechatpay: callback signature verification failed")

// PrepayInput is a Native unified-order request. Amount is in minor currency
// units (fen). OutTradeNo is the merchant order number — the opaque handle
// echoed back on the callback to identify which order was paid.
type PrepayInput struct {
	OutTradeNo  string
	AmountCents int
	Description string
	NotifyURL   string
}

// PrepayResult carries the QR payload of a Native order. CodeURL is the
// `weixin://` string the user scans (rendered as a QR by the web).
type PrepayResult struct {
	CodeURL string
}

// NotifyResult is the decrypted, verified payment outcome from a callback. It
// is the vendor-neutral projection the order state machine consumes:
// OutTradeNo maps back to the c3 order, TradeState discriminates the outcome,
// and AmountCents lets the handler cross-check the charge against the order.
type NotifyResult struct {
	OutTradeNo    string
	TransactionID string
	TradeState    string
	AmountCents   int
}

// Paid reports whether the result represents a successful payment.
func (r NotifyResult) Paid() bool { return r.TradeState == TradeStateSuccess }

// Closed reports whether the trade state is terminal-without-payment (the order
// can no longer be paid): the reconcile job expires/fails such orders (§11).
func (r NotifyResult) Closed() bool {
	switch r.TradeState {
	case TradeStateClosed, TradeStateRevoked, TradeStatePayError:
		return true
	default:
		return false
	}
}

// Gateway is the WeChat Pay port the license-server depends on.
type Gateway interface {
	// Prepay creates a Native unified order and returns its QR code_url.
	Prepay(ctx context.Context, in PrepayInput) (PrepayResult, error)
	// ParseNotify verifies a callback's signature (headerFetcher reads the
	// Wechatpay-* headers; body is the raw request body) and decrypts its
	// resource. It returns ErrSignatureInvalid when verification fails so the
	// handler can refuse without touching any order.
	ParseNotify(headerFetcher func(string) string, body []byte) (NotifyResult, error)
	// QueryByOutTradeNo asks WeChat for the authoritative state of an order by its
	// merchant order number (our order_no). The reconcile job uses it to settle
	// pending orders whose async callback was missed or failed (§11).
	QueryByOutTradeNo(ctx context.Context, outTradeNo string) (NotifyResult, error)
}
