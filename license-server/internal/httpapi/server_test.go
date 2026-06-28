package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
)

func testServer(t *testing.T) http.Handler {
	t.Helper()
	cfg, err := config.LoadFrom(func(k string) string {
		if k == config.EnvEd25519PrivateKey {
			return "SECRET-SIGNING-KEY"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	static := fstest.MapFS{
		"index.html":     {Data: []byte("<!doctype html><div id=app>spa</div>")},
		"assets/app.css": {Data: []byte(".x{}")},
	}
	return NewServer(Deps{
		Config: cfg,
		Caches: cache.NewRegistry(cfg.LRUSize),
		DB:     nil,
		Static: static,
	})
}

func do(t *testing.T, h http.Handler, method, target string) *http.Response {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec.Result()
}

func TestHealthz(t *testing.T) {
	res := do(t, testServer(t), "GET", "/healthz")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("json: %v", err)
	}
	if got["status"] != "healthy" {
		t.Errorf("status = %v, want healthy", got["status"])
	}
	// Secret must be redacted to a presence indicator, never the value.
	if strings.Contains(string(body), "SECRET-SIGNING-KEY") {
		t.Errorf("healthz leaked a secret: %s", body)
	}
	cfgView, ok := got["config"].(map[string]any)
	if !ok || cfgView["ed25519PrivateKey"] != "set" {
		t.Errorf("expected redacted ed25519PrivateKey=set, got %v", got["config"])
	}
	checks, _ := got["checks"].(map[string]any)
	if checks["database"] != "not_configured" {
		t.Errorf("database check = %v, want not_configured", checks["database"])
	}
}

func TestPlansEndpoint(t *testing.T) {
	res := do(t, testServer(t), "GET", "/v1/plans")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var got struct {
		Plans []struct {
			PlanKey    string `json:"planKey"`
			PriceCents int    `json:"priceCents"`
			Currency   string `json:"currency"`
			Tier       string `json:"tier"`
		} `json:"plans"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Plans) != 4 {
		t.Fatalf("got %d plans, want 4", len(got.Plans))
	}
	wantPrice := map[string]int{"1m": 100, "6m": 590, "1y": 1090, "enterprise-1y": 10000}
	wantTier := map[string]string{"1m": "paid", "6m": "paid", "1y": "paid", "enterprise-1y": "enterprise"}
	for _, p := range got.Plans {
		if wantPrice[p.PlanKey] != p.PriceCents {
			t.Errorf("plan %q price = %d, want %d", p.PlanKey, p.PriceCents, wantPrice[p.PlanKey])
		}
		if p.Currency != "CNY" {
			t.Errorf("plan %q currency = %q", p.PlanKey, p.Currency)
		}
		if p.Tier != wantTier[p.PlanKey] {
			t.Errorf("plan %q tier = %q, want %q", p.PlanKey, p.Tier, wantTier[p.PlanKey])
		}
	}
}

func TestPlanTiersEndpoint(t *testing.T) {
	res := do(t, testServer(t), "GET", "/v1/plan-tiers")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var got struct {
		Tiers        []map[string]string `json:"tiers"`
		Capabilities []map[string]string `json:"capabilities"`
	}
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Tiers) != 3 {
		t.Fatalf("tiers len = %d, want 3", len(got.Tiers))
	}
	if len(got.Capabilities) < 7 {
		t.Fatalf("capabilities len = %d, want at least 7", len(got.Capabilities))
	}
	if got.Tiers[0]["tier"] != "free" || got.Tiers[2]["tier"] != "enterprise" {
		t.Fatalf("tiers order = %+v", got.Tiers)
	}
}

func TestPlansMethodNotAllowed(t *testing.T) {
	res := do(t, testServer(t), "POST", "/v1/plans")
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /v1/plans status = %d, want 405", res.StatusCode)
	}
}

func TestStaticServesExistingAsset(t *testing.T) {
	res := do(t, testServer(t), "GET", "/assets/app.css")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if string(body) != ".x{}" {
		t.Errorf("asset body = %q", body)
	}
}

func TestStaticServesIndexAtRoot(t *testing.T) {
	res := do(t, testServer(t), "GET", "/")
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "id=app") {
		t.Errorf("root did not serve index.html: %q", body)
	}
}

func TestSPAFallbackForUnknownRoute(t *testing.T) {
	res := do(t, testServer(t), "GET", "/license/activate")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (SPA fallback)", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	if !strings.Contains(string(body), "id=app") {
		t.Errorf("SPA fallback did not serve index.html: %q", body)
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	res := do(t, testServer(t), "GET", "/v1/does-not-exist")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("content-type = %q, want json (not SPA html)", ct)
	}
}
