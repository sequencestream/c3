package licenses

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	lsdb "github.com/sequencestream/code-creative-center/license-server/database"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
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

// liveRepo connects to C3_LS_TEST_DATABASE_URL, migrates, and truncates the LS
// tables so each test starts clean. Skips when no DB is configured. Returns the
// license repository plus the raw store handle (for direct-SQL assertions).
func liveRepo(t *testing.T) (*Repo, *store.Store, context.Context) {
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
	return NewRepo(st), st, ctx
}

// seedUserSeq gives each seedLicense call a distinct GitHub identity, so a test
// that seeds two "users" gets two real accounts (not one collapsed by a shared
// github_id).
var seedUserSeq int64

// seedUser inserts a fresh GitHub identity directly (the licenses package cannot
// import users — users depends on licenses) and returns its id.
func seedUser(t *testing.T, st *store.Store, ctx context.Context) int64 {
	t.Helper()
	seedUserSeq++
	var id int64
	err := st.DB().WithContext(ctx).Raw(`
		INSERT INTO c3_ls_user (github_id, github_login, email)
		VALUES ($1, $2, $3) RETURNING id`,
		700+seedUserSeq, "octocat-"+itoa(int(seedUserSeq)), "octo@example.com").Scan(&id).Error
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return id
}

// seedLicense registers a fresh user and issues them a license, returning its key.
func seedLicense(t *testing.T, r *Repo, st *store.Store, ctx context.Context, now time.Time) (int64, License) {
	t.Helper()
	userID := seedUser(t, st, ctx)
	lic, issued, err := r.EnsureForUser(ctx, userID, 30, now, keyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}
	if !issued {
		t.Fatal("first ensure should issue a new license")
	}
	if lic.LicenseKey == "" {
		t.Fatal("issued license must carry a key")
	}
	return userID, lic
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
	r, st, ctx := liveRepo(t)
	now := time.Now()
	userID, lic := seedLicense(t, r, st, ctx, now)

	again, issued, err := r.EnsureForUser(ctx, userID, 30, now, keyGen("lk2"))
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
	r, st, ctx := liveRepo(t)
	now := time.Now()
	_, lic := seedLicense(t, r, st, ctx, now)

	res, err := r.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "alive-plain" })
	if err != nil {
		t.Fatalf("bind: %v", err)
	}
	if res.AliveToken != "alive-plain" {
		t.Errorf("bind should return the plaintext alive token, got %q", res.AliveToken)
	}

	// The alive token is stored only as a hash (PL-R2).
	var stored string
	if err := st.DB().WithContext(ctx).Raw(
		`SELECT alive_token FROM c3_ls_license WHERE id=$1`, lic.ID).Scan(&stored).Error; err != nil {
		t.Fatalf("read alive hash: %v", err)
	}
	if stored != HashCode("alive-plain") || stored == "alive-plain" {
		t.Errorf("alive token must be stored hashed, got %q", stored)
	}

	hb, err := r.HeartbeatByInstall(ctx, "inst-1", "alive-plain", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if hb.Status != HeartbeatActive {
		t.Errorf("heartbeat status = %q, want active", hb.Status)
	}
}

func TestBindIsExclusiveAndDisablesPrevious(t *testing.T) {
	r, st, ctx := liveRepo(t)
	now := time.Now()
	_, lic := seedLicense(t, r, st, ctx, now)

	a, err := r.BindInstallation(ctx, lic.LicenseKey, "inst-A", now, func() string { return "alive-A" })
	if err != nil {
		t.Fatalf("bind A: %v", err)
	}
	// Rebinding to a different installation displaces the first.
	if _, err := r.BindInstallation(ctx, lic.LicenseKey, "inst-B", now, func() string { return "alive-B" }); err != nil {
		t.Fatalf("bind B: %v", err)
	}

	// inst-A's heartbeat now reports disabled (license moved).
	hbA, err := r.HeartbeatByInstall(ctx, "inst-A", a.AliveToken, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("heartbeat A: %v", err)
	}
	if hbA.Status != HeartbeatDisabled {
		t.Errorf("displaced installation status = %q, want disabled", hbA.Status)
	}

	// inst-B's heartbeat is active.
	hbB, err := r.HeartbeatByInstall(ctx, "inst-B", "alive-B", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("heartbeat B: %v", err)
	}
	if hbB.Status != HeartbeatActive {
		t.Errorf("current installation status = %q, want active", hbB.Status)
	}
}

func TestHeartbeatRejectsStaleAliveToken(t *testing.T) {
	r, st, ctx := liveRepo(t)
	now := time.Now()
	_, lic := seedLicense(t, r, st, ctx, now)
	if _, err := r.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "alive-1" }); err != nil {
		t.Fatalf("bind: %v", err)
	}
	// Same install, but a superseded/forged alive token ⇒ disabled.
	hb, err := r.HeartbeatByInstall(ctx, "inst-1", "wrong-token", now)
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if hb.Status != HeartbeatDisabled {
		t.Errorf("stale token status = %q, want disabled", hb.Status)
	}
}

func TestBindRejectsUnknownKey(t *testing.T) {
	r, _, ctx := liveRepo(t)
	if _, err := r.BindInstallation(ctx, "no-such-key", "inst-1", time.Now(), func() string { return "x" }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bind unknown key err = %v, want ErrNotFound", err)
	}
	// Heartbeat carries no license key: an alive token matching no live binding
	// gates the installation (disabled), it does not error.
	hb, err := r.HeartbeatByInstall(ctx, "inst-1", "no-such-token", time.Now())
	if err != nil {
		t.Fatalf("heartbeat unknown token err = %v, want nil", err)
	}
	if hb.Status != HeartbeatDisabled {
		t.Fatalf("heartbeat unknown token status = %q, want disabled", hb.Status)
	}
}

func TestHeartbeatReportsExpired(t *testing.T) {
	r, st, ctx := liveRepo(t)
	now := time.Now()
	_, lic := seedLicense(t, r, st, ctx, now)
	if _, err := r.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "alive" }); err != nil {
		t.Fatalf("bind: %v", err)
	}

	// Admin force-expire (status='expired', term still in the future) → heartbeat
	// reports expired, and a fresh bind is rejected.
	if err := st.DB().WithContext(ctx).Exec(`UPDATE c3_ls_license SET status='expired' WHERE id=$1`, lic.ID).Error; err != nil {
		t.Fatalf("force-expire: %v", err)
	}
	hb, _ := r.HeartbeatByInstall(ctx, "inst-1", "alive", now)
	if hb.Status != HeartbeatExpired {
		t.Errorf("force-expired heartbeat status = %q", hb.Status)
	}
	if _, err := r.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "x" }); !errors.Is(err, ErrExpired) {
		t.Errorf("bind of force-expired license err = %v, want ErrExpired", err)
	}

	// Lapsed term (status active, term_end in the past) → heartbeat reports expired.
	if err := st.DB().WithContext(ctx).Exec(
		`UPDATE c3_ls_license SET status='active', term_end=$2 WHERE id=$1`, lic.ID, now.Add(-time.Hour)).Error; err != nil {
		t.Fatalf("expire term: %v", err)
	}
	hb, _ = r.HeartbeatByInstall(ctx, "inst-1", "alive", now)
	if hb.Status != HeartbeatExpired {
		t.Errorf("expired heartbeat status = %q", hb.Status)
	}
	if _, err := r.BindInstallation(ctx, lic.LicenseKey, "inst-1", now, func() string { return "x" }); !errors.Is(err, ErrExpired) {
		t.Errorf("bind of expired license err = %v, want ErrExpired", err)
	}
}

func TestLicenseBindingsByUserReturnsOnlyOwnData(t *testing.T) {
	r, st, ctx := liveRepo(t)
	now := time.Now()

	userA, licA := seedLicense(t, r, st, ctx, now)
	userB, licB := seedLicense(t, r, st, ctx, now)

	// Bind user A's license so it has a non-nil binding.
	res, err := r.BindInstallation(ctx, licA.LicenseKey, "inst-A", now, func() string { return "tok-A" })
	if err != nil {
		t.Fatalf("bind A: %v", err)
	}
	if res.AliveToken == "" {
		t.Fatal("bind should return an alive token")
	}

	// User A sees one license with binding info.
	bindingsA, err := r.BindingsByUser(ctx, userA)
	if err != nil {
		t.Fatalf("bindings A: %v", err)
	}
	if len(bindingsA) != 1 {
		t.Fatalf("user A: want 1 license, got %d", len(bindingsA))
	}
	if bindingsA[0].ID != licA.ID {
		t.Errorf("user A: license id = %d, want %d", bindingsA[0].ID, licA.ID)
	}
	if bindingsA[0].AliveInstallID == nil {
		t.Error("user A: AliveInstallID should be set (bound to inst-A)")
	} else if *bindingsA[0].AliveInstallID != "inst-A" {
		t.Errorf("user A: AliveInstallID = %q, want inst-A", *bindingsA[0].AliveInstallID)
	}
	if bindingsA[0].AliveTime == nil {
		t.Error("user A: AliveTime should be set")
	}

	// User B sees one license with no binding (unbound).
	bindingsB, err := r.BindingsByUser(ctx, userB)
	if err != nil {
		t.Fatalf("bindings B: %v", err)
	}
	if len(bindingsB) != 1 {
		t.Fatalf("user B: want 1 license, got %d", len(bindingsB))
	}
	if bindingsB[0].ID != licB.ID {
		t.Errorf("user B: license id = %d, want %d", bindingsB[0].ID, licB.ID)
	}
	if bindingsB[0].AliveInstallID != nil {
		t.Error("user B: unbound license should have nil AliveInstallID")
	}
	if bindingsB[0].AliveTime != nil {
		t.Error("user B: unbound license should have nil AliveTime")
	}
}
