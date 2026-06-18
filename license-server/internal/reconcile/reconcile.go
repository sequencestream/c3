// Package reconcile runs the license-server's periodic order reconciliation
// (§11): a 15-second job that asks WeChat Pay for the authoritative state of
// every pending order and settles it. It is the safety net behind the async
// payment callback — a missed or failed callback is recovered here, promptly,
// so a paid order is confirmed within seconds even when the notify URL is not
// publicly reachable — and the active enforcer of the 15-minute payment window:
// a pending order WeChat has closed (or that has out-waited the window, checked
// per-order against its created_at) is moved to a terminal state.
//
// This scheduler is a LS process-internal time.Ticker; it belongs to the LS
// product (ADR-0026 grants LS the capabilities c3 forbids) and has nothing to do
// with c3's "no persistent background scheduler" constraint.
package reconcile

import (
	"context"
	"log/slog"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/orders"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
)

// Store is the persistence subset the reconcile job needs; orders.Repo satisfies
// it. It is named for the role (settling the order store), not the package.
type Store interface {
	ListPending(ctx context.Context) ([]orders.PendingOrder, error)
	MarkPaid(ctx context.Context, orderNo, paymentRef string, now time.Time) (orders.Order, bool, error)
	MarkExpired(ctx context.Context, orderNo string) (orders.Order, bool, error)
}

// Run drives the reconcile loop until ctx is cancelled, ticking every interval.
// window is the order payment window: a still-unpaid order older than it is
// expired even if WeChat has not yet closed it. It runs one pass immediately so
// a short-lived process still reconciles.
func Run(ctx context.Context, st Store, gw wechatpay.Gateway, interval, window time.Duration) {
	if st == nil || gw == nil {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	runOnce(ctx, st, gw, window, time.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			runOnce(ctx, st, gw, window, now)
		}
	}
}

// runOnce reconciles every pending order against WeChat once.
func runOnce(ctx context.Context, st Store, gw wechatpay.Gateway, window time.Duration, now time.Time) {
	pending, err := st.ListPending(ctx)
	if err != nil {
		slog.Error("reconcile: list pending failed", "err", err)
		return
	}
	// Stay quiet on an idle pass (every 15s) — only announce a pass that has
	// orders to settle, so the log reflects real payment-checking activity.
	if len(pending) == 0 {
		return
	}
	slog.Info("reconcile pass start, querying pending orders against wechat", "pending", len(pending))
	for _, p := range pending {
		settleOne(ctx, st, gw, window, now, p)
	}
}

// settleOne queries WeChat for one pending order and applies the verdict:
// SUCCESS → paid (extends the license, idempotently); CLOSED/REVOKED/PAYERROR →
// expired; otherwise still awaiting payment — expired only if the window lapsed.
func settleOne(ctx context.Context, st Store, gw wechatpay.Gateway, window time.Duration, now time.Time, p orders.PendingOrder) {
	res, err := gw.QueryByOutTradeNo(ctx, p.OrderNo)
	if err != nil {
		// WeChat unreachable or order-not-found at WeChat: only expire it if its
		// window has lapsed; otherwise leave it for the next pass.
		slog.Warn("reconcile: wechat query failed", "orderNo", p.OrderNo, "err", err)
		if now.Sub(p.CreatedAt) > window {
			if _, advanced, err := st.MarkExpired(ctx, p.OrderNo); err != nil {
				slog.Error("reconcile: expire failed", "orderNo", p.OrderNo, "err", err)
			} else if advanced {
				slog.Info("reconcile: order expired (payment window lapsed, wechat unreachable)", "orderNo", p.OrderNo)
			}
		}
		return
	}
	slog.Info("reconcile: wechat trade_state", "orderNo", p.OrderNo, "tradeState", res.TradeState)
	switch {
	case res.Paid():
		if _, advanced, err := st.MarkPaid(ctx, p.OrderNo, res.TransactionID, now); err != nil {
			slog.Error("reconcile: mark paid failed", "orderNo", p.OrderNo, "err", err)
		} else if advanced {
			slog.Info("reconcile: order settled paid; license extended", "orderNo", p.OrderNo, "txid", res.TransactionID)
		} else {
			slog.Info("reconcile: order already settled (idempotent)", "orderNo", p.OrderNo)
		}
	case res.Closed() || now.Sub(p.CreatedAt) > window:
		if _, advanced, err := st.MarkExpired(ctx, p.OrderNo); err != nil {
			slog.Error("reconcile: expire failed", "orderNo", p.OrderNo, "err", err)
		} else if advanced {
			slog.Info("reconcile: order expired", "orderNo", p.OrderNo, "tradeState", res.TradeState)
		}
	default:
		// NOTPAY / USERPAYING and still within the window: leave pending.
		slog.Info("reconcile: order still awaiting payment, within window", "orderNo", p.OrderNo, "tradeState", res.TradeState)
	}
}
