package oauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestAuthorizeURLFor(t *testing.T) {
	c := New("client-abc", "secret")
	raw := c.AuthorizeURLFor("https://ls.example/auth/github/callback", "42.nonce", nil)
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	if q.Get("client_id") != "client-abc" {
		t.Errorf("client_id = %q", q.Get("client_id"))
	}
	if q.Get("state") != "42.nonce" {
		t.Errorf("state = %q", q.Get("state"))
	}
	if q.Get("redirect_uri") != "https://ls.example/auth/github/callback" {
		t.Errorf("redirect_uri = %q", q.Get("redirect_uri"))
	}
	if !strings.Contains(q.Get("scope"), "read:user") {
		t.Errorf("scope = %q, want read:user", q.Get("scope"))
	}
}

func TestExchangeAndFetchUser(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			if r.Method != http.MethodPost {
				t.Errorf("token: method = %s", r.Method)
			}
			_ = r.ParseForm()
			if r.Form.Get("code") != "the-code" {
				t.Errorf("code = %q", r.Form.Get("code"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"gho_test","token_type":"bearer"}`))
		case "/user":
			if got := r.Header.Get("Authorization"); got != "Bearer gho_test" {
				t.Errorf("authorization = %q", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":777,"login":"octocat","email":"octo@example.com"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := New("id", "secret")
	c.TokenURL = srv.URL + "/token"
	c.UserURL = srv.URL + "/user"

	tok, err := c.Exchange(context.Background(), "the-code", "https://ls/cb")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if tok != "gho_test" {
		t.Fatalf("token = %q", tok)
	}
	u, err := c.FetchUser(context.Background(), tok)
	if err != nil {
		t.Fatalf("FetchUser: %v", err)
	}
	if u.ID != 777 || u.Login != "octocat" {
		t.Errorf("user = %+v", u)
	}
}

func TestExchangeRejectsErrorResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"bad_verification_code","error_description":"expired"}`))
	}))
	defer srv.Close()

	c := New("id", "secret")
	c.TokenURL = srv.URL
	if _, err := c.Exchange(context.Background(), "x", "y"); err == nil {
		t.Fatal("expected error for GitHub error response")
	}
}

func TestFetchUserRejectsIncomplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":0,"login":""}`))
	}))
	defer srv.Close()

	c := New("id", "secret")
	c.UserURL = srv.URL
	if _, err := c.FetchUser(context.Background(), "tok"); err == nil {
		t.Fatal("expected error for incomplete identity")
	}
}

func TestStateID(t *testing.T) {
	if id, ok := StateID("42.abcdef"); !ok || id != "42" {
		t.Errorf("StateID(42.abcdef) = %q,%v", id, ok)
	}
	for _, bad := range []string{"", "noseparator", ".nonce", "abc.nonce"} {
		if _, ok := StateID(bad); ok {
			t.Errorf("StateID(%q) should be invalid", bad)
		}
	}
}

func TestConfiguredGuard(t *testing.T) {
	if New("", "").Configured() {
		t.Error("empty creds should be unconfigured")
	}
	if !New("id", "secret").Configured() {
		t.Error("present creds should be configured")
	}
}
