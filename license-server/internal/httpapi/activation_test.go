package httpapi

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	lsdb "github.com/sequencestream/code-creative-center/license-server/database"
	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/oauth"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

const devSeed = "K4laQ0bwfnbm7ftsyQ8OseoV2xNkF5QvUTS30KbGPS0="

// testRequestID is a valid 32-char request id (the c3-generated per-round id).
const testRequestID = "rq000000000000000000000000000001"

func TestLicenseBindRejectsNonPOST(t *testing.T) {
	res := do(t, testServer(t), "GET", "/v1/license/bind")
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET bind = %d, want 405", res.StatusCode)
	}
}

func TestLicenseAPIUnavailableWhenUnconfigured(t *testing.T) {
	h := testServer(t) // no OAuth/Store/Signer wired
	// The S2S endpoints report unavailable when the license service is unconfigured.
	hb := postJSON(t, h, "/v1/license/heartbeat", `{"installId":"i","aliveToken":"a"}`)
	if hb.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("heartbeat unconfigured = %d, want 503", hb.StatusCode)
	}
	cb := do(t, h, "GET", "/v1/license/checkbind?installId=i&requestId="+testRequestID)
	if cb.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("checkbind unconfigured = %d, want 503", cb.StatusCode)
	}
	// The browser endpoints are session-gated, so without a sign-in cookie they
	// report unauthenticated (the cookie check runs before the config check).
	bind := postJSON(t, h, "/v1/license/bind", `{"installId":"i","requestId":"`+testRequestID+`","licenseKey":"k"}`)
	if bind.StatusCode != http.StatusUnauthorized {
		t.Errorf("bind unauthenticated = %d, want 401", bind.StatusCode)
	}
	act := do(t, h, "GET", "/v1/license/activate?installId=i&requestId="+testRequestID)
	if act.StatusCode != http.StatusUnauthorized {
		t.Errorf("activate unauthenticated = %d, want 401", act.StatusCode)
	}
}

// --- live end-to-end (skips without C3_LS_TEST_DATABASE_URL) -------------------

type liveEnv struct {
	h     http.Handler
	store *store.Store
	seed  *seeder
	pub   ed25519.PublicKey
	ctx   context.Context
}

func liveServer(t *testing.T, github http.Handler) liveEnv {
	t.Helper()
	dsn := os.Getenv("C3_LS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("C3_LS_TEST_DATABASE_URL not set; skipping live activation test")
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

	stub := httptest.NewServer(github)
	t.Cleanup(stub.Close)

	priv, _, err := token.ParsePrivateKey(devSeed)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	ocl := oauth.New("client", "secret")
	ocl.TokenURL = stub.URL + "/token"
	ocl.UserURL = stub.URL + "/user"

	cfg, _ := config.LoadFrom(func(string) string { return "" })
	cfg.PublicURL = "http://ls.test"

	st := store.New(db)
	sd := newSeeder(st)
	// Seed a trial plan for the checkout/renewal flows; the default license issued
	// at sign-in no longer references a plan (plan lives on the order).
	if err := sd.SeedPlans(ctx, []plans.Record{
		{PlanKey: "trial-1m", Name: "Trial", DurationMonths: 1, PriceCents: 0, Currency: "CNY", SortOrder: 0, IsTrial: true},
	}); err != nil {
		t.Fatalf("seed trial plan: %v", err)
	}
	h := NewServer(Deps{
		Config: cfg,
		Caches: cache.NewRegistry(cfg.LRUSize),
		DB:     db,
		Static: fstest.MapFS{"index.html": {Data: []byte("spa")}},
		OAuth:  ocl,
		Store:  st,
		Signer: priv,
	})
	return liveEnv{h: h, store: st, seed: sd, pub: priv.Public().(ed25519.PublicKey), ctx: ctx}
}

func githubOK() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/token":
			_, _ = w.Write([]byte(`{"access_token":"gho_ok"}`))
		case "/user":
			_, _ = w.Write([]byte(`{"id":4242,"login":"octocat","email":"octo@example.com"}`))
		default:
			http.NotFound(w, r)
		}
	})
}

func postForm(t *testing.T, h http.Handler, target string, form url.Values) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", target, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(rec, req)
	return rec.Result()
}

// stateFromAuthorizeRedirect pulls the OAuth state out of the GitHub authorize
// URL the login step redirects to.
func stateFromAuthorizeRedirect(t *testing.T, location string) string {
	t.Helper()
	u, err := url.Parse(location)
	if err != nil {
		t.Fatalf("parse authorize redirect: %v", err)
	}
	state := u.Query().Get("state")
	if state == "" {
		t.Fatalf("no state in authorize redirect %q", location)
	}
	return state
}

func TestGitHubLoginProvisionsDefaultLicense(t *testing.T) {
	env := liveServer(t, githubOK())

	// 1) Login (no agreement) → redirect to GitHub authorize with a signed state.
	acc := postForm(t, env.h, "/v1/auth/login", url.Values{"installId": {"inst-1"}, "requestId": {testRequestID}})
	if acc.StatusCode != http.StatusSeeOther {
		t.Fatalf("login = %d, want 303", acc.StatusCode)
	}
	state := stateFromAuthorizeRedirect(t, acc.Header.Get("Location"))

	// 2) GitHub redirects back → upsert user, ensure a default license, set
	// session, redirect to the SPA carrying the binding round.
	cb := do(t, env.h, "GET", "/v1/auth/github/callback?code=the-code&state="+url.QueryEscape(state))
	if cb.StatusCode != http.StatusSeeOther {
		t.Fatalf("callback = %d, want 303", cb.StatusCode)
	}
	if loc := cb.Header.Get("Location"); !strings.Contains(loc, "installId=inst-1") || !strings.Contains(loc, "requestId="+testRequestID) {
		t.Errorf("callback redirect = %q, want the binding round preserved", loc)
	}

	// The user now owns exactly one default license.
	userID, err := env.seed.UpsertUser(env.ctx, 4242, "octocat", "octo@example.com")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	licenses, err := env.seed.ListLicensesByUser(env.ctx, userID)
	if err != nil {
		t.Fatalf("list licenses: %v", err)
	}
	if len(licenses) != 1 || licenses[0].LicenseKey == "" {
		t.Fatalf("expected one keyed default license, got %+v", licenses)
	}
}

func TestCallbackRejectsForgedState(t *testing.T) {
	env := liveServer(t, githubOK())
	cb := do(t, env.h, "GET", "/v1/auth/github/callback?code=x&state=forged.nonce")
	// A bad state is bounced back to the SPA with an error, not completed.
	if cb.StatusCode != http.StatusSeeOther {
		t.Fatalf("forged state = %d, want 303", cb.StatusCode)
	}
	if loc := cb.Header.Get("Location"); !strings.Contains(loc, "error=") {
		t.Errorf("forged-state redirect = %q, want an error", loc)
	}
}

func TestBindCheckbindAndHeartbeatHappyPath(t *testing.T) {
	env := liveServer(t, githubOK())
	const installID = "inst-happy"

	userID, err := env.seed.UpsertUser(env.ctx, 99, "user", "b@example.com")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	lic, _, err := env.seed.EnsureLicenseForUser(env.ctx, userID, 30, time.Now(), func() string { return "license-key-xyz" })
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}
	cookie := accountCookie(t, userID)

	// Bind (browser/session): returns only {status, termEnd} — no alive token.
	bindBody := postJSONCookie(t, env.h, "/v1/license/bind",
		`{"installId":"`+installID+`","requestId":"`+testRequestID+`","licenseKey":"`+lic.LicenseKey+`"}`, cookie)
	var bindGot struct {
		Status     string `json:"status"`
		TermEnd    int64  `json:"termEnd"`
		AliveToken string `json:"aliveToken"`
	}
	if err := json.Unmarshal(bindBody, &bindGot); err != nil {
		t.Fatalf("decode bind: %v", err)
	}
	if bindGot.Status != "active" || bindGot.TermEnd <= 0 {
		t.Fatalf("bind payload = %+v", bindGot)
	}
	if bindGot.AliveToken != "" {
		t.Error("bind response must NOT carry the alive token (PL-R2)")
	}
	assertNoPlanField(t, "bind", bindBody)

	// Checkbind (c3 server S2S): collects the alive token + signed entitlement.
	cbRes := do(t, env.h, "GET", "/v1/license/checkbind?installId="+installID+"&requestId="+testRequestID)
	cbBody, _ := io.ReadAll(cbRes.Body)
	var cbGot struct {
		Status           string `json:"status"`
		AliveToken       string `json:"aliveToken"`
		EntitlementToken string `json:"entitlementToken"`
		TermEnd          int64  `json:"termEnd"`
	}
	if err := json.Unmarshal(cbBody, &cbGot); err != nil {
		t.Fatalf("decode checkbind: %v", err)
	}
	if cbGot.Status != "active" || cbGot.AliveToken == "" || cbGot.EntitlementToken == "" {
		t.Fatalf("checkbind payload = %+v", cbGot)
	}
	payload, err := token.Verify(env.pub, cbGot.EntitlementToken, time.Now())
	if err != nil {
		t.Fatalf("entitlement token does not verify: %v", err)
	}
	if payload.InstallationID != installID {
		t.Errorf("token installation = %q", payload.InstallationID)
	}

	// A second checkbind for the same round is consumed → pending.
	again := do(t, env.h, "GET", "/v1/license/checkbind?installId="+installID+"&requestId="+testRequestID)
	var againGot struct {
		Status string `json:"status"`
	}
	_ = json.NewDecoder(again.Body).Decode(&againGot)
	if againGot.Status != "pending" {
		t.Errorf("re-checkbind status = %q, want pending (consumed once)", againGot.Status)
	}

	// Heartbeat (S2S) with the collected alive token → active + a refreshed token.
	hbBody := postJSON(t, env.h, "/v1/license/heartbeat",
		`{"installId":"`+installID+`","aliveToken":"`+cbGot.AliveToken+`"}`)
	hb, _ := io.ReadAll(hbBody.Body)
	var hbGot struct {
		Status           string `json:"status"`
		EntitlementToken string `json:"entitlementToken"`
	}
	if err := json.Unmarshal(hb, &hbGot); err != nil {
		t.Fatalf("decode heartbeat: %v", err)
	}
	if hbGot.Status != "active" || hbGot.EntitlementToken == "" {
		t.Fatalf("heartbeat payload = %+v", hbGot)
	}
	assertNoPlanField(t, "heartbeat", hb)

	// A heartbeat from a different installation (same token) is disabled.
	other := postJSON(t, env.h, "/v1/license/heartbeat",
		`{"installId":"other","aliveToken":"`+cbGot.AliveToken+`"}`)
	var otherGot struct {
		Status string `json:"status"`
	}
	_ = json.NewDecoder(other.Body).Decode(&otherGot)
	if otherGot.Status != "disabled" {
		t.Errorf("other installation heartbeat status = %q, want disabled", otherGot.Status)
	}
}

func TestBindRejectsUnknownKey(t *testing.T) {
	env := liveServer(t, githubOK())
	userID, err := env.seed.UpsertUser(env.ctx, 7, "user", "b@example.com")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	if _, _, err := env.seed.EnsureLicenseForUser(env.ctx, userID, 30, time.Now(), func() string { return "owned-key" }); err != nil {
		t.Fatalf("ensure license: %v", err)
	}
	cookie := accountCookie(t, userID)
	// A licenseKey the user does not own is rejected as not found.
	res := postJSONCookieRes(t, env.h, "/v1/license/bind",
		`{"installId":"i","requestId":"`+testRequestID+`","licenseKey":"not-mine"}`, cookie)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("bind unknown key = %d, want 404", res.StatusCode)
	}
}

// assertNoPlanField fails if the JSON body carries a top-level "plan" key (the
// bind/active-heartbeat contract is plan-free, PL-R1).
func assertNoPlanField(t *testing.T, what string, body []byte) {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode %s body as map: %v", what, err)
	}
	if _, ok := m["plan"]; ok {
		t.Errorf("%s response carries a plan field; contract is plan-free (PL-R1): %s", what, body)
	}
}

func postJSON(t *testing.T, h http.Handler, target, body string) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	return rec.Result()
}

// postJSONCookie posts JSON with a session cookie and returns the body bytes.
func postJSONCookie(t *testing.T, h http.Handler, target, body string, cookie *http.Cookie) []byte {
	t.Helper()
	res := postJSONCookieRes(t, h, target, body, cookie)
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("POST %s = %d; body=%s", target, res.StatusCode, b)
	}
	return b
}

func postJSONCookieRes(t *testing.T, h http.Handler, target, body string, cookie *http.Cookie) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	h.ServeHTTP(rec, req)
	return rec.Result()
}
