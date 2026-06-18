package orders

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	lsdb "github.com/sequencestream/code-creative-center/license-server/database"
	"github.com/sequencestream/code-creative-center/license-server/internal/licenses"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
)

// liveEnv bundles the repositories an order test exercises against a real DB: the
// order repo under test plus the plans/licenses repos it seeds and asserts on.
type liveEnv struct {
	orders   *Repo
	plans    *plans.Repo
	licenses *licenses.Repo
	st       *store.Store
	ctx      context.Context
}

// liveRepo connects to C3_LS_TEST_DATABASE_URL, migrates, and truncates the LS
// tables so each test starts clean. Skips when no DB is configured.
func liveRepo(t *testing.T) liveEnv {
	t.Helper()
	dsn := os.Getenv("C3_LS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("C3_LS_TEST_DATABASE_URL not set; skipping live store test")
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
	st := store.New(db)
	plansRepo := plans.NewRepo(st)
	licensesRepo := licenses.NewRepo(st)
	return liveEnv{
		orders:   NewRepo(st, plansRepo, licensesRepo),
		plans:    plansRepo,
		licenses: licensesRepo,
		st:       st,
		ctx:      ctx,
	}
}

var seedUserSeq int64

// seedLicense registers a fresh user (direct insert — orders does not import users)
// and issues them a license, returning the user id and license.
func seedLicense(t *testing.T, env liveEnv, now time.Time) (int64, licenses.License) {
	t.Helper()
	seedUserSeq++
	var userID int64
	err := env.st.DB().WithContext(env.ctx).Raw(`
		INSERT INTO c3_ls_user (github_id, github_login, email)
		VALUES ($1, $2, $3) RETURNING id`,
		700+seedUserSeq, "octocat-"+itoa(int(seedUserSeq)), "octo@example.com").Scan(&userID).Error
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	lic, _, err := env.licenses.EnsureForUser(env.ctx, userID, 30, now, keyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}
	return userID, lic
}

func keyGen(prefix string) func() string {
	n := 0
	return func() string {
		n++
		return prefix + "-" + time.Now().Format("150405.000000000") + "-" + itoa(n)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// licenseByID is a small test helper: the user's license matching id.
func licenseByID(t *testing.T, env liveEnv, userID, id int64) licenses.License {
	t.Helper()
	ls, err := env.licenses.ListByUser(env.ctx, userID)
	if err != nil {
		t.Fatalf("list licenses: %v", err)
	}
	for _, l := range ls {
		if l.ID == id {
			return l
		}
	}
	t.Fatalf("license %d not found for user %d", id, userID)
	return licenses.License{}
}

func TestCreateOrderDerivesAmountAndRecordsAcceptance(t *testing.T) {
	env := liveRepo(t)
	now := time.Now()
	if err := env.plans.Seed(env.ctx, []plans.Record{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	userID, lic := seedLicense(t, env, now)

	acceptedAt := now.Add(-time.Minute)
	order, err := env.orders.Create(env.ctx, CreateOrderInput{
		UserID:              userID,
		LicenseID:           lic.ID,
		PlanKey:             "6m",
		AgreementVersion:    "v-test",
		AgreementAcceptedAt: acceptedAt,
	}, func() string { return NewOrderNo(time.Now()) })
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	// Amount is derived from the plan, not supplied by the caller (PL-R9).
	if order.AmountCents != 590 || order.Currency != "CNY" {
		t.Errorf("order amount = %d %s, want 590 CNY", order.AmountCents, order.Currency)
	}
	if order.Status != "pending" {
		t.Errorf("order status = %q, want pending", order.Status)
	}
	if order.LicenseID != lic.ID || order.PlanKey != "6m" {
		t.Errorf("order linkage = license %d plan %q, want %d 6m", order.LicenseID, order.PlanKey, lic.ID)
	}

	// Agreement acceptance is persisted on the row.
	var row struct {
		AgreementVersion    string
		AgreementAcceptedAt time.Time
		AmountCents         int
	}
	if err := env.st.DB().WithContext(env.ctx).Raw(
		`SELECT agreement_version, agreement_accepted_at, amount_cents FROM c3_ls_order WHERE id=$1`,
		order.ID).Scan(&row).Error; err != nil {
		t.Fatalf("read order: %v", err)
	}
	if row.AgreementVersion != "v-test" || row.AgreementAcceptedAt.IsZero() {
		t.Errorf("agreement not persisted: %+v", row)
	}
	if row.AmountCents != 590 {
		t.Errorf("persisted amount = %d, want 590", row.AmountCents)
	}

	// The order shows up in the user's history.
	got, err := env.orders.ByUser(env.ctx, userID)
	if err != nil {
		t.Fatalf("orders by user: %v", err)
	}
	if len(got) != 1 || got[0].ID != order.ID {
		t.Errorf("ByUser = %+v, want one order %d", got, order.ID)
	}
}

func TestCreateOrderRejectsWithoutAgreement(t *testing.T) {
	env := liveRepo(t)
	now := time.Now()
	if err := env.plans.Seed(env.ctx, []plans.Record{
		{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	userID, lic := seedLicense(t, env, now)

	// Missing version.
	if _, err := env.orders.Create(env.ctx, CreateOrderInput{
		UserID: userID, LicenseID: lic.ID, PlanKey: "1m", AgreementAcceptedAt: now,
	}, func() string { return NewOrderNo(time.Now()) }); !errors.Is(err, ErrAgreementRequired) {
		t.Errorf("missing version err = %v, want ErrAgreementRequired", err)
	}
	// Missing accepted-at.
	if _, err := env.orders.Create(env.ctx, CreateOrderInput{
		UserID: userID, LicenseID: lic.ID, PlanKey: "1m", AgreementVersion: "v",
	}, func() string { return NewOrderNo(time.Now()) }); !errors.Is(err, ErrAgreementRequired) {
		t.Errorf("missing accepted-at err = %v, want ErrAgreementRequired", err)
	}
	// Nothing was written.
	got, err := env.orders.ByUser(env.ctx, userID)
	if err != nil {
		t.Fatalf("orders by user: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("rejected order should not persist, got %+v", got)
	}
}

func TestCreateOrderRejectsUnknownPlan(t *testing.T) {
	env := liveRepo(t)
	now := time.Now()
	userID, lic := seedLicense(t, env, now)
	if _, err := env.orders.Create(env.ctx, CreateOrderInput{
		UserID: userID, LicenseID: lic.ID, PlanKey: "no-such-plan",
		AgreementVersion: "v", AgreementAcceptedAt: now,
	}, func() string { return NewOrderNo(time.Now()) }); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown plan err = %v, want ErrNotFound", err)
	}
}

func TestMarkOrderPaidExtendsLicenseAndIsIdempotent(t *testing.T) {
	env := liveRepo(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := env.plans.Seed(env.ctx, []plans.Record{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	userID, lic := seedLicense(t, env, now)

	order, err := env.orders.Create(env.ctx, CreateOrderInput{
		UserID: userID, LicenseID: lic.ID, PlanKey: "6m",
		AgreementVersion: "v1", AgreementAcceptedAt: now,
	}, func() string { return NewOrderNo(time.Now()) })
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	if order.Status != "pending" {
		t.Fatalf("new order status = %q, want pending", order.Status)
	}

	// Pay it: pending → paid, payment_ref recorded, license term extended by 6 months.
	paid, advanced, err := env.orders.MarkPaid(env.ctx, order.OrderNo, "wx-tx-1", now)
	if err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	if !advanced {
		t.Error("first MarkPaid should report the pending→paid transition")
	}
	if paid.Status != "paid" || paid.PaymentRef != "wx-tx-1" {
		t.Errorf("paid order = %+v, want status paid + payment_ref wx-tx-1", paid)
	}

	wantEnd := lic.TermEnd
	if now.After(wantEnd) {
		wantEnd = now
	}
	wantEnd = wantEnd.AddDate(0, 6, 0)
	got := licenseByID(t, env, userID, lic.ID)
	if d := got.TermEnd.Sub(wantEnd); d > time.Second || d < -time.Second {
		t.Errorf("term_end = %v, want ~%v (extended by 6 months)", got.TermEnd, wantEnd)
	}
	if got.Status != "active" {
		t.Errorf("license status = %q, want active", got.Status)
	}
	endAfterFirst := got.TermEnd

	// Replay the same callback: idempotent — no second transition, no re-extension.
	again, advanced2, err := env.orders.MarkPaid(env.ctx, order.OrderNo, "wx-tx-1", now.Add(time.Hour))
	if err != nil {
		t.Fatalf("mark paid again: %v", err)
	}
	if advanced2 {
		t.Error("replayed MarkPaid must not report a transition")
	}
	if again.Status != "paid" {
		t.Errorf("replayed order status = %q, want paid", again.Status)
	}
	got2 := licenseByID(t, env, userID, lic.ID)
	if !got2.TermEnd.Equal(endAfterFirst) {
		t.Errorf("term_end moved on replay: %v != %v (license re-extended)", got2.TermEnd, endAfterFirst)
	}
}

func TestMarkOrderPaidReactivatesExpiredLicense(t *testing.T) {
	env := liveRepo(t)
	now := time.Now().UTC().Truncate(time.Second)

	if err := env.plans.Seed(env.ctx, []plans.Record{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	userID, lic := seedLicense(t, env, now)

	// Force the license into expired state — past term_end, status = expired.
	past := now.Add(-24 * time.Hour)
	if err := env.st.DB().WithContext(env.ctx).Exec(
		`UPDATE c3_ls_license SET status='expired', term_end=$2 WHERE id=$1`,
		lic.ID, past).Error; err != nil {
		t.Fatalf("expire license: %v", err)
	}

	order, err := env.orders.Create(env.ctx, CreateOrderInput{
		UserID: userID, LicenseID: lic.ID, PlanKey: "6m",
		AgreementVersion: "v1", AgreementAcceptedAt: now,
	}, func() string { return NewOrderNo(time.Now()) })
	if err != nil {
		t.Fatalf("create order: %v", err)
	}

	// Pay it: pending → paid. Since term_end is in the past, GREATEST(term_end, now)
	// picks now as the base, then adds 6 months.
	paid, advanced, err := env.orders.MarkPaid(env.ctx, order.OrderNo, "wx-tx-expired", now)
	if err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	if !advanced {
		t.Error("first MarkPaid should report the pending→paid transition")
	}
	if paid.Status != "paid" || paid.PaymentRef != "wx-tx-expired" {
		t.Errorf("paid order = %+v, want status paid + payment_ref wx-tx-expired", paid)
	}

	wantEnd := now.AddDate(0, 6, 0)
	got := licenseByID(t, env, userID, lic.ID)
	if got.Status != "active" {
		t.Errorf("license status = %q, want active (was expired)", got.Status)
	}
	if d := got.TermEnd.Sub(wantEnd); d > time.Second || d < -time.Second {
		t.Errorf("term_end = %v, want ~%v (extended from now, not old term_end %v)", got.TermEnd, wantEnd, past)
	}
	endAfterFirst := got.TermEnd

	// Replay: idempotent — no second extension.
	again, advanced2, err := env.orders.MarkPaid(env.ctx, order.OrderNo, "wx-tx-expired", now.Add(time.Hour))
	if err != nil {
		t.Fatalf("mark paid again: %v", err)
	}
	if advanced2 {
		t.Error("replayed MarkPaid must not report a transition")
	}
	if again.Status != "paid" {
		t.Errorf("replayed order status = %q, want paid", again.Status)
	}
	got2 := licenseByID(t, env, userID, lic.ID)
	if !got2.TermEnd.Equal(endAfterFirst) {
		t.Errorf("term_end moved on replay: %v != %v (license re-extended)", got2.TermEnd, endAfterFirst)
	}
}

func TestMarkOrderFailedThenPaidDoesNotMutate(t *testing.T) {
	env := liveRepo(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := env.plans.Seed(env.ctx, []plans.Record{
		{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	userID, lic := seedLicense(t, env, now)
	order, err := env.orders.Create(env.ctx, CreateOrderInput{
		UserID: userID, LicenseID: lic.ID, PlanKey: "1m",
		AgreementVersion: "v1", AgreementAcceptedAt: now,
	}, func() string { return NewOrderNo(time.Now()) })
	if err != nil {
		t.Fatalf("create order: %v", err)
	}

	failed, advanced, err := env.orders.MarkFailed(env.ctx, order.OrderNo, "wx-fail-1")
	if err != nil || !advanced || failed.Status != "failed" {
		t.Fatalf("mark failed = (%+v, %v, %v), want failed + advanced", failed, advanced, err)
	}
	// A terminal failed order is never flipped to paid by a later callback.
	after, advanced2, err := env.orders.MarkPaid(env.ctx, order.OrderNo, "wx-tx-late", now)
	if err != nil {
		t.Fatalf("mark paid on failed: %v", err)
	}
	if advanced2 {
		t.Error("a failed order must not transition to paid")
	}
	if after.Status != "failed" {
		t.Errorf("order status = %q, want failed (unchanged)", after.Status)
	}
}

func TestMarkOrderPaidUnknownOrder(t *testing.T) {
	env := liveRepo(t)
	if _, _, err := env.orders.MarkPaid(env.ctx, "no-such-order-no", "x", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown order err = %v, want ErrNotFound", err)
	}
}
