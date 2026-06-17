package httpapi

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/agreement"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

// TrialPlanID is the plan id recorded on the default one-month entitlement a new
// buyer receives on GitHub registration (no payment for the MVP, ADR-0026).
const TrialPlanID = "trial-1m"

// mountActivation registers the simplified license surface. The browser-facing
// routes (GitHub account login + the license-key page) render HTML; the c3-facing
// bind/heartbeat routes are JSON.
func mountActivation(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/activate", allowGET(handleAgreementPage(d)))
	mux.HandleFunc("/activate/accept", allowPOST(handleAcceptAndLogin(d)))
	mux.HandleFunc("/auth/github/callback", allowGET(handleGitHubCallback(d)))
	mux.HandleFunc("/v1/license/bind", allowPOST(handleLicenseBind(d)))
	mux.HandleFunc("/v1/license/heartbeat", allowPOST(handleLicenseHeartbeat(d)))
}

// loginReady reports whether the browser GitHub-login surface can operate: it
// needs a database, OAuth credentials, a signing key (to derive the CSRF state
// secret), and a public URL (the OAuth callback). When any is missing the surface
// returns a clear error rather than a half-working flow.
func (d Deps) loginReady() (string, bool) {
	if !d.Store.Available() {
		return "license database is not configured", false
	}
	if !d.OAuth.Configured() {
		return "GitHub OAuth is not configured", false
	}
	if d.Signer == nil {
		return "signing key is not configured", false
	}
	if strings.TrimSpace(d.Config.PublicURL) == "" {
		return "public URL is not configured", false
	}
	return "", true
}

// licenseAPIReady reports whether the c3-facing bind/heartbeat API can operate:
// it needs a database and a signing key (to mint entitlement tokens). It does not
// need OAuth or the public URL.
func (d Deps) licenseAPIReady() bool {
	return d.Store.Available() && d.Signer != nil
}

// --- GET /activate : the no-refund agreement page ---------------------------

func handleAgreementPage(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg, ok := d.loginReady(); !ok {
			renderError(w, http.StatusServiceUnavailable, "Sign-in unavailable", msg)
			return
		}
		renderAgreement(w)
	}
}

// --- POST /activate/accept : record acceptance, go to GitHub ----------------

func handleAcceptAndLogin(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg, ok := d.loginReady(); !ok {
			renderError(w, http.StatusServiceUnavailable, "Sign-in unavailable", msg)
			return
		}
		if err := r.ParseForm(); err != nil {
			renderError(w, http.StatusBadRequest, "Invalid request", "Could not read the form.")
			return
		}
		// Acceptance must be explicit: the only path to GitHub login is the accept
		// button, which is also what mints a valid OAuth state (PL-R9).
		if r.PostForm.Get("accept") != "on" && r.PostForm.Get("accept") != "true" {
			renderError(w, http.StatusBadRequest, "Agreement required",
				"You must accept the service agreement to continue. "+agreement.Summary)
			return
		}
		state := d.signState(randToken())
		callback := strings.TrimRight(d.Config.PublicURL, "/") + "/auth/github/callback"
		http.Redirect(w, r, d.OAuth.AuthorizeURLFor(callback, state, nil), http.StatusSeeOther)
	}
}

// --- GET /auth/github/callback : finish login, show the license key ---------

func handleGitHubCallback(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg, ok := d.loginReady(); !ok {
			renderError(w, http.StatusServiceUnavailable, "Sign-in unavailable", msg)
			return
		}
		q := r.URL.Query()
		if oauthErr := q.Get("error"); oauthErr != "" {
			renderError(w, http.StatusBadRequest, "GitHub sign-in failed", q.Get("error_description"))
			return
		}
		code := q.Get("code")
		state := q.Get("state")
		// CSRF: the state must be one this LS minted (stateless HMAC over the seed).
		if code == "" || !d.verifyState(state) {
			renderError(w, http.StatusBadRequest, "GitHub sign-in failed", "Missing or invalid authorization response.")
			return
		}

		callback := strings.TrimRight(d.Config.PublicURL, "/") + "/auth/github/callback"
		accessToken, err := d.OAuth.Exchange(r.Context(), code, callback)
		if err != nil {
			renderError(w, http.StatusBadGateway, "GitHub sign-in failed", "Could not complete sign-in with GitHub.")
			return
		}
		user, err := d.OAuth.FetchUser(r.Context(), accessToken)
		if err != nil {
			renderError(w, http.StatusBadGateway, "GitHub sign-in failed", "Could not read your GitHub identity.")
			return
		}
		buyerID, err := d.Store.UpsertBuyer(r.Context(), user.ID, user.Login, user.Email)
		if err != nil {
			renderError(w, http.StatusInternalServerError, "Sign-in error", "Could not record your account.")
			return
		}
		// Registration includes a default trial entitlement so a new buyer leaves
		// with a license_key to bind into c3.
		if _, _, err := d.Store.EnsureLicenseForBuyer(r.Context(), buyerID, TrialPlanID, config.DefaultLicenseTermDays, time.Now(), randToken); err != nil {
			renderError(w, http.StatusInternalServerError, "Sign-in error", "Could not provision your license.")
			return
		}
		licenses, err := d.Store.ListLicensesByBuyer(r.Context(), buyerID)
		if err != nil {
			renderError(w, http.StatusInternalServerError, "Sign-in error", "Could not load your licenses.")
			return
		}
		renderLicenses(w, user.Login, licenses)
	}
}

// --- POST /v1/license/bind : c3 binds an installation to a license_key ------

type bindRequest struct {
	LicenseKey     string `json:"licenseKey"`
	InstallationID string `json:"installationId"`
}

func handleLicenseBind(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !d.licenseAPIReady() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "license service is not configured")
			return
		}
		var body bindRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
			return
		}
		if body.LicenseKey == "" || body.InstallationID == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "licenseKey and installationId are required")
			return
		}

		now := time.Now()
		res, err := d.Store.BindInstallation(r.Context(), body.LicenseKey, body.InstallationID, now, randToken)
		if err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				writeError(w, http.StatusNotFound, "invalid_key", "unknown license key")
			case errors.Is(err, store.ErrRevoked):
				writeError(w, http.StatusConflict, "revoked", "this license has been revoked")
			case errors.Is(err, store.ErrExpired):
				writeError(w, http.StatusGone, "expired", "this license term has ended")
			default:
				writeError(w, http.StatusInternalServerError, "bind_failed", "could not bind this installation")
			}
			return
		}

		entitlement, err := signEntitlement(d.Signer, body.InstallationID, res.License, now)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "bind_failed", "could not sign entitlement")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"type":                     "activated",
			"status":                   "active",
			"entitlementToken":         entitlement,
			"aliveToken":               res.AliveToken,
			"heartbeatIntervalSeconds": config.DefaultHeartbeatIntervalSeconds,
			"plan":                     res.License.Plan,
			"termEnd":                  res.License.TermEnd.Unix(),
		})
	}
}

// --- POST /v1/license/heartbeat : c3 confirms the live binding --------------

type heartbeatRequest struct {
	LicenseKey     string `json:"licenseKey"`
	InstallationID string `json:"installationId"`
	AliveToken     string `json:"aliveToken"`
}

func handleLicenseHeartbeat(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !d.licenseAPIReady() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "license service is not configured")
			return
		}
		var body heartbeatRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
			return
		}
		if body.LicenseKey == "" || body.InstallationID == "" || body.AliveToken == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "licenseKey, installationId and aliveToken are required")
			return
		}

		now := time.Now()
		res, err := d.Store.Heartbeat(r.Context(), body.LicenseKey, body.InstallationID, body.AliveToken, now)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "invalid_key", "unknown license key")
				return
			}
			writeError(w, http.StatusInternalServerError, "heartbeat_failed", "could not process heartbeat")
			return
		}

		// Non-active verdicts are a 200 with a discriminating status so c3 gates
		// new sessions without treating it as a transient (grace-eligible) error.
		out := map[string]any{
			"type":                     "heartbeat",
			"status":                   res.Status,
			"heartbeatIntervalSeconds": config.DefaultHeartbeatIntervalSeconds,
		}
		if res.Status == store.HeartbeatActive {
			entitlement, err := signEntitlement(d.Signer, body.InstallationID, res.License, now)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "heartbeat_failed", "could not sign entitlement")
				return
			}
			out["entitlementToken"] = entitlement
			out["plan"] = res.License.Plan
			out["termEnd"] = res.License.TermEnd.Unix()
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// --- helpers ----------------------------------------------------------------

// signEntitlement mints the offline-verifiable entitlement token for a license
// bound to installationID (PL-R5).
func signEntitlement(signer Signer, installationID string, lic store.License, now time.Time) (string, error) {
	return token.Sign(signer, token.Payload{
		InstallationID: installationID,
		LicenseID:      strconv.FormatInt(lic.ID, 10),
		Plan:           lic.Plan,
		Status:         "active",
		TermStart:      lic.TermStart.Unix(),
		TermEnd:        lic.TermEnd.Unix(),
		IssuedAt:       now.Unix(),
	})
}

// signState mints a stateless CSRF state: "<nonce>.<base64url(HMAC-SHA256(seed,
// nonce))>". Keying the HMAC on the Ed25519 signing seed avoids a separate
// secret and a server-side request table — the state is self-verifying.
func (d Deps) signState(nonce string) string {
	mac := hmac.New(sha256.New, d.Signer.Seed())
	mac.Write([]byte(nonce))
	return nonce + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// verifyState recomputes the HMAC over the nonce and constant-time compares it.
func (d Deps) verifyState(state string) bool {
	nonce, sig, ok := strings.Cut(state, ".")
	if !ok || nonce == "" || sig == "" || d.Signer == nil {
		return false
	}
	mac := hmac.New(sha256.New, d.Signer.Seed())
	mac.Write([]byte(nonce))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(sig), []byte(want)) == 1
}

// allowPOST mirrors allowGET for the JSON endpoints.
func allowPOST(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only POST is allowed")
			return
		}
		h(w, r)
	}
}

// randToken returns 32 bytes of URL-safe random — used for the license_key, the
// alive bearer token, and the OAuth state nonce. crypto/rand failure is
// fatal-by-panic since a non-random security token must never be issued.
func randToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("httpapi: crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Signer is the Ed25519 private key type alias kept for readable Deps.
type Signer = ed25519.PrivateKey

var agreementTmpl = template.Must(template.New("agreement").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} — c3 license</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
 h1{font-size:1.4rem} .p{margin:.8rem 0} .agree{margin:1.5rem 0;display:flex;gap:.5rem;align-items:flex-start}
 button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#1a1a1a;color:#fff;cursor:pointer}
 button:disabled{opacity:.5;cursor:not-allowed} .note{color:#666;font-size:.9rem}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}.note{color:#aaa}}
</style></head><body>
<h1>{{.Title}}</h1>
{{range .Paragraphs}}<p class="p">{{.}}</p>{{end}}
<form method="post" action="/activate/accept">
 <label class="agree"><input type="checkbox" name="accept" id="accept" onchange="document.getElementById('go').disabled=!this.checked">
  <span>I have read and accept this service agreement.</span></label>
 <button type="submit" id="go" disabled>Accept &amp; continue with GitHub</button>
</form>
<p class="note">Agreement version {{.Version}}. Declining cancels sign-in.</p>
</body></html>`))

func renderAgreement(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = agreementTmpl.Execute(w, map[string]any{
		"Title":      agreement.Title,
		"Paragraphs": agreement.Paragraphs,
		"Version":    agreement.Version,
	})
}

var licensesTmpl = template.Must(template.New("licenses").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your c3 licenses</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
 h1{font-size:1.4rem} .note{color:#666;font-size:.95rem}
 .lic{margin:1.2rem 0;padding:1rem 1.2rem;border:1px solid #ddd;border-radius:.5rem}
 .key{font:0.95rem ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f4f4;padding:.4rem .6rem;border-radius:.3rem;word-break:break-all;display:block;margin:.4rem 0}
 .meta{color:#666;font-size:.9rem}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.lic{border-color:#333}.key{background:#1c1c1c}.note,.meta{color:#aaa}}
</style></head><body>
<h1>Signed in as {{.Login}}</h1>
<p class="note">Copy a license key below and paste it into c3 to activate this installation. One license binds to a single installation at a time.</p>
{{range .Licenses}}
<div class="lic">
 <span class="key">{{.LicenseKey}}</span>
 <div class="meta">Plan {{.Plan}} · {{.Status}} · valid until {{.TermEndDisplay}}</div>
</div>
{{else}}
<p>No licenses on this account yet.</p>
{{end}}
</body></html>`))

// licenseView is the display shape for the license-key page.
type licenseView struct {
	LicenseKey     string
	Plan           string
	Status         string
	TermEndDisplay string
}

func renderLicenses(w http.ResponseWriter, login string, licenses []store.License) {
	views := make([]licenseView, len(licenses))
	for i, l := range licenses {
		views[i] = licenseView{
			LicenseKey:     l.LicenseKey,
			Plan:           l.Plan,
			Status:         l.Status,
			TermEndDisplay: l.TermEnd.UTC().Format("2006-01-02"),
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = licensesTmpl.Execute(w, map[string]any{"Login": login, "Licenses": views})
}

var errorTmpl = template.Must(template.New("error").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{.Heading}}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}
 h1{font-size:1.3rem} p{color:#555}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style>
</head><body><h1>{{.Heading}}</h1><p>{{.Message}}</p></body></html>`))

func renderError(w http.ResponseWriter, status int, heading, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = errorTmpl.Execute(w, map[string]any{"Heading": heading, "Message": message})
}
