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
	lic, issued, err := s.EnsureLicenseForBuyer(ctx, buyerID, 1, 30, now, keys)
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

	again, issued, err := s.EnsureLicenseForBuyer(ctx, buyerID, 1, 30, now, keyGen("lk2"))
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

func TestSeedAndListPlans(t *testing.T) {
	s, ctx := liveStore(t)

	seed := []Plan{
		{PlanID: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0},
		{PlanID: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
		{PlanID: "1y", Name: "1 Year", DurationMonths: 12, PriceCents: 1090, Currency: "CNY", SortOrder: 2},
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
	bumped := []Plan{{PlanID: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 999, Currency: "CNY", SortOrder: 0}}
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
