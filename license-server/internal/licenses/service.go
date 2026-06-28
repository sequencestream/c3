package licenses

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"log/slog"
	"strconv"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
)

// Signer is the Ed25519 private key that mints offline-verifiable entitlement
// tokens (PL-R5). It is nil when C3_LS_ED25519_PRIVATE_KEY is unset, which makes
// the license API report "unavailable" rather than half-working.
type Signer = ed25519.PrivateKey

// autoBindThresholdMonths is the remaining-term floor for auto-binding: a user's
// sole license is bound to the requesting installation automatically only when it
// stays valid beyond now + this many months. The long-lived default free term is
// eligible, so a new free user can activate without a manual picker.
const autoBindThresholdMonths = 1

// Service is the license binding/heartbeat business layer. It composes the license
// repository, the entitlement Signer, and the process-internal pending-bind
// registry; handlers call it and never touch the store or the registry directly.
type Service struct {
	repo   *Repo
	signer Signer
	binds  *bindRegistry
}

// NewService builds the license service over the repository and Signer, with a
// fresh in-memory pending-bind registry.
func NewService(repo *Repo, signer Signer) *Service {
	return &Service{repo: repo, signer: signer, binds: newBindRegistry()}
}

// Ready reports whether the c3-facing bind/checkbind/heartbeat API can operate: a
// database and a signing key (to mint entitlement tokens). It does not need OAuth
// or the public URL.
func (s *Service) Ready() bool { return s.repo.Available() && s.signer != nil }

// StoreReady reports whether the database is configured (the browser activation
// surface needs it even before an entitlement is minted).
func (s *Service) StoreReady() bool { return s.repo.Available() }

// EnsureDefault guarantees the account owns at least one license, issuing a fresh
// default-term one when none exists. Reports whether one was created.
func (s *Service) EnsureDefault(ctx context.Context, userID int64, now time.Time) (License, bool, error) {
	return s.repo.EnsureDefault(ctx, userID, config.DefaultLicenseTermDays, now, randToken)
}

// ListBindings returns every license the user owns with its current binding info,
// for the account/activation pages. It never exposes the alive token (PL-R2).
func (s *Service) ListBindings(ctx context.Context, userID int64) ([]LicenseBinding, error) {
	return s.repo.BindingsByUser(ctx, userID)
}

// ActivateResult is what the activation surface returns: the user's licenses plus,
// when the sole long-lived license was bound automatically, the bound term_end.
type ActivateResult struct {
	Licenses  []LicenseBinding
	AutoBound bool
	TermEnd   int64
}

// Activate ensures the account has a license to bind, lists the user's licenses,
// and — as a convenience (§4) — auto-binds when the user's only license is
// long-lived, so the browser need not show a picker and c3's checkbind collects
// the result directly.
func (s *Service) Activate(ctx context.Context, userID int64, installID, requestID string, now time.Time) (ActivateResult, error) {
	if _, _, err := s.repo.EnsureDefault(ctx, userID, config.DefaultLicenseTermDays, now, randToken); err != nil {
		return ActivateResult{}, err
	}
	licenses, err := s.repo.BindingsByUser(ctx, userID)
	if err != nil {
		return ActivateResult{}, err
	}
	out := ActivateResult{Licenses: licenses}
	if termEnd, ok := s.maybeAutoBind(ctx, licenses, installID, requestID, now); ok {
		out.AutoBound = true
		out.TermEnd = termEnd
	}
	return out, nil
}

// maybeAutoBind binds the user's single license to (installID, requestID) when it
// is active and valid beyond autoBindThresholdMonths, stashing the secrets for
// checkbind exactly as Bind would (the browser response never carries them,
// PL-R2). Best-effort: with no signer, more than one license, an ineligible term,
// or any error it returns ok=false and the manual bind path stands. Returns the
// bound term_end (unix seconds) on success.
func (s *Service) maybeAutoBind(ctx context.Context, licenses []LicenseBinding, installID, requestID string, now time.Time) (int64, bool) {
	if s.signer == nil || len(licenses) != 1 {
		return 0, false
	}
	only := licenses[0]
	if only.Status != "active" || !only.TermEnd.After(now.AddDate(0, autoBindThresholdMonths, 0)) {
		slog.Info("license auto-bind skipped", "install", installID, "status", only.Status, "termEnd", only.TermEnd.Format(time.RFC3339))
		return 0, false
	}
	res, err := s.repo.BindInstallation(ctx, only.LicenseKey, installID, now, randToken)
	if err != nil {
		slog.Warn("license auto-bind failed", "install", installID, "err", err)
		return 0, false
	}
	entitlement, err := s.signEntitlement(installID, res.License, now)
	if err != nil {
		slog.Warn("license auto-bind sign failed", "install", installID, "err", err)
		return 0, false
	}
	s.binds.put(installID, requestID, bindEntry{
		licenseKey:       only.LicenseKey,
		aliveToken:       res.AliveToken,
		entitlementToken: entitlement,
		termEnd:          res.License.TermEnd.Unix(),
	})
	slog.Info("license auto-bound", "license", res.License.ID, "install", installID, "request", requestID, "termEnd", res.License.TermEnd.Format(time.RFC3339))
	return res.License.TermEnd.Unix(), true
}

// Bind binds the chosen license to this installation on behalf of the signed-in
// user. The license must belong to the user (ErrNotOwned), exist (ErrNotFound),
// and be active/unexpired (ErrExpired). On success it stashes the alive token and
// signed entitlement for c3 to collect over S2S via checkbind, and returns the
// bound term_end (unix seconds). The caller's browser response carries neither the
// alive token nor the entitlement token (PL-R2).
func (s *Service) Bind(ctx context.Context, userID int64, installID, requestID, licenseKey string, now time.Time) (int64, error) {
	if !s.userOwnsLicenseKey(ctx, userID, licenseKey) {
		return 0, ErrNotOwned
	}
	res, err := s.repo.BindInstallation(ctx, licenseKey, installID, now, randToken)
	if err != nil {
		return 0, err
	}
	entitlement, err := s.signEntitlement(installID, res.License, now)
	if err != nil {
		return 0, err
	}
	s.binds.put(installID, requestID, bindEntry{
		licenseKey:       licenseKey,
		aliveToken:       res.AliveToken,
		entitlementToken: entitlement,
		termEnd:          res.License.TermEnd.Unix(),
	})
	slog.Info("license bound", "license", res.License.ID, "install", installID, "request", requestID, "termEnd", res.License.TermEnd.Format(time.RFC3339))
	return res.License.TermEnd.Unix(), nil
}

// CheckBindResult is the completed binding c3 server collects over S2S.
type CheckBindResult struct {
	LicenseKey       string
	AliveToken       string
	EntitlementToken string
	TermEnd          int64
}

// CheckBind returns the completed binding for (installID, requestID) and consumes
// it. ok is false when the round is not yet complete (checkbind reports "pending")
// or its entry has expired.
func (s *Service) CheckBind(installID, requestID string) (CheckBindResult, bool) {
	e, ok := s.binds.take(installID, requestID)
	if !ok {
		return CheckBindResult{}, false
	}
	return CheckBindResult{
		LicenseKey:       e.licenseKey,
		AliveToken:       e.aliveToken,
		EntitlementToken: e.entitlementToken,
		TermEnd:          e.termEnd,
	}, true
}

// HeartbeatOut is the heartbeat verdict for c3: the status and, when active, a
// freshly minted entitlement token and the term_end.
type HeartbeatOut struct {
	Status           string
	EntitlementToken string
	TermEnd          int64
}

// Heartbeat confirms the live binding identified by (installID, aliveToken) and,
// when active, mints a fresh entitlement token off the refreshed license.
func (s *Service) Heartbeat(ctx context.Context, installID, aliveToken string, now time.Time) (HeartbeatOut, error) {
	res, err := s.repo.HeartbeatByInstall(ctx, installID, aliveToken, now)
	if err != nil {
		return HeartbeatOut{}, err
	}
	out := HeartbeatOut{Status: res.Status}
	if res.Status == HeartbeatActive {
		entitlement, err := s.signEntitlement(installID, res.License, now)
		if err != nil {
			return HeartbeatOut{}, err
		}
		out.EntitlementToken = entitlement
		out.TermEnd = res.License.TermEnd.Unix()
	}
	return out, nil
}

// userOwnsLicenseKey reports whether licenseKey is one the signed-in user owns.
func (s *Service) userOwnsLicenseKey(ctx context.Context, userID int64, licenseKey string) bool {
	licenses, err := s.repo.ListByUser(ctx, userID)
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

// signEntitlement mints the offline-verifiable entitlement token for a license
// bound to installID (PL-R5).
func (s *Service) signEntitlement(installID string, lic License, now time.Time) (string, error) {
	return token.Sign(s.signer, token.Payload{
		InstallationID: installID,
		LicenseID:      strconv.FormatInt(lic.ID, 10),
		Status:         "active",
		Plan:           lic.Tier,
		TermStart:      lic.TermStart.Unix(),
		TermEnd:        lic.TermEnd.Unix(),
		IssuedAt:       now.Unix(),
	})
}

// randToken returns 32 bytes of URL-safe random — used for the license_key and the
// alive bearer token. crypto/rand failure is fatal-by-panic since a non-random
// security token must never be issued.
func randToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("licenses: crypto/rand failed: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
