// Package token mints and verifies the LS-signed entitlement token (ADR-0026,
// PL-R5). The token is the offline-verifiable assertion c3 caches and checks
// between heartbeats: LS holds the Ed25519 private key and signs; c3 embeds only
// the matching public key and verifies offline.
//
// Wire format (compact, URL-safe, no external dependency):
//
//	v1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
//
// The signature covers the exact bytes "v1.<payloadB64>" — the same bytes the
// verifier reconstructs from the token — so the two sides never need a canonical
// JSON encoder to agree. This mirrors the release-signing discipline (ADR-0010)
// reused here for entitlement.
package token

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Version is the single token format version this package mints and accepts.
const Version = "v1"

// Payload is the entitlement assertion carried by the token. Times are Unix
// seconds (UTC) so the encoding is stable across languages. Status is always
// "active" at issuance; lapses are derived c3-side from the validity window and
// heartbeat, never minted as a non-active token.
type Payload struct {
	InstallationID string `json:"installationId"`
	LicenseID      string `json:"licenseId"`
	Status         string `json:"status"`
	Plan           string `json:"plan,omitempty"`
	TermStart      int64  `json:"termStart"`
	TermEnd        int64  `json:"termEnd"`
	IssuedAt       int64  `json:"issuedAt"`
	KeyID          string `json:"kid"`
}

// ParsePrivateKey decodes a standard-base64 Ed25519 seed (32 bytes) into a
// private key and derives the key id (the first 16 hex chars of SHA-256 over the
// public key). The seed is the only secret LS holds for signing (PL-R12).
func ParsePrivateKey(seedB64 string) (ed25519.PrivateKey, string, error) {
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(seedB64))
	if err != nil {
		return nil, "", fmt.Errorf("token: decode private seed: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return nil, "", fmt.Errorf("token: private seed must be %d bytes, got %d", ed25519.SeedSize, len(seed))
	}
	priv := ed25519.NewKeyFromSeed(seed)
	return priv, KeyID(priv.Public().(ed25519.PublicKey)), nil
}

// ParsePublicKey decodes a standard-base64 Ed25519 public key (32 bytes). Used
// by tests and any verifying path; c3 embeds the same key.
func ParsePublicKey(pubB64 string) (ed25519.PublicKey, error) {
	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pubB64))
	if err != nil {
		return nil, fmt.Errorf("token: decode public key: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("token: public key must be %d bytes, got %d", ed25519.PublicKeySize, len(pub))
	}
	return ed25519.PublicKey(pub), nil
}

// KeyID derives the short key identifier (16 hex chars of SHA-256 over the
// public key). Embedded in the payload so a verifier can reject a token signed
// by a key it does not carry, enabling rotation.
func KeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return hex.EncodeToString(sum[:])[:16]
}

// Sign produces a signed entitlement token for the payload. The payload's KeyID
// is overwritten with the signing key's id so it always matches the signature.
func Sign(priv ed25519.PrivateKey, p Payload) (string, error) {
	p.KeyID = KeyID(priv.Public().(ed25519.PublicKey))
	body, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("token: marshal payload: %w", err)
	}
	payloadB64 := base64.RawURLEncoding.EncodeToString(body)
	signingInput := Version + "." + payloadB64
	sig := ed25519.Sign(priv, []byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// Verify parses a token, checks its Ed25519 signature against pub, and confirms
// the validity window contains now. It is the Go twin of the c3-side verifier;
// both are exercised by tests so the format cannot drift. Deny-by-default: any
// parse/signature/window failure returns an error and no payload (PL-R5).
func Verify(pub ed25519.PublicKey, tokenStr string, now time.Time) (Payload, error) {
	var zero Payload
	parts := strings.Split(tokenStr, ".")
	if len(parts) != 3 || parts[0] != Version {
		return zero, fmt.Errorf("token: malformed token")
	}
	payloadB64, sigB64 := parts[1], parts[2]

	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return zero, fmt.Errorf("token: decode signature: %w", err)
	}
	signingInput := parts[0] + "." + payloadB64
	if !ed25519.Verify(pub, []byte(signingInput), sig) {
		return zero, fmt.Errorf("token: signature does not verify")
	}

	body, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return zero, fmt.Errorf("token: decode payload: %w", err)
	}
	var p Payload
	if err := json.Unmarshal(body, &p); err != nil {
		return zero, fmt.Errorf("token: unmarshal payload: %w", err)
	}
	if p.KeyID != KeyID(pub) {
		return zero, fmt.Errorf("token: key id mismatch")
	}
	nowUnix := now.Unix()
	if nowUnix < p.TermStart || nowUnix >= p.TermEnd {
		return zero, fmt.Errorf("token: outside validity window")
	}
	return p, nil
}
