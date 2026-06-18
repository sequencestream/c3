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
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

// installID / requestID length bounds (§10). installId is a stable per-install
// identifier; requestId is the c3-generated 32-char per-round id.
const (
	maxInstallIDLen = 128
	requestIDLen    = 32
)

// mountAuth registers the GitHub sign-in surface (browser/Vue). Sign-in is
// account login only — no agreement is shown here (the agreement appears at
// checkout, §4). mountLicense registers the binding API (browser + c3 S2S).
func mountAuth(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/v1/auth/login", allowPOST(handleAuthLogin(d)))
	mux.HandleFunc("/v1/auth/github/callback", allowGET(handleGitHubCallback(d)))
	mux.HandleFunc("/v1/session", allowGET(handleSession(d)))
}

func mountLicense(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/v1/license/activate", allowGET(handleLicenseActivate(d)))
	mux.HandleFunc("/v1/license/bind", allowPOST(handleLicenseBind(d)))
	mux.HandleFunc("/v1/license/checkbind", allowGET(handleLicenseCheckbind(d)))
	mux.HandleFunc("/v1/license/heartbeat", allowPOST(handleLicenseHeartbeat(d)))
}

// loginReady reports whether the browser GitHub-login surface can operate: it
// needs a database, OAuth credentials, a signing key (to derive the CSRF state
// secret and the session cookie), and a public URL (the OAuth callback).
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
	if strings.TrimSpace(d.Config.ExternalBaseURL()) == "" {
		return "public URL is not configured", false
	}
	return "", true
}

// licenseAPIReady reports whether the c3-facing checkbind/heartbeat API can
// operate: a database and a signing key (to mint entitlement tokens). It does not
// need OAuth or the public URL.
func (d Deps) licenseAPIReady() bool {
	return d.Store.Available() && d.Signer != nil
}

// --- POST /v1/auth/login : start GitHub OAuth (no agreement) -----------------

func handleAuthLogin(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg, ok := d.loginReady(); !ok {
			writeError(w, http.StatusServiceUnavailable, "unavailable", msg)
			return
		}
		_ = r.ParseForm()
		// The binding round identifiers are carried through OAuth in the signed
		// state and handed back to the SPA on the callback, so the user lands back
		// on the activation view with the same (installId, requestId).
		st := statePayload{
			Nonce:     randToken(),
			InstallID: r.FormValue("installId"),
			RequestID: r.FormValue("requestId"),
		}
		callback := strings.TrimRight(d.Config.ExternalBaseURL(), "/") + "/v1/auth/github/callback"
		http.Redirect(w, r, d.OAuth.AuthorizeURLFor(callback, d.signState(st), nil), http.StatusSeeOther)
	}
}

// --- GET /v1/auth/github/callback : finish login, return to the SPA ----------

func handleGitHubCallback(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if msg, ok := d.loginReady(); !ok {
			writeError(w, http.StatusServiceUnavailable, "unavailable", msg)
			return
		}
		q := r.URL.Query()
		if oauthErr := q.Get("error"); oauthErr != "" {
			http.Redirect(w, r, "/?error="+url.QueryEscape(q.Get("error_description")), http.StatusSeeOther)
			return
		}
		st, ok := d.verifyState(q.Get("state"))
		if q.Get("code") == "" || !ok {
			http.Redirect(w, r, "/?error="+url.QueryEscape("Missing or invalid authorization response."), http.StatusSeeOther)
			return
		}

		callback := strings.TrimRight(d.Config.ExternalBaseURL(), "/") + "/v1/auth/github/callback"
		accessToken, err := d.OAuth.Exchange(r.Context(), q.Get("code"), callback)
		if err != nil {
			http.Redirect(w, r, "/?error="+url.QueryEscape("Could not complete sign-in with GitHub."), http.StatusSeeOther)
			return
		}
		user, err := d.OAuth.FetchUser(r.Context(), accessToken)
		if err != nil {
			http.Redirect(w, r, "/?error="+url.QueryEscape("Could not read your GitHub identity."), http.StatusSeeOther)
			return
		}
		userID, err := d.Store.UpsertUser(r.Context(), user.ID, user.Login, user.Email)
		if err != nil {
			http.Redirect(w, r, "/?error="+url.QueryEscape("Could not record your account."), http.StatusSeeOther)
			return
		}
		// Every account leaves with at least one license to bind, created on first
		// sign-in when none exists (§4/§5).
		if _, _, err := d.Store.EnsureDefaultLicense(r.Context(), userID, config.DefaultLicenseTermDays, time.Now(), randToken); err != nil {
			http.Redirect(w, r, "/?error="+url.QueryEscape("Could not provision your license."), http.StatusSeeOther)
			return
		}
		d.setSession(w, session{UserID: userID, Login: user.Login, IssuedAt: time.Now().Unix()})

		// Back to the SPA, preserving the binding round so the activation view can
		// resume without re-entering installId/requestId.
		dest := "/"
		if st.InstallID != "" || st.RequestID != "" {
			vals := url.Values{}
			if st.InstallID != "" {
				vals.Set("installId", st.InstallID)
			}
			if st.RequestID != "" {
				vals.Set("requestId", st.RequestID)
			}
			dest = "/?" + vals.Encode()
		}
		http.Redirect(w, r, dest, http.StatusSeeOther)
	}
}

// --- GET /v1/session : who am I (for the SPA) --------------------------------

func handleSession(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if sess, ok := d.currentSession(r); ok {
			writeJSON(w, http.StatusOK, map[string]any{"signedIn": true, "login": sess.Login})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"signedIn": false, "login": ""})
	}
}

// --- GET /v1/license/activate : list licenses + register the binding round ---

func handleLicenseActivate(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := d.currentSession(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		if !d.Store.Available() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "license database is not configured")
			return
		}
		installID := r.URL.Query().Get("installId")
		requestID := r.URL.Query().Get("requestId")
		if msg, ok := validateBindIDs(installID, requestID); !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", msg)
			return
		}
		slog.Info("license activate", "user", sess.UserID, "login", sess.Login, "install", installID, "request", requestID)
		// Ensure the account has a license to bind, then register this round so
		// checkbind recognizes it (the entry is filled in by bind).
		if _, _, err := d.Store.EnsureDefaultLicense(r.Context(), sess.UserID, config.DefaultLicenseTermDays, time.Now(), randToken); err != nil {
			writeError(w, http.StatusInternalServerError, "activate_failed", "could not provision your license")
			return
		}
		licenses, err := d.Store.LicenseBindingsByUser(r.Context(), sess.UserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "activate_failed", "could not load your licenses")
			return
		}
		out := map[string]any{"licenses": licenseViews(licenses)}
		// Convenience (§4): a user whose only license is long-lived is bound to this
		// installation automatically, so the browser need not show a picker and c3's
		// checkbind collects the result directly.
		if termEnd, ok := d.maybeAutoBind(r, licenses, installID, requestID); ok {
			out["autoBound"] = true
			out["termEnd"] = termEnd
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// autoBindThresholdMonths is the remaining-term floor for auto-binding: a user's
// sole license is bound to the requesting installation automatically only when it
// stays valid beyond now + this many months. The default one-month trial term
// (exactly at the floor) is therefore not auto-bound — a returning user with a
// renewed/long license is.
const autoBindThresholdMonths = 1

// maybeAutoBind binds the user's single license to (installID, requestID) when it
// is active and valid beyond autoBindThresholdMonths, stashing the secrets for
// checkbind exactly as handleLicenseBind would (the browser response never carries
// them, PL-R2). Best-effort: with no signer, more than one license, an ineligible
// term, or any store error it returns ok=false and the manual bind path stands.
// Returns the bound term_end (unix seconds) on success.
func (d Deps) maybeAutoBind(r *http.Request, licenses []store.LicenseBinding, installID, requestID string) (int64, bool) {
	if d.Signer == nil || len(licenses) != 1 {
		return 0, false
	}
	only := licenses[0]
	now := time.Now()
	if only.Status != "active" || !only.TermEnd.After(now.AddDate(0, autoBindThresholdMonths, 0)) {
		slog.Info("license auto-bind skipped", "install", installID, "status", only.Status, "termEnd", only.TermEnd.Format(time.RFC3339))
		return 0, false
	}
	res, err := d.Store.BindInstallation(r.Context(), only.LicenseKey, installID, now, randToken)
	if err != nil {
		slog.Warn("license auto-bind failed", "install", installID, "err", err)
		return 0, false
	}
	entitlement, err := signEntitlement(d.Signer, installID, res.License, now)
	if err != nil {
		slog.Warn("license auto-bind sign failed", "install", installID, "err", err)
		return 0, false
	}
	d.Binds.put(installID, requestID, bindEntry{
		licenseKey:       only.LicenseKey,
		aliveToken:       res.AliveToken,
		entitlementToken: entitlement,
		termEnd:          res.License.TermEnd.Unix(),
	})
	slog.Info("license auto-bound", "license", res.License.ID, "install", installID, "request", requestID, "termEnd", res.License.TermEnd.Format(time.RFC3339))
	return res.License.TermEnd.Unix(), true
}

// --- POST /v1/license/bind : bind the chosen license to this installation ----

type bindRequest struct {
	InstallID  string `json:"installId"`
	RequestID  string `json:"requestId"`
	LicenseKey string `json:"licenseKey"`
}

func handleLicenseBind(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := d.currentSession(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		if !d.licenseAPIReady() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "license service is not configured")
			return
		}
		var body bindRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
			return
		}
		if msg, ok := validateBindIDs(body.InstallID, body.RequestID); !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", msg)
			return
		}
		if body.LicenseKey == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "licenseKey is required")
			return
		}
		// The chosen license must belong to the signed-in user.
		if !d.userOwnsLicenseKey(r, sess.UserID, body.LicenseKey) {
			writeError(w, http.StatusNotFound, "invalid_key", "license not found for this account")
			return
		}

		now := time.Now()
		res, err := d.Store.BindInstallation(r.Context(), body.LicenseKey, body.InstallID, now, randToken)
		if err != nil {
			switch {
			case errors.Is(err, store.ErrNotFound):
				writeError(w, http.StatusNotFound, "invalid_key", "unknown license key")
			case errors.Is(err, store.ErrExpired):
				writeError(w, http.StatusGone, "expired", "this license term has ended")
			default:
				writeError(w, http.StatusInternalServerError, "bind_failed", "could not bind this installation")
			}
			return
		}
		entitlement, err := signEntitlement(d.Signer, body.InstallID, res.License, now)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "bind_failed", "could not sign entitlement")
			return
		}
		// Stash the secrets for c3 server to collect over S2S via checkbind; the
		// browser response carries neither the alive token nor the token (PL-R2).
		d.Binds.put(body.InstallID, body.RequestID, bindEntry{
			licenseKey:       body.LicenseKey,
			aliveToken:       res.AliveToken,
			entitlementToken: entitlement,
			termEnd:          res.License.TermEnd.Unix(),
		})
		slog.Info("license bound", "license", res.License.ID, "install", body.InstallID, "request", body.RequestID, "termEnd", res.License.TermEnd.Format(time.RFC3339))
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "active",
			"termEnd": res.License.TermEnd.Unix(),
		})
	}
}

// --- GET /v1/license/checkbind : c3 server collects the completed binding ----

func handleLicenseCheckbind(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !d.licenseAPIReady() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "license service is not configured")
			return
		}
		installID := r.URL.Query().Get("installId")
		requestID := r.URL.Query().Get("requestId")
		if msg, ok := validateBindIDs(installID, requestID); !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", msg)
			return
		}
		e, ok := d.Binds.take(installID, requestID)
		if !ok {
			slog.Info("license checkbind pending", "install", installID, "request", requestID)
			writeJSON(w, http.StatusOK, map[string]any{"status": "pending"})
			return
		}
		slog.Info("license checkbind collected", "install", installID, "request", requestID)
		writeJSON(w, http.StatusOK, map[string]any{
			"status":           "active",
			"licenseKey":       e.licenseKey,
			"aliveToken":       e.aliveToken,
			"entitlementToken": e.entitlementToken,
			"termEnd":          e.termEnd,
		})
	}
}

// --- POST /v1/license/heartbeat : c3 server confirms the live binding --------

type heartbeatRequest struct {
	InstallID  string `json:"installId"`
	AliveToken string `json:"aliveToken"`
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
		if body.InstallID == "" || body.AliveToken == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "installId and aliveToken are required")
			return
		}

		now := time.Now()
		res, err := d.Store.HeartbeatByInstall(r.Context(), body.InstallID, body.AliveToken, now)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "heartbeat_failed", "could not process heartbeat")
			return
		}
		out := map[string]any{
			"status":                   res.Status,
			"heartbeatIntervalSeconds": config.DefaultHeartbeatIntervalSeconds,
		}
		if res.Status == store.HeartbeatActive {
			entitlement, err := signEntitlement(d.Signer, body.InstallID, res.License, now)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "heartbeat_failed", "could not sign entitlement")
				return
			}
			out["entitlementToken"] = entitlement
			out["termEnd"] = res.License.TermEnd.Unix()
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// --- helpers ----------------------------------------------------------------

// validateBindIDs enforces the installId/requestId length bounds (§10).
func validateBindIDs(installID, requestID string) (string, bool) {
	switch {
	case installID == "" || requestID == "":
		return "installId and requestId are required", false
	case len(installID) > maxInstallIDLen:
		return "installId exceeds 128 characters", false
	case len(requestID) != requestIDLen:
		return "requestId must be 32 characters", false
	}
	return "", true
}

// userOwnsLicenseKey reports whether licenseKey is one the signed-in user owns.
func (d Deps) userOwnsLicenseKey(r *http.Request, userID int64, licenseKey string) bool {
	licenses, err := d.Store.ListLicensesByUser(r.Context(), userID)
	if err != nil {
		return false
	}
	for _, l := range licenses {
		if l.LicenseKey == licenseKey {
			return true
		}
	}
	return false
}

// licenseViews projects license bindings to the JSON the activation/account
// pages render. It never exposes the alive token or entitlement token (PL-R2).
func licenseViews(ls []store.LicenseBinding) []map[string]any {
	out := make([]map[string]any, len(ls))
	for i, l := range ls {
		var installID any
		if l.AliveInstallID != nil {
			installID = *l.AliveInstallID
		}
		var aliveTime any
		if l.AliveTime != nil {
			aliveTime = l.AliveTime.Unix()
		}
		out[i] = map[string]any{
			"licenseId":      l.ID,
			"licenseKey":     l.LicenseKey,
			"status":         l.Status,
			"termEnd":        l.TermEnd.Unix(),
			"aliveInstallId": installID,
			"aliveTime":      aliveTime,
		}
	}
	return out
}

// signEntitlement mints the offline-verifiable entitlement token for a license
// bound to installID (PL-R5).
func signEntitlement(signer Signer, installID string, lic store.License, now time.Time) (string, error) {
	return token.Sign(signer, token.Payload{
		InstallationID: installID,
		LicenseID:      strconv.FormatInt(lic.ID, 10),
		Status:         "active",
		TermStart:      lic.TermStart.Unix(),
		TermEnd:        lic.TermEnd.Unix(),
		IssuedAt:       now.Unix(),
	})
}

// statePayload is the CSRF-protected OAuth state. The nonce defeats CSRF; the
// binding round ids ride along so the callback can return the user to the same
// activation view.
type statePayload struct {
	Nonce     string `json:"n"`
	InstallID string `json:"i,omitempty"`
	RequestID string `json:"r,omitempty"`
}

// signState mints "<base64url(JSON)>.<base64url(HMAC-SHA256(seed, b64))>". Keying
// the HMAC on the Ed25519 signing seed avoids a separate secret and a
// server-side request table — the state is self-verifying.
func (d Deps) signState(p statePayload) string {
	raw, _ := json.Marshal(p)
	b := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, d.Signer.Seed())
	mac.Write([]byte(b))
	return b + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// verifyState recomputes the HMAC and constant-time compares it, returning the
// carried payload on success.
func (d Deps) verifyState(state string) (statePayload, bool) {
	b, sig, ok := strings.Cut(state, ".")
	if !ok || b == "" || sig == "" || d.Signer == nil {
		return statePayload{}, false
	}
	mac := hmac.New(sha256.New, d.Signer.Seed())
	mac.Write([]byte(b))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(sig), []byte(want)) != 1 {
		return statePayload{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(b)
	if err != nil {
		return statePayload{}, false
	}
	var p statePayload
	if err := json.Unmarshal(raw, &p); err != nil || p.Nonce == "" {
		return statePayload{}, false
	}
	return p, true
}

// allowPOST mirrors allowGET for the JSON write endpoints.
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
