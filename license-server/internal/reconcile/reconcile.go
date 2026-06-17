// Package reconcile runs the license-server's periodic order reconciliation
// (§11): a 20-minute job that asks WeChat Pay for the authoritative state of
// every pending order and settles it. It is the safety net behind the async
// payment callback — a missed or failed callback is recovered here — and the
// active enforcer of the 15-minute payment window: a pending order WeChat has
// closed (or that has out-waited the window) is moved to a terminal state.
//
// This scheduler is a LS process-internal time.Ticker; it belongs to the LS
// product (ADR-0026 grants LS the capabilities c3 forbids) and has nothing to do
// with c3's "no persistent background scheduler" constraint.
package reconcile

import (
	"context"
	"log"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
)

// Store is the persistence subset the reconcile job needs.
type Store interface {
	ListPendingOrders(ctx context.Context) ([]store.PendingOrder, error)
	MarkOrderPaid(ctx context.Context, orderNo, paymentRef string, now time.Time) (store.Order, bool, error)
	MarkOrderExpired(ctx context.Context, orderNo string) (store.Order, bool, error)
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
	pending, err := st.ListPendingOrders(ctx)
	if err != nil {
		log.Printf("license-server: reconcile: list pending failed: %v", err)
		return
	}
	for _, p := range pending {
		settleOne(ctx, st, gw, window, now, p)
	}
}

// settleOne queries WeChat for one pending order and applies the verdict:
// SUCCESS → paid (extends the license, idempotently); CLOSED/REVOKED/PAYERROR →
// expired; otherwise still awaiting payment — expired only if the window lapsed.
func settleOne(ctx context.Context, st Store, gw wechatpay.Gateway, window time.Duration, now time.Time, p store.PendingOrder) {
	res, err := gw.QueryByOutTradeNo(ctx, p.OrderNo)
	if err != nil {
		// WeChat unreachable or order-not-found at WeChat: only expire it if its
		// window has lapsed; otherwise leave it for the next pass.
		if now.Sub(p.CreatedAt) > window {
			if _, _, err := st.MarkOrderExpired(ctx, p.OrderNo); err != nil {
				log.Printf("license-server: reconcile: expire %s failed: %v", p.OrderNo, err)
			}
		}
		return
	}
	switch {
	case res.Paid():
		if _, _, err := st.MarkOrderPaid(ctx, p.OrderNo, res.TransactionID, now); err != nil {
			log.Printf("license-server: reconcile: mark paid %s failed: %v", p.OrderNo, err)
		}
	case res.Closed() || now.Sub(p.CreatedAt) > window:
		if _, _, err := st.MarkOrderExpired(ctx, p.OrderNo); err != nil {
			log.Printf("license-server: reconcile: expire %s failed: %v", p.OrderNo, err)
		}
	default:
		// NOTPAY / USERPAYING and still within the window: leave pending.
	}
}
