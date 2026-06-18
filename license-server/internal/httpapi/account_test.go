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

func TestLicensesRequireLogin(t *testing.T) {
	h, _ := signedServer(t)
	if res := do(t, h, "GET", "/v1/licenses"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /v1/licenses unauthenticated = %d, want 401", res.StatusCode)
	}
	if res := do(t, h, "GET", "/v1/orders"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("GET /v1/orders unauthenticated = %d, want 401", res.StatusCode)
	}
}

// --- live (DB-gated) --------------------------------------------------------

// accountCookie mints a signed session cookie for an arbitrary user during live
// tests, valid against the live server (same devSeed signer).
func accountCookie(t *testing.T, userID int64) *http.Cookie {
	t.Helper()
	priv, _, err := token.ParsePrivateKey(devSeed)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	return sessionCookie(priv, userID)
}

// getJSON GETs target as the given user and returns the response body.
func getJSON(t *testing.T, h http.Handler, target string, userID int64) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", target, nil)
	req.AddCookie(accountCookie(t, userID))
	h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

func TestAccountLiveDataIsolation(t *testing.T) {
	env := liveServer(t, githubOK())

	if err := env.store.SeedPlans(env.ctx, []store.Plan{
		{PlanKey: "trial-1m", Name: "Trial", DurationMonths: 1, PriceCents: 0, Currency: "CNY", SortOrder: 0, IsTrial: true},
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plans: %v", err)
	}

	userA, _ := env.store.UpsertUser(env.ctx, 1001, "alice", "alice@example.com")
	userB, _ := env.store.UpsertUser(env.ctx, 1002, "bob", "bob@example.com")

	now := time.Now()
	licA, _, err := env.store.EnsureLicenseForUser(env.ctx, userA, 30, now, testKeyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license A: %v", err)
	}
	licB, _, err := env.store.EnsureLicenseForUser(env.ctx, userB, 30, now, testKeyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license B: %v", err)
	}

	// User A has a PAID order (paid orders are what /v1/orders lists); bob has none.
	order, err := env.store.CreateOrder(env.ctx, store.CreateOrderInput{
		UserID: userA, LicenseID: licA.ID, PlanKey: "6m",
		AgreementVersion: "v1", AgreementAcceptedAt: now,
	}, func() string { return store.NewOrderNo(time.Now()) })
	if err != nil {
		t.Fatalf("create order A: %v", err)
	}
	if _, _, err := env.store.MarkOrderPaid(env.ctx, order.OrderNo, "wx-tx-A", now); err != nil {
		t.Fatalf("mark paid A: %v", err)
	}

	// Bind user A's license so it carries a binding install id.
	if _, err := env.store.BindInstallation(env.ctx, licA.LicenseKey, "inst-alice", now, func() string { return "tok-alice" }); err != nil {
		t.Fatalf("bind A: %v", err)
	}

	t.Run("alice sees her own license, binding, and paid order", func(t *testing.T) {
		code, lic := getJSON(t, env.h, "/v1/licenses", userA)
		if code != http.StatusOK || !strings.Contains(lic, licA.LicenseKey) || !strings.Contains(lic, "inst-alice") {
			t.Errorf("alice /v1/licenses = %d %s", code, lic)
		}
		_, ord := getJSON(t, env.h, "/v1/orders", userA)
		if !strings.Contains(ord, "6m") || !strings.Contains(ord, order.OrderNo) {
			t.Errorf("alice /v1/orders should list her paid order: %s", ord)
		}
	})

	t.Run("bob sees his license but no order, and not alice's data", func(t *testing.T) {
		_, lic := getJSON(t, env.h, "/v1/licenses", userB)
		if !strings.Contains(lic, licB.LicenseKey) || strings.Contains(lic, licA.LicenseKey) {
			t.Errorf("bob /v1/licenses leak/missing: %s", lic)
		}
		_, ord := getJSON(t, env.h, "/v1/orders", userB)
		if strings.Contains(ord, order.OrderNo) {
			t.Errorf("bob must not see alice's order: %s", ord)
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
	user, _ := env.store.UpsertUser(env.ctx, 2001, "test", "test@example.com")
	lic, _, err := env.store.EnsureLicenseForUser(env.ctx, user, 30, time.Now(), testKeyGen("lk"))
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}

	tokenPlain := "super-secret-alive-token"
	if _, err := env.store.BindInstallation(env.ctx, lic.LicenseKey, "inst-test", time.Now(), func() string { return tokenPlain }); err != nil {
		t.Fatalf("bind: %v", err)
	}

	code, body := getJSON(t, env.h, "/v1/licenses", user)
	if code != http.StatusOK {
		t.Fatalf("GET /v1/licenses = %d; body=%s", code, body)
	}
	if strings.Contains(body, tokenPlain) {
		t.Error("licenses response must NOT leak the plaintext alive token")
	}
	if strings.Contains(body, store.HashCode(tokenPlain)) {
		t.Error("licenses response must NOT leak the alive token hash either")
	}
}
