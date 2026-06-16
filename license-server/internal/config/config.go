// Package config loads the license-server (LS) configuration from the
// environment and exposes a redacted view safe for the health endpoint.
//
// All knobs are environment-driven (12-factor): there is no config file. The
// LS owns secrets the c3 process is forbidden to hold — the Ed25519 signing
// key, GitHub OAuth secrets, and WeChat Pay credentials (ADR-0026, PL-R12).
// Those secrets MUST NEVER appear in a health response or a log line, so the
// [Config.Redacted] view replaces every secret with a presence indicator.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Defaults for the optional knobs.
const (
	DefaultListenAddr   = ":8787"
	DefaultLRUSize      = 1024
	DefaultGraceMinutes = 30
)

// Config is the fully-resolved LS configuration.
//
// Fields tagged "secret" in the comments are redacted by [Config.Redacted];
// they are loaded so the runtime can use them but are never surfaced.
type Config struct {
	// DatabaseURL is the PostgreSQL DSN. Secret (carries the DB password).
	DatabaseURL string
	// ListenAddr is the HTTP listen address (host:port).
	ListenAddr string
	// PublicURL is the externally reachable base URL of the LS, used to build
	// OAuth callback and payment-return URLs.
	PublicURL string

	// Ed25519PrivateKey signs entitlement tokens. Secret; LS-only (PL-R12).
	Ed25519PrivateKey string
	// Ed25519PublicKey is the verification key published for embedding in c3.
	// Public by design — safe to surface.
	Ed25519PublicKey string

	// GitHubOAuthClientID identifies the LS GitHub OAuth app. Not secret.
	GitHubOAuthClientID string
	// GitHubOAuthClientSecret is the GitHub OAuth app secret. Secret.
	GitHubOAuthClientSecret string

	// WeChatPayMchID is the WeChat Pay merchant id. Not secret on its own.
	WeChatPayMchID string
	// WeChatPayAPIKey is the WeChat Pay API key. Secret.
	WeChatPayAPIKey string

	// LRUSize bounds every in-process LRU cache (entries per cache).
	LRUSize int
	// GraceMinutes is the offline-grace window in minutes (PL-R4 default 30).
	GraceMinutes int

	// AdminAllowlist is the set of GitHub logins permitted on the admin
	// back-office (PL-R11), parsed from a comma-separated env value.
	AdminAllowlist []string
}

// Environment variable names. Centralized so docs and tests reference one source.
const (
	EnvDatabaseURL             = "LS_DATABASE_URL"
	EnvListenAddr              = "LS_LISTEN_ADDR"
	EnvPublicURL               = "LS_PUBLIC_URL"
	EnvEd25519PrivateKey       = "LS_ED25519_PRIVATE_KEY"
	EnvEd25519PublicKey        = "LS_ED25519_PUBLIC_KEY"
	EnvGitHubOAuthClientID     = "LS_GITHUB_OAUTH_CLIENT_ID"
	EnvGitHubOAuthClientSecret = "LS_GITHUB_OAUTH_CLIENT_SECRET"
	EnvWeChatPayMchID          = "LS_WECHAT_PAY_MCH_ID"
	EnvWeChatPayAPIKey         = "LS_WECHAT_PAY_API_KEY"
	EnvLRUSize                 = "LS_LRU_SIZE"
	EnvGraceMinutes            = "LS_GRACE_MINUTES"
	EnvAdminAllowlist          = "LS_ADMIN_ALLOWLIST"
)

// Getenv is the signature of an environment lookup, mirroring [os.Getenv].
// Load accepts one so tests can supply a fake environment without touching the
// process environment.
type Getenv func(key string) string

// Load resolves the configuration from the process environment.
func Load() (*Config, error) {
	return LoadFrom(os.Getenv)
}

// LoadFrom resolves the configuration using the supplied lookup. Optional knobs
// fall back to defaults; malformed numeric values are a hard error so a typo
// never silently degrades to a default.
func LoadFrom(get Getenv) (*Config, error) {
	c := &Config{
		DatabaseURL:             get(EnvDatabaseURL),
		ListenAddr:              firstNonEmpty(get(EnvListenAddr), DefaultListenAddr),
		PublicURL:               get(EnvPublicURL),
		Ed25519PrivateKey:       get(EnvEd25519PrivateKey),
		Ed25519PublicKey:        get(EnvEd25519PublicKey),
		GitHubOAuthClientID:     get(EnvGitHubOAuthClientID),
		GitHubOAuthClientSecret: get(EnvGitHubOAuthClientSecret),
		WeChatPayMchID:          get(EnvWeChatPayMchID),
		WeChatPayAPIKey:         get(EnvWeChatPayAPIKey),
		AdminAllowlist:          parseList(get(EnvAdminAllowlist)),
	}

	size, err := parseIntDefault(get(EnvLRUSize), DefaultLRUSize)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EnvLRUSize, err)
	}
	if size <= 0 {
		return nil, fmt.Errorf("%s: must be a positive integer, got %d", EnvLRUSize, size)
	}
	c.LRUSize = size

	grace, err := parseIntDefault(get(EnvGraceMinutes), DefaultGraceMinutes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EnvGraceMinutes, err)
	}
	if grace <= 0 {
		return nil, fmt.Errorf("%s: must be a positive integer, got %d", EnvGraceMinutes, grace)
	}
	c.GraceMinutes = grace

	return c, nil
}

// Redacted returns a JSON-serializable view of the configuration with every
// secret replaced by a presence indicator ("set"/"unset"). This is the only
// shape that may reach the health endpoint or a log line (PL-R12).
func (c *Config) Redacted() map[string]any {
	return map[string]any{
		"listenAddr":          c.ListenAddr,
		"publicUrl":           c.PublicURL,
		"lruSize":             c.LRUSize,
		"graceMinutes":        c.GraceMinutes,
		"adminAllowlistCount": len(c.AdminAllowlist),
		"ed25519PublicKey":    presence(c.Ed25519PublicKey),
		"githubOauthClientId": presence(c.GitHubOAuthClientID),
		"wechatPayMchId":      presence(c.WeChatPayMchID),
		// Secrets — presence only, never the value.
		"databaseUrl":             presence(c.DatabaseURL),
		"ed25519PrivateKey":       presence(c.Ed25519PrivateKey),
		"githubOauthClientSecret": presence(c.GitHubOAuthClientSecret),
		"wechatPayApiKey":         presence(c.WeChatPayAPIKey),
	}
}

func presence(v string) string {
	if v == "" {
		return "unset"
	}
	return "set"
}

func firstNonEmpty(v, fallback string) string {
	if strings.TrimSpace(v) == "" {
		return fallback
	}
	return v
}

func parseIntDefault(v string, fallback int) (int, error) {
	if strings.TrimSpace(v) == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, fmt.Errorf("invalid integer %q", v)
	}
	return n, nil
}

func parseList(v string) []string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
