package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	lsdb "github.com/sequencestream/code-creative-center/license-server/database"
)

func TestHashCodeIsStableAndOneWay(t *testing.T) {
	a := HashCode("alive-token-123")
	b := HashCode("alive-token-123")
	if a != b {
		t.Fatal("HashCode should be deterministic")
	}
	if a == "alive-token-123" || len(a) != 64 {
		t.Fatalf("HashCode should be a 64-hex digest, got %q", a)
	}
	if HashCode("other") == a {
		t.Fatal("distinct inputs should hash differently")
	}
}

// liveStore connects to C3_LS_TEST_DATABASE_URL, migrates, and truncates the LS
// tables so each test starts clean. Skips when no DB is configured.
func liveStore(t *testing.T) (*Store, context.Context) {
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
	return New(db), ctx
}

// seedLicense registers a buyer and issues them a license, returning its key.
func seedLicense(t *testing.T, s *Store, ctx context.Context, now time.Time) (int64, License) {
	t.Helper()
	buyerID, err := s.UpsertBuyer(ctx, 777, "octocat", "octo@example.com")
	if err != nil {
		t.Fatalf("upsert buyer: %v", err)
	}
	keys := keyGen("lk")
	lic, issued, err := s.EnsureLicenseForBuyer(ctx, buyerID, "1m", 30, now, keys)
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}
	if !issued {
		t.Fatal("first ensure should issue a new license")
	}
	if lic.LicenseKey == "" {
		t.Fatal("issued license must carry a key")
	}
	return buyerID, lic
}

// keyGen returns a deterministic-but-unique generator for tests.
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

func TestEnsureLicenseReusesActiveLicense(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	buyerID, lic := seedLicense(t, s, ctx, now)

	again, issued, err := s.EnsureLicenseForBuyer(ctx, buyerID, "1m", 30, now, keyGen("lk2"))
	if err != nil {
		t.Fatalf("ensure again: %v", err)
	}
	if issued {
		t.Error("second ensure should reuse the active license, not issue a new one")
	}
	if again.ID != lic.ID || again.LicenseKey != lic.LicenseKey {
		t.Errorf("reuse mismatch: %+v vs %+v", again, lic)
	}
}

func TestBindThenHeartbeatActive(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	_, lic := seedLicense(t, s, ctx, now)

	res, err := s.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "alive-plain" })
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if res.AliveToken != "alive-plain" {
		t.Errorf("bind should return the plaintext alive token, got %q", res.AliveToken)
	}

	// The alive token is stored only as a hash (PL-R2).
	var stored string
	if err := s.db.WithContext(ctx).Raw(
		`SELECT alive_token FROM c3_ls_license WHERE id=$1`, lic.ID).Scan(&stored).Error; err != nil {
		t.Fatalf("read alive hash: %v", err)
	}
	if stored != HashCode("alive-plain") || stored == "alive-plain" {
		t.Errorf("alive token must be stored hashed, got %q", stored)
	}

	hb, err := s.Heartbeat(ctx, lic.LicenseKey, "inst-1", "alive-plain", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if hb.Status != HeartbeatActive {
		t.Errorf("heartbeat status = %q, want active", hb.Status)
	}
}

func TestBindIsExclusiveAndDisablesPrevious(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	_, lic := seedLicense(t, s, ctx, now)

	a, err := s.BindInstallation(ctx, lic.LicenseKey, "inst-A", now, func() string { return "alive-A" })
	if err != nil {
		t.Fatalf("bind A: %v", err)
	}
	// Rebinding to a different installation displaces the first.
	if _, err := s.BindInstallation(ctx, lic.LicenseKey, "inst-B", now, func() string { return "alive-B" }); err != nil {
		t.Fatalf("bind B: %v", err)
	}

	// inst-A's heartbeat now reports disabled (license moved).
	hbA, err := s.Heartbeat(ctx, lic.LicenseKey, "inst-A", a.AliveToken, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("heartbeat A: %v", err)
	}
	if hbA.Status != HeartbeatDisabled {
		t.Errorf("displaced installation status = %q, want disabled", hbA.Status)
	}

	// inst-B's heartbeat is active.
	hbB, err := s.Heartbeat(ctx, lic.LicenseKey, "inst-B", "alive-B", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("heartbeat B: %v", err)
	}
	if hbB.Status != HeartbeatActive {
		t.Errorf("current installation status = %q, want active", hbB.Status)
	}
}

func TestHeartbeatRejectsStaleAliveToken(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	_, lic := seedLicense(t, s, ctx, now)
	if _, err := s.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "alive-1" }); err != nil {
		t.Fatalf("bind: %v", err)
	}
	// Same install, but a superseded/forged alive token ⇒ disabled.
	hb, err := s.Heartbeat(ctx, lic.LicenseKey, "inst-1", "wrong-token", now)
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if hb.Status != HeartbeatDisabled {
		t.Errorf("stale token status = %q, want disabled", hb.Status)
	}
}

func TestBindRejectsUnknownKey(t *testing.T) {
	s, ctx := liveStore(t)
	if _, err := s.BindInstallation(ctx, "no-such-key", "inst-1", time.Now(), func() string { return "x" }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bind unknown key err = %v, want ErrNotFound", err)
	}
	if _, err := s.Heartbeat(ctx, "no-such-key", "inst-1", "x", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("heartbeat unknown key err = %v, want ErrNotFound", err)
	}
}

func TestHeartbeatReportsExpired(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	_, lic := seedLicense(t, s, ctx, now)
	if _, err := s.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "alive" }); err != nil {
		t.Fatalf("bind: %v", err)
	}

	// Admin force-expire (status='expired', term still in the future) → heartbeat
	// reports expired, and a fresh bind is rejected.
	if err := s.db.WithContext(ctx).Exec(`UPDATE c3_ls_license SET status='expired' WHERE id=$1`, lic.ID).Error; err != nil {
		t.Fatalf("force-expire: %v", err)
	}
	hb, _ := s.Heartbeat(ctx, lic.LicenseKey, "inst-1", "alive", now)
	if hb.Status != HeartbeatExpired {
		t.Errorf("force-expired heartbeat status = %q", hb.Status)
	}
	if _, err := s.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "x" }); !errors.Is(err, ErrExpired) {
		t.Errorf("bind of force-expired license err = %v, want ErrExpired", err)
	}

	// Lapsed term (status active, term_end in the past) → heartbeat reports expired.
	if err := s.db.WithContext(ctx).Exec(
		`UPDATE c3_ls_license SET status='active', term_end=$2 WHERE id=$1`, lic.ID, now.Add(-time.Hour)).Error; err != nil {
		t.Fatalf("expire term: %v", err)
	}
	hb, _ = s.Heartbeat(ctx, lic.LicenseKey, "inst-1", "alive", now)
	if hb.Status != HeartbeatExpired {
		t.Errorf("expired heartbeat status = %q", hb.Status)
	}
	if _, err := s.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "x" }); !errors.Is(err, ErrExpired) {
		t.Errorf("bind of expired license err = %v, want ErrExpired", err)
	}
}

func TestCreateOrderDerivesAmountAndRecordsAcceptance(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	if err := s.SeedPlans(ctx, []Plan{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	buyerID, lic := seedLicense(t, s, ctx, now)

	acceptedAt := now.Add(-time.Minute)
	order, err := s.CreateOrder(ctx, CreateOrderInput{
		UserID:              buyerID,
		LicenseID:           lic.ID,
		PlanKey:             "6m",
		AgreementVersion:    "v-test",
		AgreementAcceptedAt: acceptedAt,
	})
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
	if err := s.db.WithContext(ctx).Raw(
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

	// The order shows up in the buyer's history.
	orders, err := s.OrdersByUser(ctx, buyerID)
	if err != nil {
		t.Fatalf("orders by user: %v", err)
	}
	if len(orders) != 1 || orders[0].ID != order.ID {
		t.Errorf("OrdersByUser = %+v, want one order %d", orders, order.ID)
	}
}

func TestCreateOrderRejectsWithoutAgreement(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	if err := s.SeedPlans(ctx, []Plan{
		{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	buyerID, lic := seedLicense(t, s, ctx, now)

	// Missing version.
	if _, err := s.CreateOrder(ctx, CreateOrderInput{
		UserID: buyerID, LicenseID: lic.ID, PlanKey: "1m", AgreementAcceptedAt: now,
	}); !errors.Is(err, ErrAgreementRequired) {
		t.Errorf("missing version err = %v, want ErrAgreementRequired", err)
	}
	// Missing accepted-at.
	if _, err := s.CreateOrder(ctx, CreateOrderInput{
		UserID: buyerID, LicenseID: lic.ID, PlanKey: "1m", AgreementVersion: "v",
	}); !errors.Is(err, ErrAgreementRequired) {
		t.Errorf("missing accepted-at err = %v, want ErrAgreementRequired", err)
	}
	// Nothing was written.
	orders, err := s.OrdersByUser(ctx, buyerID)
	if err != nil {
		t.Fatalf("orders by user: %v", err)
	}
	if len(orders) != 0 {
		t.Errorf("rejected order should not persist, got %+v", orders)
	}
}

func TestCreateOrderRejectsUnknownPlan(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()
	buyerID, lic := seedLicense(t, s, ctx, now)
	if _, err := s.CreateOrder(ctx, CreateOrderInput{
		UserID: buyerID, LicenseID: lic.ID, PlanKey: "no-such-plan",
		AgreementVersion: "v", AgreementAcceptedAt: now,
	}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown plan err = %v, want ErrNotFound", err)
	}
}

func TestSeedAndListPlans(t *testing.T) {
	s, ctx := liveStore(t)

	seed := []Plan{
		{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0},
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
		{PlanKey: "1y", Name: "1 Year", DurationMonths: 12, PriceCents: 1090, Currency: "CNY", SortOrder: 2},
	}
	if err := s.SeedPlans(ctx, seed); err != nil {
		t.Fatalf("seed plans: %v", err)
	}

	got, err := s.ListPlans(ctx)
	if err != nil {
		t.Fatalf("list plans: %v", err)
	}
	if len(got) != len(seed) {
		t.Fatalf("ListPlans len = %d, want %d", len(got), len(seed))
	}
	for i := range seed {
		// id is auto-assigned by the database; compare the rest field-for-field.
		if got[i].ID <= 0 {
			t.Errorf("plan[%d] should carry an auto-assigned id, got %d", i, got[i].ID)
		}
		got[i].ID = 0
		if got[i] != seed[i] {
			t.Errorf("plan[%d] = %+v, want %+v", i, got[i], seed[i])
		}
	}

	// Re-seeding with a changed price is a no-op (ON CONFLICT DO NOTHING): the
	// database is the live store after the first seed; operator edits survive.
	bumped := []Plan{{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 999, Currency: "CNY", SortOrder: 0}}
	if err := s.SeedPlans(ctx, bumped); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	got, err = s.ListPlans(ctx)
	if err != nil {
		t.Fatalf("list after re-seed: %v", err)
	}
	if got[0].PriceCents != 100 {
		t.Errorf("re-seed clobbered existing row: price = %d, want 100", got[0].PriceCents)
	}
}

// licenseByID is a small test helper: the buyer's license matching id.
func licenseByID(t *testing.T, s *Store, ctx context.Context, buyerID, id int64) License {
	t.Helper()
	licenses, err := s.ListLicensesByBuyer(ctx, buyerID)
	if err != nil {
		t.Fatalf("list licenses: %v", err)
	}
	for _, l := range licenses {
		if l.ID == id {
			return l
		}
	}
	t.Fatalf("license %d not found for buyer %d", id, buyerID)
	return License{}
}

func TestMarkOrderPaidExtendsLicenseAndIsIdempotent(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.SeedPlans(ctx, []Plan{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	buyerID, lic := seedLicense(t, s, ctx, now)

	order, err := s.CreateOrder(ctx, CreateOrderInput{
		UserID: buyerID, LicenseID: lic.ID, PlanKey: "6m",
		AgreementVersion: "v1", AgreementAcceptedAt: now,
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	if order.Status != "pending" {
		t.Fatalf("new order status = %q, want pending", order.Status)
	}

	// Pay it: pending → paid, payment_ref recorded, license term extended by 6 months.
	paid, advanced, err := s.MarkOrderPaid(ctx, order.ID, "wx-tx-1", now)
	if err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	if !advanced {
		t.Error("first MarkOrderPaid should report the pending→paid transition")
	}
	if paid.Status != "paid" || paid.PaymentRef != "wx-tx-1" {
		t.Errorf("paid order = %+v, want status paid + payment_ref wx-tx-1", paid)
	}

	wantEnd := lic.TermEnd
	if now.After(wantEnd) {
		wantEnd = now
	}
	wantEnd = wantEnd.AddDate(0, 6, 0)
	got := licenseByID(t, s, ctx, buyerID, lic.ID)
	if d := got.TermEnd.Sub(wantEnd); d > time.Second || d < -time.Second {
		t.Errorf("term_end = %v, want ~%v (extended by 6 months)", got.TermEnd, wantEnd)
	}
	if got.Status != "active" {
		t.Errorf("license status = %q, want active", got.Status)
	}
	endAfterFirst := got.TermEnd

	// Replay the same callback: idempotent — no second transition, no re-extension.
	again, advanced2, err := s.MarkOrderPaid(ctx, order.ID, "wx-tx-1", now.Add(time.Hour))
	if err != nil {
		t.Fatalf("mark paid again: %v", err)
	}
	if advanced2 {
		t.Error("replayed MarkOrderPaid must not report a transition")
	}
	if again.Status != "paid" {
		t.Errorf("replayed order status = %q, want paid", again.Status)
	}
	got2 := licenseByID(t, s, ctx, buyerID, lic.ID)
	if !got2.TermEnd.Equal(endAfterFirst) {
		t.Errorf("term_end moved on replay: %v != %v (license re-extended)", got2.TermEnd, endAfterFirst)
	}
}

func TestMarkOrderPaidReactivatesExpiredLicense(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now().UTC().Truncate(time.Second)

	if err := s.SeedPlans(ctx, []Plan{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	buyerID, lic := seedLicense(t, s, ctx, now)

	// Force the license into expired state — past term_end, status = expired.
	past := now.Add(-24 * time.Hour)
	if err := s.db.WithContext(ctx).Exec(
		`UPDATE c3_ls_license SET status='expired', term_end=$2 WHERE id=$1`,
		lic.ID, past).Error; err != nil {
		t.Fatalf("expire license: %v", err)
	}

	order, err := s.CreateOrder(ctx, CreateOrderInput{
		UserID: buyerID, LicenseID: lic.ID, PlanKey: "6m",
		AgreementVersion: "v1", AgreementAcceptedAt: now,
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}

	// Pay it: pending → paid. Since term_end is in the past, GREATEST(term_end,
	// now) picks now as the base, then adds 6 months.
	paid, advanced, err := s.MarkOrderPaid(ctx, order.ID, "wx-tx-expired", now)
	if err != nil {
		t.Fatalf("mark paid: %v", err)
	}
	if !advanced {
		t.Error("first MarkOrderPaid should report the pending→paid transition")
	}
	if paid.Status != "paid" || paid.PaymentRef != "wx-tx-expired" {
		t.Errorf("paid order = %+v, want status paid + payment_ref wx-tx-expired", paid)
	}

	wantEnd := now.AddDate(0, 6, 0)
	got := licenseByID(t, s, ctx, buyerID, lic.ID)
	if got.Status != "active" {
		t.Errorf("license status = %q, want active (was expired)", got.Status)
	}
	if d := got.TermEnd.Sub(wantEnd); d > time.Second || d < -time.Second {
		t.Errorf("term_end = %v, want ~%v (extended from now, not old term_end %v)", got.TermEnd, wantEnd, past)
	}
	endAfterFirst := got.TermEnd

	// Replay: idempotent — no second extension.
	again, advanced2, err := s.MarkOrderPaid(ctx, order.ID, "wx-tx-expired", now.Add(time.Hour))
	if err != nil {
		t.Fatalf("mark paid again: %v", err)
	}
	if advanced2 {
		t.Error("replayed MarkOrderPaid must not report a transition")
	}
	if again.Status != "paid" {
		t.Errorf("replayed order status = %q, want paid", again.Status)
	}
	got2 := licenseByID(t, s, ctx, buyerID, lic.ID)
	if !got2.TermEnd.Equal(endAfterFirst) {
		t.Errorf("term_end moved on replay: %v != %v (license re-extended)", got2.TermEnd, endAfterFirst)
	}
}

func TestMarkOrderFailedThenPaidDoesNotMutate(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	if err := s.SeedPlans(ctx, []Plan{
		{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	buyerID, lic := seedLicense(t, s, ctx, now)
	order, err := s.CreateOrder(ctx, CreateOrderInput{
		UserID: buyerID, LicenseID: lic.ID, PlanKey: "1m",
		AgreementVersion: "v1", AgreementAcceptedAt: now,
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}

	failed, advanced, err := s.MarkOrderFailed(ctx, order.ID, "wx-fail-1")
	if err != nil || !advanced || failed.Status != "failed" {
		t.Fatalf("mark failed = (%+v, %v, %v), want failed + advanced", failed, advanced, err)
	}
	// A terminal failed order is never flipped to paid by a later callback.
	after, advanced2, err := s.MarkOrderPaid(ctx, order.ID, "wx-tx-late", now)
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
	s, ctx := liveStore(t)
	if _, _, err := s.MarkOrderPaid(ctx, 999999, "x", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown order err = %v, want ErrNotFound", err)
	}
}

func TestLicenseBindingsByUserReturnsOnlyOwnData(t *testing.T) {
	s, ctx := liveStore(t)
	now := time.Now()

	buyerA, licA := seedLicense(t, s, ctx, now)
	buyerB, licB := seedLicense(t, s, ctx, now)

	// Bind buyer A's license so it has a non-nil binding.
	res, err := s.BindInstallation(ctx, licA.LicenseKey, "inst-A", now, func() string { return "tok-A" })
	if err != nil {
		t.Fatalf("bind A: %v", err)
	}
	if res.AliveToken == "" {
		t.Fatal("bind should return an alive token")
	}

	// Buyer A sees one license with binding info.
	bindingsA, err := s.LicenseBindingsByUser(ctx, buyerA)
	if err != nil {
		t.Fatalf("bindings A: %v", err)
	}
	if len(bindingsA) != 1 {
		t.Fatalf("buyer A: want 1 license, got %d", len(bindingsA))
	}
	if bindingsA[0].ID != licA.ID {
		t.Errorf("buyer A: license id = %d, want %d", bindingsA[0].ID, licA.ID)
	}
	if bindingsA[0].AliveInstallID == nil {
		t.Error("buyer A: AliveInstallID should be set (bound to inst-A)")
	} else if *bindingsA[0].AliveInstallID != "inst-A" {
		t.Errorf("buyer A: AliveInstallID = %q, want inst-A", *bindingsA[0].AliveInstallID)
	}
	if bindingsA[0].AliveTime == nil {
		t.Error("buyer A: AliveTime should be set")
	}

	// Buyer B sees one license with no binding (unbound).
	bindingsB, err := s.LicenseBindingsByUser(ctx, buyerB)
	if err != nil {
		t.Fatalf("bindings B: %v", err)
	}
	if len(bindingsB) != 1 {
		t.Fatalf("buyer B: want 1 license, got %d", len(bindingsB))
	}
	if bindingsB[0].ID != licB.ID {
		t.Errorf("buyer B: license id = %d, want %d", bindingsB[0].ID, licB.ID)
	}
	if bindingsB[0].AliveInstallID != nil {
		t.Error("buyer B: unbound license should have nil AliveInstallID")
	}
	if bindingsB[0].AliveTime != nil {
		t.Error("buyer B: unbound license should have nil AliveTime")
	}
}
