package token

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

// devSeed is the committed development signing seed (matches the public key
// embedded in c3). Production keys are supplied via the environment (PL-R12).
const devSeed = "K4laQ0bwfnbm7ftsyQ8OseoV2xNkF5QvUTS30KbGPS0="

func testKeys(t *testing.T) (ed25519.PrivateKey, ed25519.PublicKey) {
	t.Helper()
	priv, _, err := ParsePrivateKey(devSeed)
	if err != nil {
		t.Fatalf("ParsePrivateKey: %v", err)
	}
	return priv, priv.Public().(ed25519.PublicKey)
}

func samplePayload(now time.Time) Payload {
	return Payload{
		InstallationID: "inst-123",
		LicenseID:      "42",
		Plan:           "trial-1m",
		Status:         "active",
		TermStart:      now.Unix(),
		TermEnd:        now.Add(30 * 24 * time.Hour).Unix(),
		IssuedAt:       now.Unix(),
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	priv, pub := testKeys(t)
	now := time.Unix(1_700_000_000, 0)

	tok, err := Sign(priv, samplePayload(now))
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if !strings.HasPrefix(tok, Version+".") || strings.Count(tok, ".") != 2 {
		t.Fatalf("unexpected token shape: %q", tok)
	}

	got, err := Verify(pub, tok, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.InstallationID != "inst-123" || got.Plan != "trial-1m" || got.Status != "active" {
		t.Errorf("payload round-trip mismatch: %+v", got)
	}
	if got.KeyID != KeyID(pub) {
		t.Errorf("kid = %q, want %q", got.KeyID, KeyID(pub))
	}
}

func TestVerifyRejectsTamperedPayload(t *testing.T) {
	priv, pub := testKeys(t)
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Sign(priv, samplePayload(now))

	parts := strings.Split(tok, ".")
	// Flip the signed payload to a different installation; signature must fail.
	parts[1] = base64.RawURLEncoding.EncodeToString([]byte(`{"installationId":"evil","status":"active","termStart":0,"termEnd":9999999999,"kid":"` + KeyID(pub) + `"}`))
	if _, err := Verify(pub, strings.Join(parts, "."), now); err == nil {
		t.Fatal("expected signature failure on tampered payload")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	priv, pub := testKeys(t)
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Sign(priv, samplePayload(now))

	after := time.Unix(now.Add(31*24*time.Hour).Unix(), 0)
	if _, err := Verify(pub, tok, after); err == nil {
		t.Fatal("expected window failure for expired token")
	}
	before := now.Add(-time.Hour)
	if _, err := Verify(pub, tok, before); err == nil {
		t.Fatal("expected window failure before term start")
	}
}

func TestVerifyRejectsWrongKey(t *testing.T) {
	priv, _ := testKeys(t)
	now := time.Unix(1_700_000_000, 0)
	tok, _ := Sign(priv, samplePayload(now))

	otherPub, _, _ := ed25519.GenerateKey(nil)
	if _, err := Verify(otherPub, tok, now); err == nil {
		t.Fatal("expected failure verifying with an unrelated key")
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	_, pub := testKeys(t)
	now := time.Unix(1_700_000_000, 0)
	for _, bad := range []string{"", "v1", "v1.abc", "v2.abc.def", "x.y.z.w"} {
		if _, err := Verify(pub, bad, now); err == nil {
			t.Errorf("expected malformed rejection for %q", bad)
		}
	}
}

func TestParsePrivateKeyValidation(t *testing.T) {
	if _, _, err := ParsePrivateKey("not-base64!!!"); err == nil {
		t.Error("expected error for non-base64 seed")
	}
	if _, _, err := ParsePrivateKey(base64.StdEncoding.EncodeToString([]byte("too-short"))); err == nil {
		t.Error("expected error for wrong-length seed")
	}
}
