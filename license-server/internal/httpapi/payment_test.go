package httpapi

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"testing"
	"testing/fstest"
	"time"

	lsdb "github.com/sequencestream/code-creative-center/license-server/database"
	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
)

// fakeGateway is a stand-in WeChat Pay gateway: it returns canned prepay/parse
// results so the HTTP surface (state machine + acknowledgement) is testable
// without reaching WeChat. The real verify/decrypt path is unit-tested in the
// wechatpay package.
type fakeGateway struct {
	parse func(headerFetcher func(string) string, body []byte) (wechatpay.NotifyResult, error)
	query func(outTradeNo string) (wechatpay.NotifyResult, error)
}

func (f fakeGateway) Prepay(ctx context.Context, in wechatpay.PrepayInput) (wechatpay.PrepayResult, error) {
	return wechatpay.PrepayResult{CodeURL: "weixin://wxpay/fake"}, nil
}

func (f fakeGateway) ParseNotify(headerFetcher func(string) string, body []byte) (wechatpay.NotifyResult, error) {
	return f.parse(headerFetcher, body)
}

func (f fakeGateway) QueryByOutTradeNo(ctx context.Context, outTradeNo string) (wechatpay.NotifyResult, error) {
	if f.query != nil {
		return f.query(outTradeNo)
	}
	return wechatpay.NotifyResult{OutTradeNo: outTradeNo, TradeState: wechatpay.TradeStateNotPay}, nil
}

func TestNotifyRejectsNonPOST(t *testing.T) {
	h, _ := signedServer(t)
	res := do(t, h, "GET", "/v1/payment/wechat/notify")
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET notify = %d, want 405", res.StatusCode)
	}
}

func TestNotifyUnavailableWhenUnconfigured(t *testing.T) {
	h, _ := signedServer(t) // no Pay, no DB
	res := postJSON(t, h, "/v1/payment/wechat/notify", `{}`)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("notify unconfigured = %d, want 503", res.StatusCode)
	}
}

// --- live (DB-gated) ---------------------------------------------------------

// livePayServer builds a DB-backed server with the given gateway injected, so
// the notify endpoint can drive the real order state machine. Skips without
// C3_LS_TEST_DATABASE_URL.
func livePayServer(t *testing.T, pay wechatpay.Gateway) (http.Handler, *store.Store, context.Context) {
	t.Helper()
	dsn := os.Getenv("C3_LS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("C3_LS_TEST_DATABASE_URL not set; skipping live payment test")
	}
	ctx := context.Background()
	db, err := lsdb.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := lsdb.EnsureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.WithContext(ctx).Exec(
		`TRUNCATE c3_ls_license, c3_ls_order, c3_ls_user, c3_ls_plan RESTART IDENTITY CASCADE`).Error; err != nil {
		t.Fatalf("truncate: %v", err)
	}
	cfg, _ := config.LoadFrom(func(string) string { return "" })
	st := store.New(db)
	h := NewServer(Deps{
		Config: cfg,
		Caches: cache.NewRegistry(cfg.LRUSize),
		DB:     db,
		Static: fstest.MapFS{"index.html": {Data: []byte("spa")}},
		Store:  st,
		Pay:    pay,
	})
	return h, st, ctx
}

// seedPendingOrder seeds a user + license + plan and returns a pending order to
// drive through the callback.
func seedPendingOrder(t *testing.T, st *store.Store, ctx context.Context) store.Order {
	t.Helper()
	if err := st.SeedPlans(ctx, []store.Plan{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	userID, err := st.UpsertUser(ctx, 4242, "octocat", "octo@example.com")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	lic, _, err := st.EnsureLicenseForUser(ctx, userID, "6m", 30, time.Now(), keyGenPay())
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}
	order, err := st.CreateOrder(ctx, store.CreateOrderInput{
		UserID: userID, LicenseID: lic.ID, PlanKey: "6m",
		AgreementVersion: "v1", AgreementAcceptedAt: time.Now(),
	}, func() string { return store.NewOrderNo(time.Now()) })
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	return order
}

func TestNotifyMarksOrderPaidAndIsIdempotent(t *testing.T) {
	var order store.Order
	gw := fakeGateway{parse: func(func(string) string, []byte) (wechatpay.NotifyResult, error) {
		return wechatpay.NotifyResult{
			OutTradeNo:    order.OrderNo,
			TransactionID: "wx-tx-1",
			TradeState:    wechatpay.TradeStateSuccess,
			AmountCents:   590,
		}, nil
	}}
	h, st, ctx := livePayServer(t, gw)
	order = seedPendingOrder(t, st, ctx)

	// First callback: order paid, payment_ref recorded.
	res := postJSON(t, h, "/v1/payment/wechat/notify", `{"any":"body"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("notify = %d, want 200", res.StatusCode)
	}
	got, err := st.OrderByID(ctx, order.ID)
	if err != nil {
		t.Fatalf("order by id: %v", err)
	}
	if got.Status != "paid" || got.PaymentRef != "wx-tx-1" {
		t.Errorf("order = %+v, want paid + payment_ref wx-tx-1", got)
	}

	// Replayed callback: still 200, still paid (idempotent).
	res2 := postJSON(t, h, "/v1/payment/wechat/notify", `{"any":"body"}`)
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("replayed notify = %d, want 200", res2.StatusCode)
	}
	got2, _ := st.OrderByID(ctx, order.ID)
	if got2.Status != "paid" {
		t.Errorf("replayed order status = %q, want paid", got2.Status)
	}
}

func TestNotifyRejectsForgedSignature(t *testing.T) {
	var order store.Order
	gw := fakeGateway{parse: func(func(string) string, []byte) (wechatpay.NotifyResult, error) {
		return wechatpay.NotifyResult{}, wechatpay.ErrSignatureInvalid
	}}
	h, st, ctx := livePayServer(t, gw)
	order = seedPendingOrder(t, st, ctx)

	res := postJSON(t, h, "/v1/payment/wechat/notify", `{"forged":true}`)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("forged notify = %d, want 401", res.StatusCode)
	}
	// The order must be untouched — a forged callback never advances it.
	got, _ := st.OrderByID(ctx, order.ID)
	if got.Status != "pending" {
		t.Errorf("order status after forged callback = %q, want pending", got.Status)
	}
}

func TestNotifyRejectsUnknownOutTradeNo(t *testing.T) {
	gw := fakeGateway{parse: func(func(string) string, []byte) (wechatpay.NotifyResult, error) {
		return wechatpay.NotifyResult{OutTradeNo: "someone-elses-order", TradeState: wechatpay.TradeStateSuccess}, nil
	}}
	h, _, _ := livePayServer(t, gw)
	res := postJSON(t, h, "/v1/payment/wechat/notify", `{}`)
	// An out_trade_no (order_no) that matches no order resolves to ErrNotFound → 404.
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown out_trade_no = %d, want 404", res.StatusCode)
	}
}

// keyGenPay is a unique license-key generator for payment tests.
func keyGenPay() func() string {
	n := 0
	return func() string {
		n++
		return "lkpay-" + strconv.Itoa(n)
	}
}
