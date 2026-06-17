package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

// testKeyGen returns a deterministic key generator for tests.
func testKeyGen(prefix string) func() string {
	n := 0
	return func() string {
		n++
		return prefix + "-" + itoa(n)
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

// --- unit (no database) -----------------------------------------------------

func TestAccountRedirectsToActivateWhenNotLoggedIn(t *testing.T) {
	h, _ := signedServer(t)
	res := do(t, h, "GET", "/account")
	if res.StatusCode != http.StatusSeeOther {
		t.Fatalf("GET /account unauthenticated = %d, want 303", res.StatusCode)
	}
	if loc := res.Header.Get("Location"); loc != "/activate" {
		t.Errorf("redirect = %q, want /activate", loc)
	}
}

// --- live (DB-gated) --------------------------------------------------------

// accountCookie mints a signed session cookie for an arbitrary buyer during live
// tests. The signer is reconstructed from devSeed (the same seed used by
// liveServer), so the cookie is valid against the live server's session handler.
func accountCookie(t *testing.T, userID int64) *http.Cookie {
	t.Helper()
	priv, _, err := token.ParsePrivateKey(devSeed)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return sessionCookie(priv, userID)
}

func TestAccountLiveDataIsolation(t *testing.T) {
	env := liveServer(t, githubOK())

	seedPlans := []store.Plan{
		{PlanKey: "trial-1m", Name: "Trial", DurationMonths: 1, PriceCents: 0, Currency: "CNY", SortOrder: 0, IsTrial: true},
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}
	if err := env.store.SeedPlans(env.ctx, seedPlans); err != nil {
		t.Fatalf("seed plans: %v", err)
	}

	buyerA, err := env.store.UpsertBuyer(env.ctx, 1001, "alice", "alice@example.com")
	if err != nil {
		t.Fatalf("upsert buyer A: %v", err)
	}
	buyerB, err := env.store.UpsertBuyer(env.ctx, 1002, "bob", "bob@example.com")
	if err != nil {
		t.Fatalf("upsert buyer B: %v", err)
	}

	now := time.Now()
	licA, _, err := env.store.EnsureLicenseForBuyer(env.ctx, buyerA, "trial-1m", 30, now, testKeyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license A: %v", err)
	}
	licB, _, err := env.store.EnsureLicenseForBuyer(env.ctx, buyerB, "trial-1m", 30, now, testKeyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license B: %v", err)
	}

	// Buyer A has an order; buyer B doesn't.
	_, err = env.store.CreateOrder(env.ctx, store.CreateOrderInput{
		UserID:              buyerA,
		LicenseID:           licA.ID,
		PlanKey:             "6m",
		AgreementVersion:    "v1",
		AgreementAcceptedAt: now,
	})
	if err != nil {
		t.Fatalf("create order A: %v", err)
	}

	// Bind buyer A's license.
	if _, err := env.store.BindInstallation(env.ctx, licA.LicenseKey, "inst-alice", now, func() string { return "tok-alice" }); err != nil {
		t.Fatalf("bind A: %v", err)
	}

	// Helper: GET /account as a buyer and return the HTML body.
	accountHTML := func(t *testing.T, userID int64) string {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/account", nil)
		req.AddCookie(accountCookie(t, userID))
		env.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /account user %d = %d, want 200; body=%s", userID, rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}

	t.Run("alice sees her own license, order, and binding", func(t *testing.T) {
		body := accountHTML(t, buyerA)
		if !strings.Contains(body, licA.LicenseKey) {
			t.Error("alice should see her own license key")
		}
		if !strings.Contains(body, "6m") {
			t.Error("alice should see her order plan")
		}
		if !strings.Contains(body, "inst-alice") {
			t.Error("alice should see her binding install id")
		}
	})

	t.Run("bob sees his license but no order and no binding", func(t *testing.T) {
		body := accountHTML(t, buyerB)
		if !strings.Contains(body, licB.LicenseKey) {
			t.Error("bob should see his own license key")
		}
		if !strings.Contains(body, "暂无订单") {
			t.Error("bob should see 'no orders' placeholder since he has no orders")
		}
		if strings.Contains(body, licA.LicenseKey) {
			t.Error("bob must NOT see alice's license key")
		}
	})

	t.Run("buyers cannot see each other's data", func(t *testing.T) {
		aliceHTML := accountHTML(t, buyerA)
		bobHTML := accountHTML(t, buyerB)
		if strings.Contains(aliceHTML, licB.LicenseKey) {
			t.Error("alice must NOT see bob's license key")
		}
		if strings.Contains(bobHTML, licA.LicenseKey) {
			t.Error("bob must NOT see alice's license key")
		}
	})
}

func TestAccountDoesNotLeakAliveToken(t *testing.T) {
	env := liveServer(t, githubOK())
	if err := env.store.SeedPlans(env.ctx, []store.Plan{
		{PlanKey: "trial-1m", Name: "Trial", DurationMonths: 1, PriceCents: 0, Currency: "CNY", SortOrder: 0, IsTrial: true},
	}); err != nil {
		t.Fatalf("seed plans: %v", err)
	}
	buyer, err := env.store.UpsertBuyer(env.ctx, 2001, "test", "test@example.com")
	if err != nil {
		t.Fatalf("upsert buyer: %v", err)
	}
	lic, _, err := env.store.EnsureLicenseForBuyer(env.ctx, buyer, "trial-1m", 30, time.Now(), testKeyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}

	// Bind with a known plaintext token.
	tokenPlain := "super-secret-alive-token"
	if _, err := env.store.BindInstallation(env.ctx, lic.LicenseKey, "inst-test", time.Now(), func() string { return tokenPlain }); err != nil {
		t.Fatalf("bind: %v", err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/account", nil)
	req.AddCookie(accountCookie(t, buyer))
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /account = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, tokenPlain) {
		t.Error("account page must NOT leak the plaintext alive token")
	}
	if strings.Contains(body, store.HashCode(tokenPlain)) {
		t.Error("account page must NOT leak the alive token hash either")
	}
}
