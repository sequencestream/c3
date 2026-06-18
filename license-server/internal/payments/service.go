// Package payments is the LS payment domain: it bridges the WeChat Pay gateway to
// the order state machine. It places Native unified orders (Prepay) and applies
// verified payment callbacks to orders (ProcessNotify). It owns no table of its
// own — payment outcomes live on the order (orders.Order.PaymentRef/Status); the
// only payment artifact persisted is the provider transaction id (PL-R12).
//
// The reconcile worker (internal/reconcile) is the settlement safety net behind
// the async callback handled here; both drive the same order transitions.
package payments

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/orders"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
)

// ErrVerify is returned by ProcessNotify when a callback fails signature/decrypt
// verification — it is forged or tampered and never advances an order (PL-R12).
var ErrVerify = errors.New("payments: callback verification failed")

// ErrMissingTradeNo is returned when a verified callback carries no out_trade_no
// (the order_no), so no order can be resolved.
var ErrMissingTradeNo = errors.New("payments: callback missing out_trade_no")

// notifyPath is the WeChat Pay asynchronous-result callback path, appended to the
// external base URL to form the notify_url passed at unified order.
const notifyPath = "/v1/payment/wechat/notify"

// Service composes the WeChat Pay gateway with the order repository. gateway is
// nil when WeChat Pay is unconfigured, in which case Enabled reports false and the
// checkout records the pending order but reports payment unavailable rather than
// half-working.
type Service struct {
	orders  *orders.Repo
	gateway wechatpay.Gateway
	baseURL string
}

// NewService builds the payment service over the order repository, the WeChat Pay
// gateway, and the external base URL used to construct the notify_url.
func NewService(ordersRepo *orders.Repo, gw wechatpay.Gateway, baseURL string) *Service {
	return &Service{orders: ordersRepo, gateway: gw, baseURL: baseURL}
}

// Enabled reports whether WeChat Pay is configured (a gateway is present).
func (s *Service) Enabled() bool { return s.gateway != nil }

// Ready reports whether a verified callback can be applied: a gateway and a
// database.
func (s *Service) Ready() bool { return s.gateway != nil && s.orders.Available() }

// Prepay places a Native unified order for the given order and returns its
// scan-to-pay code_url. The out_trade_no is the order's business number, the
// amount is the server-derived order amount, and the notify_url is built from the
// external base URL.
func (s *Service) Prepay(ctx context.Context, order orders.Order) (string, error) {
	notifyURL := strings.TrimRight(s.baseURL, "/") + notifyPath
	res, err := s.gateway.Prepay(ctx, wechatpay.PrepayInput{
		OutTradeNo:  order.OrderNo,
		AmountCents: order.AmountCents,
		Description: "c3 license renewal · " + order.PlanKey,
		NotifyURL:   notifyURL,
	})
	if err != nil {
		return "", err
	}
	return res.CodeURL, nil
}

// NotifyURL returns the notify_url WeChat is told to call back, for logging.
func (s *Service) NotifyURL() string {
	return strings.TrimRight(s.baseURL, "/") + notifyPath
}

// NotifyOutcome describes the result of applying a verified callback, for the
// handler's acknowledgement logging. Order is the order after the transition (or
// the unchanged order on an idempotent replay).
type NotifyOutcome struct {
	OutTradeNo    string
	TradeState    string
	TransactionID string
	AmountCents   int
	// Paid is whether the callback reported a successful payment.
	Paid bool
	// Advanced is whether this call performed a pending→terminal transition (false
	// on an idempotent replay of an already-settled order).
	Advanced bool
	Order    orders.Order
}

// ProcessNotify verifies a WeChat Pay callback and applies it to the order. The
// signature/decrypt check is the security boundary: a forged or tampered callback
// never decrypts with our APIv3 key and is refused with ErrVerify, so no order is
// advanced (PL-R12). A verified SUCCESS marks the order paid (extending the
// license); any other trade state marks it failed. Processing is idempotent — a
// replay of an already-settled order returns Advanced=false without side effects.
// An unknown out_trade_no surfaces as orders.ErrNotFound.
func (s *Service) ProcessNotify(ctx context.Context, headerGet func(string) string, body []byte) (NotifyOutcome, error) {
	notif, err := s.gateway.ParseNotify(headerGet, body)
	if err != nil {
		return NotifyOutcome{}, fmt.Errorf("%w: %v", ErrVerify, err)
	}
	if notif.OutTradeNo == "" {
		return NotifyOutcome{}, ErrMissingTradeNo
	}
	out := NotifyOutcome{
		OutTradeNo:    notif.OutTradeNo,
		TradeState:    notif.TradeState,
		TransactionID: notif.TransactionID,
		AmountCents:   notif.AmountCents,
		Paid:          notif.Paid(),
	}
	// out_trade_no is the order_no. A success on an already-expired/paid order is
	// idempotently ignored by the order repo (it never re-extends a license, §11).
	if notif.Paid() {
		order, advanced, err := s.orders.MarkPaid(ctx, notif.OutTradeNo, notif.TransactionID, time.Now())
		if err != nil {
			return out, err
		}
		out.Order = order
		out.Advanced = advanced
		return out, nil
	}
	order, advanced, err := s.orders.MarkFailed(ctx, notif.OutTradeNo, notif.TransactionID)
	if err != nil {
		return out, err
	}
	out.Order = order
	out.Advanced = advanced
	return out, nil
}
