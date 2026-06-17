package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

// signedServer builds a server with a real Signer but no database, so the
// session-gated checkout routes can run their cookie checks without a live DB.
func signedServer(t *testing.T) (http.Handler, Signer) {
	t.Helper()
	priv, _, err := token.ParsePrivateKey(devSeed)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	cfg, _ := config.LoadFrom(func(string) string { return "" })
	h := NewServer(Deps{
		Config: cfg,
		Caches: cache.NewRegistry(cfg.LRUSize),
		Store:  store.New(nil),
		Static: fstest.MapFS{"index.html": {Data: []byte("spa")}},
		Signer: priv,
	})
	return h, priv
}

// sessionCookie mints a valid sign-in cookie for the given buyer using the test
// signing key, so checkout tests can act as a logged-in buyer.
func sessionCookie(signer Signer, userID int64) *http.Cookie {
	return &http.Cookie{
		Name:  sessionCookieName,
		Value: signSession(signer, session{UserID: userID, Login: "buyer", IssuedAt: time.Now().Unix()}),
	}
}

func TestCheckoutRequiresLogin(t *testing.T) {
	h, _ := signedServer(t)
	res := do(t, h, "GET", "/checkout")
	if res.StatusCode != http.StatusSeeOther {
		t.Fatalf("GET /checkout unauthenticated = %d, want 303", res.StatusCode)
	}
	if loc := res.Header.Get("Location"); loc != "/activate" {
		t.Errorf("redirect = %q, want /activate", loc)
	}
}

func TestCheckoutPostRejectsWithoutAgreement(t *testing.T) {
	h, signer := signedServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/checkout", strings.NewReader(url.Values{"plan": {"1m"}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(sessionCookie(signer, 1))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("POST without agreement = %d, want 400", rec.Code)
	}
}

func TestSessionCookieRejectsTamper(t *testing.T) {
	_, signer := signedServer(t)
	good := signSession(signer, session{UserID: 7, Login: "x", IssuedAt: time.Now().Unix()})
	if _, ok := parseSession(signer, good); !ok {
		t.Fatal("freshly signed cookie should verify")
	}
	if _, ok := parseSession(signer, good+"x"); ok {
		t.Error("tampered signature should not verify")
	}
	if _, ok := parseSession(signer, "garbage"); ok {
		t.Error("malformed cookie should not verify")
	}
}

// --- live (DB-gated) ---------------------------------------------------------

// loginCookie runs the GitHub sign-in flow and returns the session cookie the
// callback set, so the live checkout test acts as the signed-in buyer.
func loginCookie(t *testing.T, env liveEnv) *http.Cookie {
	t.Helper()
	acc := postForm(t, env.h, "/activate/accept", url.Values{"accept": {"on"}})
	state := stateFromAuthorizeRedirect(t, acc.Header.Get("Location"))
	cb := do(t, env.h, "GET", "/auth/github/callback?code=the-code&state="+url.QueryEscape(state))
	for _, c := range cb.Cookies() {
		if c.Name == sessionCookieName {
			return c
		}
	}
	t.Fatal("callback did not set a session cookie")
	return nil
}

func TestCheckoutCreatesPendingOrderWithDerivedAmount(t *testing.T) {
	env := liveServer(t, githubOK())
	// A purchasable (non-trial) plan to renew into.
	if err := env.store.SeedPlans(env.ctx, []store.Plan{
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}

	cookie := loginCookie(t, env)
	buyerID, err := env.store.UpsertBuyer(env.ctx, 4242, "octocat", "octo@example.com")
	if err != nil {
		t.Fatalf("upsert buyer: %v", err)
	}
	licenses, err := env.store.ListLicensesByBuyer(env.ctx, buyerID)
	if err != nil || len(licenses) == 0 {
		t.Fatalf("buyer should own a trial license: err=%v licenses=%+v", err, licenses)
	}
	licenseID := licenses[0].ID

	// GET renders the checkout page with the plan listed.
	getRec := httptest.NewRecorder()
	getReq := httptest.NewRequest("GET", "/checkout", nil)
	getReq.AddCookie(cookie)
	env.h.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("GET /checkout = %d, want 200", getRec.Code)
	}
	if !strings.Contains(getRec.Body.String(), "6 Months") {
		t.Errorf("checkout page missing the plan name")
	}

	// POST with a bogus client amount — it must be ignored; the server derives
	// the amount from the plan (590).
	form := url.Values{
		"plan":        {"6m"},
		"licenseId":   {strconv.FormatInt(licenseID, 10)},
		"accept":      {"on"},
		"amountCents": {"1"}, // attacker-supplied amount; must be ignored
	}
	postRec := httptest.NewRecorder()
	postReq := httptest.NewRequest("POST", "/checkout", strings.NewReader(form.Encode()))
	postReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	postReq.AddCookie(cookie)
	env.h.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusOK {
		t.Fatalf("POST /checkout = %d, want 200; body=%s", postRec.Code, postRec.Body.String())
	}

	orders, err := env.store.OrdersByUser(env.ctx, buyerID)
	if err != nil {
		t.Fatalf("orders by user: %v", err)
	}
	if len(orders) != 1 {
		t.Fatalf("want exactly one order, got %d", len(orders))
	}
	o := orders[0]
	if o.AmountCents != 590 || o.Currency != "CNY" {
		t.Errorf("order amount = %d %s, want 590 CNY (client amount must be ignored)", o.AmountCents, o.Currency)
	}
	if o.Status != "pending" {
		t.Errorf("order status = %q, want pending", o.Status)
	}
	if o.LicenseID != licenseID || o.PlanKey != "6m" {
		t.Errorf("order linkage = license %d plan %q, want %d 6m", o.LicenseID, o.PlanKey, licenseID)
	}
	if o.AgreementVersion == "" || o.AgreementAcceptedAt.IsZero() {
		t.Errorf("agreement not recorded on order: %+v", o)
	}
}

func TestCheckoutRejectsForeignLicense(t *testing.T) {
	env := liveServer(t, githubOK())
	if err := env.store.SeedPlans(env.ctx, []store.Plan{
		{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0},
	}); err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	cookie := loginCookie(t, env)
	// A license id the buyer does not own.
	form := url.Values{"plan": {"1m"}, "licenseId": {"999999"}, "accept": {"on"}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/checkout", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(cookie)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("foreign license = %d, want 400", rec.Code)
	}
}
