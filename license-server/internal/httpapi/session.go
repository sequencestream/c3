package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// sessionCookieName is the buyer's signed sign-in cookie. It is the only browser
// session state LS keeps: there is no server-side session table — the cookie is
// self-verifying, HMAC-keyed on the Ed25519 signing seed (the same keying as the
// OAuth CSRF state), so a tampered or forged cookie never authenticates a buyer.
const sessionCookieName = "c3ls_session"

// sessionTTL bounds how long a sign-in cookie is honored. It mirrors the c3
// login token lifetime; past it, the buyer signs in again.
const sessionTTL = 30 * 24 * time.Hour

// session is the buyer identity carried by the signed cookie. UserID is the
// authoritative reference (c3_ls_user.id); Login is for display only.
type session struct {
	UserID   int64  `json:"uid"`
	Login    string `json:"login"`
	IssuedAt int64  `json:"iat"`
}

// signSession encodes a session as "<base64url(JSON)>.<base64url(HMAC)>". The
// HMAC is keyed on the signing seed so the value is verifiable without any
// server-side store.
func signSession(signer Signer, s session) string {
	payload, _ := json.Marshal(s)
	b := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, signer.Seed())
	mac.Write([]byte(b))
	return b + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// parseSession verifies a cookie value and returns the session it carries. It
// fails closed on any tamper, decode error, missing user, or an expired TTL.
func parseSession(signer Signer, value string) (session, bool) {
	if signer == nil {
		return session{}, false
	}
	b, sig, ok := strings.Cut(value, ".")
	if !ok || b == "" || sig == "" {
		return session{}, false
	}
	mac := hmac.New(sha256.New, signer.Seed())
	mac.Write([]byte(b))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return session{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(b)
	if err != nil {
		return session{}, false
	}
	var s session
	if err := json.Unmarshal(raw, &s); err != nil || s.UserID <= 0 {
		return session{}, false
	}
	if s.IssuedAt > 0 && time.Since(time.Unix(s.IssuedAt, 0)) > sessionTTL {
		return session{}, false
	}
	return s, true
}

// setSession writes the signed sign-in cookie. Secure is set when the public URL
// is HTTPS; HttpOnly + SameSite=Lax keep it off scripts and cross-site posts.
func (d Deps) setSession(w http.ResponseWriter, s session) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    signSession(d.Signer, s),
		Path:     "/",
		HttpOnly: true,
		Secure:   strings.HasPrefix(strings.ToLower(strings.TrimSpace(d.Config.PublicURL)), "https://"),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL / time.Second),
	})
}

// currentSession reads and verifies the sign-in cookie on a request.
func (d Deps) currentSession(r *http.Request) (session, bool) {
	c, err := r.Cookie(sessionCookieName)
	if err != nil {
		return session{}, false
	}
	return parseSession(d.Signer, c.Value)
}
