// Package store is the LS persistence layer over PostgreSQL (GORM) for the
// simplified license model (ADR-0026): buyers, licenses, and the inline live
// binding (alive_install_id / alive_token / alive_time). It deliberately holds
// no HTTP or domain policy — handlers compose these primitives.
//
// A license is identified to c3 by its random unique license_key. Activation
// binds an installation to a license_key; heartbeats confirm the binding is
// still the live one. Secret discipline (PL-R2/PL-R12): the per-binding alive
// token is stored ONLY as a SHA-256 hash; its plaintext is returned to c3 once,
// at bind, and is never recoverable from the database afterward.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// ErrNotFound is returned when a lookup matches no row (e.g. an unknown
// license_key).
var ErrNotFound = errors.New("store: not found")

// ErrExpired is the terminal license state a bind rejects.
var ErrExpired = errors.New("store: license expired")

// Store wraps a database handle. A nil DB makes every method return an error,
// so a handler can guard on Available rather than panicking.
type Store struct {
	db *gorm.DB
}

// New builds a Store. db may be nil when LS runs without a database; callers
// should check Available first.
func New(db *gorm.DB) *Store { return &Store{db: db} }

// Available reports whether a database is configured.
func (s *Store) Available() bool { return s != nil && s.db != nil }

// HashCode is the one-way hash applied to the alive bearer token before storage.
func HashCode(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// UpsertBuyer inserts or updates a GitHub buyer identity and returns its id.
// GitHub OAuth is used only to log in / register the account here.
func (s *Store) UpsertBuyer(ctx context.Context, githubID int64, login, email string) (int64, error) {
	if !s.Available() {
		return 0, errors.New("store: database not configured")
	}
	var id int64
	err := s.db.WithContext(ctx).Raw(`
		INSERT INTO c3_ls_user (github_id, github_login, email)
		VALUES ($1, $2, NULLIF($3, ''))
		ON CONFLICT (github_id) DO UPDATE
		SET github_login = EXCLUDED.github_login,
		    email = COALESCE(EXCLUDED.email, c3_ls_user.email)
		RETURNING id`, githubID, login, email).Scan(&id).Error
	if err != nil {
		return 0, fmt.Errorf("store: upsert buyer: %w", err)
	}
	return id, nil
}

// Plan is one row of the persisted public plan catalog (a purchasable license
// term). ID is the internal auto-increment identity (0 when not yet persisted);
// PlanID is the stable public identifier; IsTrial marks the free trial plan.
type Plan struct {
	ID             int64
	PlanID         string
	Name           string
	DurationMonths int
	PriceCents     int
	Currency       string
	SortOrder      int
	IsTrial        bool
}

// SeedPlans bootstraps the catalog from the code-owned plan set, inserting any
// missing plan and leaving existing rows untouched (ON CONFLICT DO NOTHING). The
// database thus becomes the live store after the first seed, and an operator edit
// is never clobbered on the next startup. It is safe to call on every boot.
func (s *Store) SeedPlans(ctx context.Context, ps []Plan) error {
	if !s.Available() {
		return errors.New("store: database not configured")
	}
	if len(ps) == 0 {
		return nil
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, p := range ps {
			if err := tx.Exec(`
				INSERT INTO c3_ls_plan (plan_id, name, duration_months, price_cents, currency, sort_order, is_trial)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (plan_id) DO NOTHING`,
				p.PlanID, p.Name, p.DurationMonths, p.PriceCents, p.Currency, p.SortOrder, p.IsTrial).Error; err != nil {
				return fmt.Errorf("store: seed plan %q: %w", p.PlanID, err)
			}
		}
		return nil
	})
}

// planRow is the raw select shape for a catalog row; mapped to Plan.
type planRow struct {
	ID             int64
	PlanID         string
	Name           string
	DurationMonths int
	PriceCents     int
	Currency       string
	SortOrder      int
	IsTrial        bool
}

func (r planRow) toPlan() Plan {
	return Plan{
		ID:             r.ID,
		PlanID:         r.PlanID,
		Name:           r.Name,
		DurationMonths: r.DurationMonths,
		PriceCents:     r.PriceCents,
		Currency:       r.Currency,
		SortOrder:      r.SortOrder,
		IsTrial:        r.IsTrial,
	}
}

// ListPlans returns the persisted catalog ordered for stable display (by
// sort_order, then plan_id as a tiebreaker).
func (s *Store) ListPlans(ctx context.Context) ([]Plan, error) {
	if !s.Available() {
		return nil, errors.New("store: database not configured")
	}
	var rows []planRow
	res := s.db.WithContext(ctx).Raw(`
		SELECT id, plan_id, name, duration_months, price_cents, currency, sort_order, is_trial
		FROM c3_ls_plan
		ORDER BY sort_order, plan_id`).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("store: list plans: %w", res.Error)
	}
	out := make([]Plan, len(rows))
	for i, r := range rows {
		out[i] = r.toPlan()
	}
	return out, nil
}

// FirstTrialPlan returns the first trial plan (is_trial = true), ordered by
// sort_order then id, and whether one exists. With no trial plan configured the
// caller issues no trial license and the buyer must purchase one.
func (s *Store) FirstTrialPlan(ctx context.Context) (Plan, bool, error) {
	if !s.Available() {
		return Plan{}, false, errors.New("store: database not configured")
	}
	var r planRow
	res := s.db.WithContext(ctx).Raw(`
		SELECT id, plan_id, name, duration_months, price_cents, currency, sort_order, is_trial
		FROM c3_ls_plan
		WHERE is_trial = true
		ORDER BY sort_order, id
		LIMIT 1`).Scan(&r)
	if res.Error != nil {
		return Plan{}, false, fmt.Errorf("store: first trial plan: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return Plan{}, false, nil
	}
	return r.toPlan(), true, nil
}

// License is the entitlement row (the subset the bind/heartbeat flow needs).
// PlanID references the granted plan (c3_ls_plan.id).
type License struct {
	ID         int64
	UserID     int64
	PlanID     int64
	LicenseKey string
	Status     string
	TermStart  time.Time
	TermEnd    time.Time
}

// licenseRow is the raw select shape; mapped to License.
type licenseRow struct {
	ID         int64
	UserID     int64
	PlanID     int64
	LicenseKey string
	Status     string
	TermStart  time.Time
	TermEnd    time.Time
}

func (r licenseRow) toLicense() License {
	return License{
		ID:         r.ID,
		UserID:     r.UserID,
		PlanID:     r.PlanID,
		LicenseKey: r.LicenseKey,
		Status:     r.Status,
		TermStart:  r.TermStart,
		TermEnd:    r.TermEnd,
	}
}

// EnsureLicenseForBuyer returns the buyer's most recent active, unexpired
// license, or issues a fresh one (new unique license_key, default term) when the
// buyer has none. GitHub login lands here so a newly-registered buyer leaves with
// a key to bind. newKey generates a random license_key; a unique collision is
// retried. Returns the license and whether it was newly issued.
func (s *Store) EnsureLicenseForBuyer(ctx context.Context, buyerID int64, planID int64, termDays int, now time.Time, newKey func() string) (License, bool, error) {
	if !s.Available() {
		return License{}, false, errors.New("store: database not configured")
	}

	var existing licenseRow
	res := s.db.WithContext(ctx).Raw(`
		SELECT id, user_id, plan_id, license_key, status, term_start, term_end
		FROM c3_ls_license
		WHERE user_id = $1 AND status = 'active' AND term_end > $2
		ORDER BY term_end DESC
		LIMIT 1`, buyerID, now).Scan(&existing)
	if res.Error != nil {
		return License{}, false, fmt.Errorf("store: find buyer license: %w", res.Error)
	}
	if res.RowsAffected > 0 {
		return existing.toLicense(), false, nil
	}

	termStart := now
	termEnd := now.AddDate(0, 0, termDays)
	var inserted licenseRow
	var lastErr error
	for range 5 {
		res := s.db.WithContext(ctx).Raw(`
			INSERT INTO c3_ls_license (user_id, plan_id, license_key, status, term_start, term_end)
			VALUES ($1, $2, $3, 'active', $4, $5)
			RETURNING id, user_id, plan_id, license_key, status, term_start, term_end`,
			buyerID, planID, newKey(), termStart, termEnd).Scan(&inserted)
		if res.Error == nil && res.RowsAffected > 0 {
			return inserted.toLicense(), true, nil
		}
		lastErr = res.Error // unique collision on license_key: retry with a new key
	}
	return License{}, false, fmt.Errorf("store: issue license: %w", lastErr)
}

// ListLicensesByBuyer returns every license a buyer owns, newest first, for the
// post-login page that shows the buyer their license_key(s).
func (s *Store) ListLicensesByBuyer(ctx context.Context, buyerID int64) ([]License, error) {
	if !s.Available() {
		return nil, errors.New("store: database not configured")
	}
	var rows []licenseRow
	res := s.db.WithContext(ctx).Raw(`
		SELECT id, user_id, plan_id, license_key, status, term_start, term_end
		FROM c3_ls_license
		WHERE user_id = $1
		ORDER BY created_at DESC`, buyerID).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("store: list licenses: %w", res.Error)
	}
	out := make([]License, len(rows))
	for i, r := range rows {
		out[i] = r.toLicense()
	}
	return out, nil
}

// BindResult is what a successful bind produces.
type BindResult struct {
	License License
	// AliveToken is the plaintext per-binding validity token, returned to c3
	// exactly once; only its hash is persisted.
	AliveToken string
}

// BindInstallation binds installID to the license identified by licenseKey,
// rotating the alive token (so any prior binding's token stops validating) and
// recording the install as the exclusive live one. Rebinding to a different
// installation overwrites the previous binding — the displaced c3 discovers it on
// its next heartbeat ("one license, one installation"). Rejects an unknown key
// (ErrNotFound) or a non-active/expired license (ErrExpired — status not 'active'
// or term lapsed) and changes nothing. newAlive returns a fresh random plaintext
// token.
func (s *Store) BindInstallation(ctx context.Context, licenseKey, installID string, now time.Time, newAlive func() string) (BindResult, error) {
	if !s.Available() {
		return BindResult{}, errors.New("store: database not configured")
	}

	var out BindResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var locked struct {
			ID      int64
			UserID  int64
			PlanID  int64
			Status  string
			TermEnd time.Time
		}
		res := tx.Raw(`
			SELECT id, user_id, plan_id, status, term_end
			FROM c3_ls_license
			WHERE license_key = $1
			FOR UPDATE`, licenseKey).Scan(&locked)
		if res.Error != nil {
			return fmt.Errorf("store: lock license: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrNotFound
		}
		// status != 'active' (e.g. an admin force-expired it) or a lapsed term ⇒ expired.
		if locked.Status != "active" || !now.Before(locked.TermEnd) {
			return ErrExpired
		}

		alive := newAlive()
		if err := tx.Exec(`
			UPDATE c3_ls_license
			SET alive_install_id = $2, alive_token = $3, alive_time = $4, updated_at = $4
			WHERE id = $1`, locked.ID, installID, HashCode(alive), now).Error; err != nil {
			return fmt.Errorf("store: bind installation: %w", err)
		}

		out = BindResult{
			License: License{
				ID:         locked.ID,
				UserID:     locked.UserID,
				PlanID:     locked.PlanID,
				LicenseKey: licenseKey,
				Status:     "active",
				TermStart:  now,
				TermEnd:    locked.TermEnd,
			},
			AliveToken: alive,
		}
		return nil
	})
	if err != nil {
		return BindResult{}, err
	}
	return out, nil
}

// Heartbeat statuses returned to c3. Only HeartbeatActive entitles new work;
// the rest gate it (PL-R6/PL-R8).
const (
	HeartbeatActive   = "active"
	HeartbeatExpired  = "expired"
	HeartbeatDisabled = "disabled" // the license was rebound to another installation
)

// HeartbeatResult is the verdict for one heartbeat; License is meaningful only
// when Status == HeartbeatActive (a refreshed entitlement is minted from it).
type HeartbeatResult struct {
	Status  string
	License License
}

// Heartbeat confirms the live binding for licenseKey. It is active only when the
// presented install id AND alive token both match the current binding and the
// license is active and unexpired; a successful heartbeat refreshes alive_time.
// A different install/token ⇒ HeartbeatDisabled (the license moved to another
// c3); a non-active status or a lapsed term ⇒ HeartbeatExpired. An unknown
// license_key returns ErrNotFound.
func (s *Store) Heartbeat(ctx context.Context, licenseKey, installID, aliveTokenPlain string, now time.Time) (HeartbeatResult, error) {
	if !s.Available() {
		return HeartbeatResult{}, errors.New("store: database not configured")
	}

	var out HeartbeatResult
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var locked struct {
			ID             int64
			UserID         int64
			PlanID         int64
			Status         string
			AliveInstallID *string
			AliveToken     *string
			TermStart      time.Time
			TermEnd        time.Time
		}
		res := tx.Raw(`
			SELECT id, user_id, plan_id, status, alive_install_id, alive_token, term_start, term_end
			FROM c3_ls_license
			WHERE license_key = $1
			FOR UPDATE`, licenseKey).Scan(&locked)
		if res.Error != nil {
			return fmt.Errorf("store: lock license: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrNotFound
		}

		switch {
		case locked.Status != "active" || !now.Before(locked.TermEnd):
			// status != 'active' (e.g. an admin force-expired it) or a lapsed term.
			out = HeartbeatResult{Status: HeartbeatExpired}
			return nil
		case locked.AliveInstallID == nil || *locked.AliveInstallID != installID ||
			locked.AliveToken == nil || *locked.AliveToken != HashCode(aliveTokenPlain):
			// Bound elsewhere, or this binding was superseded by a newer one.
			out = HeartbeatResult{Status: HeartbeatDisabled}
			return nil
		}

		if err := tx.Exec(`UPDATE c3_ls_license SET alive_time = $2, updated_at = $2 WHERE id = $1`, locked.ID, now).Error; err != nil {
			return fmt.Errorf("store: refresh alive_time: %w", err)
		}
		out = HeartbeatResult{
			Status: HeartbeatActive,
			License: License{
				ID:         locked.ID,
				UserID:     locked.UserID,
				PlanID:     locked.PlanID,
				LicenseKey: licenseKey,
				Status:     "active",
				TermStart:  locked.TermStart,
				TermEnd:    locked.TermEnd,
			},
		}
		return nil
	})
	if err != nil {
		return HeartbeatResult{}, err
	}
	return out, nil
}
