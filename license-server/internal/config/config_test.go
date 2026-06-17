package config

import (
	"strings"
	"testing"
)

// envMap builds a Getenv backed by a map for hermetic tests.
func envMap(m map[string]string) Getenv {
	return func(k string) string { return m[k] }
}

func TestLoadFromDefaults(t *testing.T) {
	c, err := LoadFrom(envMap(nil))
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	if c.ListenAddr != DefaultListenAddr {
		t.Errorf("ListenAddr = %q, want %q", c.ListenAddr, DefaultListenAddr)
	}
	if c.LRUSize != DefaultLRUSize {
		t.Errorf("LRUSize = %d, want %d", c.LRUSize, DefaultLRUSize)
	}
	if c.GraceMinutes != DefaultGraceMinutes {
		t.Errorf("GraceMinutes = %d, want %d", c.GraceMinutes, DefaultGraceMinutes)
	}
	if c.AdminAllowlist != nil {
		t.Errorf("AdminAllowlist = %v, want nil", c.AdminAllowlist)
	}
}

func TestLoadFromValues(t *testing.T) {
	c, err := LoadFrom(envMap(map[string]string{
		EnvDatabaseURL:    "postgres://u:p@localhost/ls",
		EnvListenAddr:     ":9000",
		EnvPublicURL:      "https://ls.example.com",
		EnvLRUSize:        "256",
		EnvGraceMinutes:   "15",
		EnvAdminAllowlist: "alice, bob ,, carol",
	}))
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	if c.ListenAddr != ":9000" {
		t.Errorf("ListenAddr = %q", c.ListenAddr)
	}
	if c.LRUSize != 256 || c.GraceMinutes != 15 {
		t.Errorf("LRUSize=%d GraceMinutes=%d", c.LRUSize, c.GraceMinutes)
	}
	want := []string{"alice", "bob", "carol"}
	if len(c.AdminAllowlist) != len(want) {
		t.Fatalf("AdminAllowlist = %v, want %v", c.AdminAllowlist, want)
	}
	for i := range want {
		if c.AdminAllowlist[i] != want[i] {
			t.Errorf("AdminAllowlist[%d] = %q, want %q", i, c.AdminAllowlist[i], want[i])
		}
	}
}

func TestLoadFromRejectsBadInts(t *testing.T) {
	for _, env := range []string{EnvLRUSize, EnvGraceMinutes} {
		if _, err := LoadFrom(envMap(map[string]string{env: "notanumber"})); err == nil {
			t.Errorf("%s=notanumber: expected error", env)
		}
		if _, err := LoadFrom(envMap(map[string]string{env: "0"})); err == nil {
			t.Errorf("%s=0: expected error (must be positive)", env)
		}
	}
}

func TestRedactedHidesSecrets(t *testing.T) {
	c, err := LoadFrom(envMap(map[string]string{
		EnvDatabaseURL:             "postgres://user:SUPERSECRET@db/ls",
		EnvEd25519PrivateKey:       "PRIVATE-KEY-MATERIAL",
		EnvEd25519PublicKey:        "PUBLIC-KEY",
		EnvGitHubOAuthClientSecret: "GH-SECRET",
		EnvWeChatPayAPIKey:         "WX-SECRET",
		EnvWeChatPayPrivateKey:     "WX-PRIVATE-KEY-MATERIAL",
		EnvPublicURL:               "https://ls.example.com",
	}))
	if err != nil {
		t.Fatalf("LoadFrom: %v", err)
	}
	r := c.Redacted()

	// No secret value may appear anywhere in the redacted view.
	flat := strings.ToLower(joinValues(r))
	for _, secret := range []string{"supersecret", "private-key-material", "gh-secret", "wx-secret", "wx-private-key-material"} {
		if strings.Contains(flat, secret) {
			t.Errorf("redacted view leaked secret %q: %v", secret, r)
		}
	}
	// Secrets present as "set".
	for _, k := range []string{"databaseUrl", "ed25519PrivateKey", "githubOauthClientSecret", "wechatPayApiKey", "wechatPayPrivateKey"} {
		if r[k] != "set" {
			t.Errorf("redacted[%q] = %v, want \"set\"", k, r[k])
		}
	}
	// Non-secrets surface their real value.
	if r["publicUrl"] != "https://ls.example.com" {
		t.Errorf("publicUrl = %v", r["publicUrl"])
	}
	if r["ed25519PublicKey"] != "set" {
		t.Errorf("ed25519PublicKey presence = %v", r["ed25519PublicKey"])
	}
}

func TestRedactedUnsetSecrets(t *testing.T) {
	c, _ := LoadFrom(envMap(nil))
	r := c.Redacted()
	if r["databaseUrl"] != "unset" {
		t.Errorf("databaseUrl = %v, want unset", r["databaseUrl"])
	}
}

func joinValues(m map[string]any) string {
	var b strings.Builder
	for _, v := range m {
		b.WriteString(strings.TrimSpace(toStr(v)))
		b.WriteByte('\n')
	}
	return b.String()
}

func toStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
