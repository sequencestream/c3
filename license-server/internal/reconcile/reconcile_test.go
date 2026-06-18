package reconcile

import (
	"context"
	"testing"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/orders"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
)

// fakeStore records the settlement calls runOnce makes.
type fakeStore struct {
	pending []orders.PendingOrder
	paid    []string
	expired []string
}

func (f *fakeStore) ListPending(context.Context) ([]orders.PendingOrder, error) {
	return f.pending, nil
}
func (f *fakeStore) MarkPaid(_ context.Context, orderNo, _ string, _ time.Time) (orders.Order, bool, error) {
	f.paid = append(f.paid, orderNo)
	return orders.Order{}, true, nil
}
func (f *fakeStore) MarkExpired(_ context.Context, orderNo string) (orders.Order, bool, error) {
	f.expired = append(f.expired, orderNo)
	return orders.Order{}, true, nil
}

// fakeGW answers QueryByOutTradeNo from a per-order_no table.
type fakeGW struct {
	states map[string]string // orderNo -> trade_state
	errs   map[string]bool   // orderNo -> query error
}

func (g fakeGW) Prepay(context.Context, wechatpay.PrepayInput) (wechatpay.PrepayResult, error) {
	return wechatpay.PrepayResult{}, nil
}
func (g fakeGW) ParseNotify(func(string) string, []byte) (wechatpay.NotifyResult, error) {
	return wechatpay.NotifyResult{}, nil
}
func (g fakeGW) QueryByOutTradeNo(_ context.Context, no string) (wechatpay.NotifyResult, error) {
	if g.errs[no] {
		return wechatpay.NotifyResult{}, context.DeadlineExceeded
	}
	return wechatpay.NotifyResult{OutTradeNo: no, TradeState: g.states[no]}, nil
}

func TestRunOnceSettlesByTradeState(t *testing.T) {
	now := time.Now()
	window := 15 * time.Minute
	fresh := now.Add(-1 * time.Minute)  // within window
	stale := now.Add(-30 * time.Minute) // past window

	st := &fakeStore{pending: []orders.PendingOrder{
		{OrderNo: "paid", CreatedAt: fresh},
		{OrderNo: "closed", CreatedAt: fresh},
		{OrderNo: "notpay-fresh", CreatedAt: fresh},
		{OrderNo: "notpay-stale", CreatedAt: stale},
		{OrderNo: "err-stale", CreatedAt: stale},
		{OrderNo: "err-fresh", CreatedAt: fresh},
	}}
	gw := fakeGW{
		states: map[string]string{
			"paid":         wechatpay.TradeStateSuccess,
			"closed":       wechatpay.TradeStateClosed,
			"notpay-fresh": wechatpay.TradeStateNotPay,
			"notpay-stale": wechatpay.TradeStateNotPay,
		},
		errs: map[string]bool{"err-stale": true, "err-fresh": true},
	}

	runOnce(context.Background(), st, gw, window, now)

	if len(st.paid) != 1 || st.paid[0] != "paid" {
		t.Errorf("paid = %v, want [paid]", st.paid)
	}
	// closed, notpay-stale (past window), and err-stale (past window) all expire.
	wantExpired := map[string]bool{"closed": true, "notpay-stale": true, "err-stale": true}
	if len(st.expired) != len(wantExpired) {
		t.Fatalf("expired = %v, want %v", st.expired, wantExpired)
	}
	for _, no := range st.expired {
		if !wantExpired[no] {
			t.Errorf("unexpected expire: %s", no)
		}
	}
	// notpay-fresh and err-fresh stay pending (neither paid nor expired).
}
