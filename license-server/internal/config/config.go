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
	// DefaultArtifactMaxBytes bounds a single build-artifact upload (200 MiB). A
	// release tarball is tens of MiB; a larger body is refused rather than buffered.
	DefaultArtifactMaxBytes int64 = 200 << 20
)

// Activation/entitlement domain defaults (not env-driven; the same for every
// installation). The license term is the default one-month trial entitlement a
// user receives on GitHub registration; the heartbeat interval is what LS
// dictates to c3 (returned on bind and each heartbeat).
const (
	DefaultLicenseTermDays          = 30
	DefaultHeartbeatIntervalSeconds = 3600
	// DefaultOrderPaymentWindowMinutes bounds how long a pending order stays
	// payable before it is treated as expired (§11): the WeChat Native order's
	// time_expire and the LS-side lazy/sweep expiry both use it.
	DefaultOrderPaymentWindowMinutes = 15
	// OrderReconcileIntervalSeconds is how often the LS reconcile job queries
	// WeChat for the true state of pending orders and settles them (§11). It runs
	// frequently (every 15s) so a paid order is confirmed promptly even when the
	// async callback never arrives (e.g. the notify URL is not publicly reachable);
	// the 15-minute payment window is still enforced per-order by comparing each
	// order's created_at to the window, independent of this interval.
	OrderReconcileIntervalSeconds = 15
	// MaxLicenseTermAheadMonths caps how far into the future a license term may be
	// stacked: checkout refuses a renewal whose target term_end already lies beyond
	// now + this many months (§11).
	MaxLicenseTermAheadMonths = 12
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
	// PublicURL is the base URL the process itself is reachable at (typically the
	// local listen address, e.g. http://localhost:8787). Kept distinct from
	// BaseURL so a process behind a reverse proxy can still describe its own
	// origin. When BaseURL is unset it is the fallback for outbound-visible URLs,
	// which keeps local dev working without configuring BaseURL.
	PublicURL string
	// BaseURL is the externally reachable base URL clients and third parties see
	// (e.g. https://c3.sequencestream.com). It is what every outbound-visible URL
	// is built from — the GitHub OAuth callback, the WeChat Pay notify URL — and
	// it drives the session cookie's Secure flag. Behind a reverse proxy this
	// differs from PublicURL/ListenAddr; set it in production. Falls back to
	// PublicURL when unset.
	BaseURL string

	// Ed25519PrivateKey signs entitlement tokens. Secret; LS-only (PL-R12).
	Ed25519PrivateKey string
	// Ed25519PublicKey is the verification key published for embedding in c3.
	// Public by design — safe to surface.
	Ed25519PublicKey string

	// GitHubOAuthClientID identifies the LS GitHub OAuth app. Not secret.
	GitHubOAuthClientID string
	// GitHubOAuthClientSecret is the GitHub OAuth app secret. Secret.
	GitHubOAuthClientSecret string

	// WeChat Pay (APIv3) credentials. The MVP takes renewal payment via WeChat
	// Pay Native (a PC-web scan-to-pay QR). APIv3 needs more than a merchant id +
	// key: a certificate serial number identifies which merchant key signed each
	// request, the merchant private key signs outbound calls, and the merchant
	// certificate is loaded at client construction. All live only in LS (PL-R12).

	// WeChatPayMchID is the WeChat Pay merchant id (直连商户号). Not secret on its own.
	WeChatPayMchID string
	// WeChatPayAppID is the app id (公众号/应用 AppID) the merchant is bound to. Not secret.
	WeChatPayAppID string
	// WeChatPayCertSerialNo is the merchant certificate serial number (商户证书序列号).
	// Not secret — it only names which key signed a request.
	WeChatPayCertSerialNo string
	// WeChatPayAPIKey is the WeChat Pay APIv3 key (商户 APIv3 密钥), used to sign
	// requests and to decrypt callback payloads. Secret.
	WeChatPayAPIKey string
	// WeChatPayPrivateKey is the merchant private key (apiclient_key.pem), supplied
	// base64-encoded so a PEM with newlines survives an environment variable.
	// Secret; LS-only.
	WeChatPayPrivateKey string
	// WeChatPayCert is the merchant certificate (apiclient_cert.pem), base64-encoded.
	// Required to construct the WeChat Pay client; a certificate is not itself a
	// secret but is presence-redacted for uniformity.
	WeChatPayCert string

	// LRUSize bounds every in-process LRU cache (entries per cache).
	LRUSize int
	// GraceMinutes is the offline-grace window in minutes (PL-R4 default 30).
	GraceMinutes int

	// AdminAllowlist is the set of GitHub logins permitted on the admin
	// back-office (PL-R11), parsed from a comma-separated env value.
	AdminAllowlist []string

	// Build-artifact upload (release pipeline → self-hosted store). The c3 release
	// jobs POST each signed artifact to /v1/artifact/upload; the endpoint is
	// disabled unless BOTH the token and the directory are set.

	// ArtifactUploadToken is the fixed bearer token the upload endpoint requires.
	// Secret; when empty the endpoint reports "unavailable" rather than accepting
	// unauthenticated writes.
	ArtifactUploadToken string
	// ArtifactDir is the root directory uploaded artifacts are written under, laid
	// out as <ArtifactDir>/<version>/<batch>/<filename>. Empty disables the endpoint.
	ArtifactDir string
	// ArtifactMaxBytes caps a single upload body (DefaultArtifactMaxBytes when unset).
	ArtifactMaxBytes int64
}

// Environment variable names. Centralized so docs and tests reference one source.
const (
	EnvDatabaseURL             = "C3_LS_DATABASE_URL"
	EnvListenAddr              = "C3_LS_LISTEN_ADDR"
	EnvPublicURL               = "C3_LS_PUBLIC_URL"
	EnvBaseURL                 = "C3_LS_BASE_URL"
	EnvEd25519PrivateKey       = "C3_LS_ED25519_PRIVATE_KEY"
	EnvEd25519PublicKey        = "C3_LS_ED25519_PUBLIC_KEY"
	EnvGitHubOAuthClientID     = "C3_LS_GITHUB_OAUTH_CLIENT_ID"
	EnvGitHubOAuthClientSecret = "C3_LS_GITHUB_OAUTH_CLIENT_SECRET"
	EnvWeChatPayMchID          = "C3_LS_WECHAT_PAY_MCH_ID"
	EnvWeChatPayAppID          = "C3_LS_WECHAT_PAY_APP_ID"
	EnvWeChatPayCertSerialNo   = "C3_LS_WECHAT_PAY_CERT_SERIAL_NO"
	EnvWeChatPayAPIKey         = "C3_LS_WECHAT_PAY_API_KEY"
	EnvWeChatPayPrivateKey     = "C3_LS_WECHAT_PAY_PRIVATE_KEY"
	EnvWeChatPayCert           = "C3_LS_WECHAT_PAY_CERT"
	EnvLRUSize                 = "C3_LS_LRU_SIZE"
	EnvGraceMinutes            = "C3_LS_GRACE_MINUTES"
	EnvAdminAllowlist          = "C3_LS_ADMIN_ALLOWLIST"
	EnvArtifactUploadToken     = "C3_LS_ARTIFACT_UPLOAD_TOKEN"
	EnvArtifactDir             = "C3_LS_ARTIFACT_DIR"
	EnvArtifactMaxBytes        = "C3_LS_ARTIFACT_MAX_BYTES"
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
		BaseURL:                 get(EnvBaseURL),
		Ed25519PrivateKey:       get(EnvEd25519PrivateKey),
		Ed25519PublicKey:        get(EnvEd25519PublicKey),
		GitHubOAuthClientID:     get(EnvGitHubOAuthClientID),
		GitHubOAuthClientSecret: get(EnvGitHubOAuthClientSecret),
		WeChatPayMchID:          get(EnvWeChatPayMchID),
		WeChatPayAppID:          get(EnvWeChatPayAppID),
		WeChatPayCertSerialNo:   get(EnvWeChatPayCertSerialNo),
		WeChatPayAPIKey:         get(EnvWeChatPayAPIKey),
		WeChatPayPrivateKey:     get(EnvWeChatPayPrivateKey),
		WeChatPayCert:           get(EnvWeChatPayCert),
		AdminAllowlist:          parseList(get(EnvAdminAllowlist)),
		ArtifactUploadToken:     get(EnvArtifactUploadToken),
		ArtifactDir:             get(EnvArtifactDir),
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

	maxBytes, err := parseInt64Default(get(EnvArtifactMaxBytes), DefaultArtifactMaxBytes)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", EnvArtifactMaxBytes, err)
	}
	if maxBytes <= 0 {
		return nil, fmt.Errorf("%s: must be a positive integer, got %d", EnvArtifactMaxBytes, maxBytes)
	}
	c.ArtifactMaxBytes = maxBytes

	return c, nil
}

// ExternalBaseURL resolves the base URL every outbound-visible URL is built from
// (OAuth callback, payment notify, cookie Secure flag): BaseURL when set, else
// PublicURL. The fallback keeps local dev working with only C3_LS_PUBLIC_URL set.
func (c *Config) ExternalBaseURL() string {
	return firstNonEmpty(c.BaseURL, c.PublicURL)
}

// Redacted returns a JSON-serializable view of the configuration with every
// secret replaced by a presence indicator ("set"/"unset"). This is the only
// shape that may reach the health endpoint or a log line (PL-R12).
func (c *Config) Redacted() map[string]any {
	return map[string]any{
		"listenAddr":            c.ListenAddr,
		"publicUrl":             c.PublicURL,
		"baseUrl":               c.BaseURL,
		"lruSize":               c.LRUSize,
		"graceMinutes":          c.GraceMinutes,
		"adminAllowlistCount":   len(c.AdminAllowlist),
		"artifactDir":           c.ArtifactDir,
		"artifactMaxBytes":      c.ArtifactMaxBytes,
		"artifactUploadToken":   presence(c.ArtifactUploadToken),
		"ed25519PublicKey":      presence(c.Ed25519PublicKey),
		"githubOauthClientId":   presence(c.GitHubOAuthClientID),
		"wechatPayMchId":        presence(c.WeChatPayMchID),
		"wechatPayAppId":        presence(c.WeChatPayAppID),
		"wechatPayCertSerialNo": presence(c.WeChatPayCertSerialNo),
		"wechatPayCert":         presence(c.WeChatPayCert),
		// Secrets — presence only, never the value.
		"databaseUrl":             presence(c.DatabaseURL),
		"ed25519PrivateKey":       presence(c.Ed25519PrivateKey),
		"githubOauthClientSecret": presence(c.GitHubOAuthClientSecret),
		"wechatPayApiKey":         presence(c.WeChatPayAPIKey),
		"wechatPayPrivateKey":     presence(c.WeChatPayPrivateKey),
	}
}

// WeChatPayConfigured reports whether every credential a WeChat Pay APIv3
// client needs is present. The renewal payment surface degrades to a clear
// "unavailable" (rather than half-working) when any is missing.
func (c *Config) WeChatPayConfigured() bool {
	return c != nil &&
		strings.TrimSpace(c.WeChatPayMchID) != "" &&
		strings.TrimSpace(c.WeChatPayAppID) != "" &&
		strings.TrimSpace(c.WeChatPayCertSerialNo) != "" &&
		strings.TrimSpace(c.WeChatPayAPIKey) != "" &&
		strings.TrimSpace(c.WeChatPayPrivateKey) != "" &&
		strings.TrimSpace(c.WeChatPayCert) != ""
}

// ArtifactUploadConfigured reports whether the build-artifact upload endpoint is
// enabled: both the bearer token and the storage directory must be set, else the
// endpoint degrades to a clear "unavailable" rather than accepting writes.
func (c *Config) ArtifactUploadConfigured() bool {
	return c != nil &&
		strings.TrimSpace(c.ArtifactUploadToken) != "" &&
		strings.TrimSpace(c.ArtifactDir) != ""
}

// ArtifactReadConfigured reports whether public artifact discovery and download
// can read the configured store. Unlike uploads, public reads need no token.
func (c *Config) ArtifactReadConfigured() bool {
	return c != nil && strings.TrimSpace(c.ArtifactDir) != ""
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

func parseInt64Default(v string, fallback int64) (int64, error) {
	if strings.TrimSpace(v) == "" {
		return fallback, nil
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
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
