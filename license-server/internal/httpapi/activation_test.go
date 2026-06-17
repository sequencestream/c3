package httpapi

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
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
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

const devSeed = "K4laQ0bwfnbm7ftsyQ8OseoV2xNkF5QvUTS30KbGPS0="

func TestLicenseBindRejectsNonPOST(t *testing.T) {
	res := do(t, testServer(t), "GET", "/v1/license/bind")
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET bind = %d, want 405", res.StatusCode)
	}
}

func TestLicenseAPIUnavailableWhenUnconfigured(t *testing.T) {
	h := testServer(t) // no OAuth/Store/Signer wired
	bind := postJSON(t, h, "/v1/license/bind", `{"licenseKey":"k","installationId":"i"}`)
	if bind.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("bind unconfigured = %d, want 503", bind.StatusCode)
	}
	hb := postJSON(t, h, "/v1/license/heartbeat", `{"licenseKey":"k","installationId":"i","aliveToken":"a"}`)
	if hb.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("heartbeat unconfigured = %d, want 503", hb.StatusCode)
	}
	page := do(t, h, "GET", "/activate")
	if page.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("GET /activate unconfigured = %d, want 503", page.StatusCode)
	}
}

// --- live end-to-end (skips without C3_LS_TEST_DATABASE_URL) -------------------

type liveEnv struct {
	h       http.Handler
	store   *store.Store
	pub     ed25519.PublicKey
	ctx     context.Context
	trialID int64
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
	// Seed a trial plan so GitHub sign-in issues a trial license and bind tests
	// have a plan id to reference.
	if err := st.SeedPlans(ctx, []store.Plan{
		{PlanID: "trial-1m", Name: "Trial", DurationMonths: 1, PriceCents: 0, Currency: "CNY", SortOrder: 0, IsTrial: true},
	}); err != nil {
		t.Fatalf("seed trial plan: %v", err)
	}
	trial, ok, err := st.FirstTrialPlan(ctx)
	if err != nil || !ok {
		t.Fatalf("first trial plan: err=%v ok=%v", err, ok)
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
	return liveEnv{h: h, store: st, pub: priv.Public().(ed25519.PublicKey), ctx: ctx, trialID: trial.ID}
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
// URL the accept step redirects to.
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

func TestGitHubLoginIssuesLicenseKey(t *testing.T) {
	env := liveServer(t, githubOK())

	// 1) Landing page shows the agreement.
	if page := do(t, env.h, "GET", "/activate"); page.StatusCode != http.StatusOK {
		t.Fatalf("GET /activate = %d", page.StatusCode)
	}

	// 2) Accept → redirect to GitHub authorize with a signed state.
	acc := postForm(t, env.h, "/activate/accept", url.Values{"accept": {"on"}})
	if acc.StatusCode != http.StatusSeeOther {
		t.Fatalf("accept = %d, want 303", acc.StatusCode)
	}
	state := stateFromAuthorizeRedirect(t, acc.Header.Get("Location"))

	// 3) GitHub redirects back → upsert buyer, issue a trial license, show keys.
	cb := do(t, env.h, "GET", "/auth/github/callback?code=the-code&state="+url.QueryEscape(state))
	if cb.StatusCode != http.StatusOK {
		t.Fatalf("callback = %d, want 200", cb.StatusCode)
	}

	// The buyer now owns exactly one license with a non-empty key.
	buyerID, err := env.store.UpsertBuyer(env.ctx, 4242, "octocat", "octo@example.com")
	if err != nil {
		t.Fatalf("upsert buyer: %v", err)
	}
	licenses, err := env.store.ListLicensesByBuyer(env.ctx, buyerID)
	if err != nil {
		t.Fatalf("list licenses: %v", err)
	}
	if len(licenses) != 1 || licenses[0].LicenseKey == "" {
		t.Fatalf("expected one keyed license, got %+v", licenses)
	}
}

func TestCallbackRejectsForgedState(t *testing.T) {
	env := liveServer(t, githubOK())
	cb := do(t, env.h, "GET", "/auth/github/callback?code=x&state=forged.nonce")
	if cb.StatusCode != http.StatusBadRequest {
		t.Errorf("forged state = %d, want 400", cb.StatusCode)
	}
}

func TestAcceptRequiresExplicitAgreement(t *testing.T) {
	env := liveServer(t, githubOK())
	res := postForm(t, env.h, "/activate/accept", url.Values{})
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("accept without agreement = %d, want 400", res.StatusCode)
	}
}

func TestBindAndHeartbeatHappyPath(t *testing.T) {
	env := liveServer(t, githubOK())
	const installID = "inst-happy"

	// Seed a buyer + license directly (the GitHub flow is covered above).
	buyerID, err := env.store.UpsertBuyer(env.ctx, 99, "buyer", "b@example.com")
	if err != nil {
		t.Fatalf("upsert buyer: %v", err)
	}
	lic, _, err := env.store.EnsureLicenseForBuyer(env.ctx, buyerID, env.trialID, 30, time.Now(), func() string { return "license-key-xyz" })
	if err != nil {
		t.Fatalf("ensure license: %v", err)
	}

	// Bind this installation to the key.
	bind := postJSON(t, env.h, "/v1/license/bind",
		`{"licenseKey":"`+lic.LicenseKey+`","installationId":"`+installID+`"}`)
	if bind.StatusCode != http.StatusOK {
		t.Fatalf("bind = %d", bind.StatusCode)
	}
	var got struct {
		EntitlementToken string `json:"entitlementToken"`
		AliveToken       string `json:"aliveToken"`
		TermEnd          int64  `json:"termEnd"`
		Status           string `json:"status"`
	}
	if err := json.NewDecoder(bind.Body).Decode(&got); err != nil {
		t.Fatalf("decode bind: %v", err)
	}
	if got.AliveToken == "" || got.Status != "active" {
		t.Fatalf("bind payload = %+v", got)
	}
	payload, err := token.Verify(env.pub, got.EntitlementToken, time.Now())
	if err != nil {
		t.Fatalf("entitlement token does not verify: %v", err)
	}
	if payload.InstallationID != installID {
		t.Errorf("token installation = %q", payload.InstallationID)
	}
	if d := time.Unix(payload.TermEnd, 0).Sub(time.Unix(payload.TermStart, 0)); d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Errorf("term = %v, want ~30 days", d)
	}

	// Heartbeat with the alive token returns active + a refreshed token.
	hb := postJSON(t, env.h, "/v1/license/heartbeat",
		`{"licenseKey":"`+lic.LicenseKey+`","installationId":"`+installID+`","aliveToken":"`+got.AliveToken+`"}`)
	if hb.StatusCode != http.StatusOK {
		t.Fatalf("heartbeat = %d", hb.StatusCode)
	}
	var hbGot struct {
		Status           string `json:"status"`
		EntitlementToken string `json:"entitlementToken"`
	}
	if err := json.NewDecoder(hb.Body).Decode(&hbGot); err != nil {
		t.Fatalf("decode heartbeat: %v", err)
	}
	if hbGot.Status != "active" || hbGot.EntitlementToken == "" {
		t.Fatalf("heartbeat payload = %+v", hbGot)
	}

	// A heartbeat from a different installation is disabled (exclusive binding).
	other := postJSON(t, env.h, "/v1/license/heartbeat",
		`{"licenseKey":"`+lic.LicenseKey+`","installationId":"other","aliveToken":"`+got.AliveToken+`"}`)
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
	res := postJSON(t, env.h, "/v1/license/bind", `{"licenseKey":"nope","installationId":"i"}`)
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("bind unknown key = %d, want 404", res.StatusCode)
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
