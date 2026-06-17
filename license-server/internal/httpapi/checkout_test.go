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

// sessionCookie mints a valid sign-in cookie for the given user using the test
// signing key, so checkout tests can act as a logged-in user.
func sessionCookie(signer Signer, userID int64) *http.Cookie {
	return &http.Cookie{
		Name:  sessionCookieName,
		Value: signSession(signer, session{UserID: userID, Login: "user", IssuedAt: time.Now().Unix()}),
	}
}

func TestCheckoutRequiresLogin(t *testing.T) {
	h, _ := signedServer(t)
	res := postJSON(t, h, "/v1/checkout", `{"planKey":"1m","licenseId":1,"accept":true}`)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("POST /v1/checkout unauthenticated = %d, want 401", res.StatusCode)
	}
}

func TestCheckoutPostRejectsWithoutAgreement(t *testing.T) {
	h, signer := signedServer(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/checkout", strings.NewReader(`{"planKey":"1m","licenseId":1,"accept":false}`))
	req.Header.Set("Content-Type", "application/json")
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
// callback set, so the live checkout test acts as the signed-in user.
func loginCookie(t *testing.T, env liveEnv) *http.Cookie {
	t.Helper()
	acc := postForm(t, env.h, "/v1/auth/login", url.Values{})
	state := stateFromAuthorizeRedirect(t, acc.Header.Get("Location"))
	cb := do(t, env.h, "GET", "/v1/auth/github/callback?code=the-code&state="+url.QueryEscape(state))
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
	userID, err := env.store.UpsertUser(env.ctx, 4242, "octocat", "octo@example.com")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	licenses, err := env.store.ListLicensesByUser(env.ctx, userID)
	if err != nil || len(licenses) == 0 {
		t.Fatalf("user should own a trial license: err=%v licenses=%+v", err, licenses)
	}
	licenseID := licenses[0].ID

	// POST with a bogus client amount — it must be ignored; the server derives
	// the amount from the plan (590).
	body := `{"planKey":"6m","licenseId":` + strconv.FormatInt(licenseID, 10) + `,"accept":true,"amountCents":1}`
	postRec := httptest.NewRecorder()
	postReq := httptest.NewRequest("POST", "/v1/checkout", strings.NewReader(body))
	postReq.Header.Set("Content-Type", "application/json")
	postReq.AddCookie(cookie)
	env.h.ServeHTTP(postRec, postReq)
	if postRec.Code != http.StatusOK {
		t.Fatalf("POST /v1/checkout = %d, want 200; body=%s", postRec.Code, postRec.Body.String())
	}

	orders, err := env.store.OrdersByUser(env.ctx, userID)
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
	// A license id the user does not own.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/checkout", strings.NewReader(`{"planKey":"1m","licenseId":999999,"accept":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("foreign license = %d, want 400", rec.Code)
	}
}
