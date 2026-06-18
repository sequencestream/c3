package licenses

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"gorm.io/gorm"
)

// Repo is the c3_ls_license data access. It owns every read/write of the license
// table, including the inline live binding (alive_install_id / alive_token /
// alive_time) and the term extension applied on order settlement.
type Repo struct {
	st *store.Store
}

// NewRepo builds the license repository over the shared store handle.
func NewRepo(st *store.Store) *Repo { return &Repo{st: st} }

// Available reports whether a database is configured.
func (r *Repo) Available() bool { return r.st.Available() }

// licenseRow is the raw select shape; mapped to License.
type licenseRow struct {
	ID         int64
	UserID     int64
	LicenseKey string
	Status     string
	TermStart  time.Time
	TermEnd    time.Time
}

func (r licenseRow) toLicense() License {
	return License{
		ID:         r.ID,
		UserID:     r.UserID,
		LicenseKey: r.LicenseKey,
		Status:     r.Status,
		TermStart:  r.TermStart,
		TermEnd:    r.TermEnd,
	}
}

// EnsureForUser returns the user's most recent active, unexpired license, or
// issues a fresh one (new unique license_key, default term) when the user has
// none. GitHub login lands here so a newly-registered user leaves with a key to
// bind. newKey generates a random license_key; a unique collision is retried.
// Returns the license and whether it was newly issued.
func (r *Repo) EnsureForUser(ctx context.Context, userID int64, termDays int, now time.Time, newKey func() string) (License, bool, error) {
	if !r.st.Available() {
		return License{}, false, errors.New("licenses: database not configured")
	}
	db := r.st.DB()

	var existing licenseRow
	res := db.WithContext(ctx).Raw(`
		SELECT id, user_id, license_key, status, term_start, term_end
		FROM c3_ls_license
		WHERE user_id = $1 AND status = 'active' AND term_end > $2
		ORDER BY term_end DESC
		LIMIT 1`, userID, now).Scan(&existing)
	if res.Error != nil {
		return License{}, false, fmt.Errorf("licenses: find user license: %w", res.Error)
	}
	if res.RowsAffected > 0 {
		return existing.toLicense(), false, nil
	}

	termStart := now
	termEnd := now.AddDate(0, 0, termDays)
	var inserted licenseRow
	var lastErr error
	for range 5 {
		res := db.WithContext(ctx).Raw(`
			INSERT INTO c3_ls_license (user_id, license_key, status, term_start, term_end)
			VALUES ($1, $2, 'active', $3, $4)
			RETURNING id, user_id, license_key, status, term_start, term_end`,
			userID, newKey(), termStart, termEnd).Scan(&inserted)
		if res.Error == nil && res.RowsAffected > 0 {
			return inserted.toLicense(), true, nil
		}
		lastErr = res.Error // unique collision on license_key: retry with a new key
	}
	return License{}, false, fmt.Errorf("licenses: issue license: %w", lastErr)
}

// EnsureDefault guarantees the user owns at least one license: it returns the
// user's newest license when any exists, otherwise issues a fresh default one (new
// unique license_key, default term). Called at sign-in so every account has a
// license to bind without manual creation (§4/§5). Reports whether one was created.
func (r *Repo) EnsureDefault(ctx context.Context, userID int64, termDays int, now time.Time, newKey func() string) (License, bool, error) {
	if !r.st.Available() {
		return License{}, false, errors.New("licenses: database not configured")
	}
	var existing licenseRow
	res := r.st.DB().WithContext(ctx).Raw(`
		SELECT id, user_id, license_key, status, term_start, term_end
		FROM c3_ls_license
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT 1`, userID).Scan(&existing)
	if res.Error != nil {
		return License{}, false, fmt.Errorf("licenses: find user license: %w", res.Error)
	}
	if res.RowsAffected > 0 {
		return existing.toLicense(), false, nil
	}
	return r.EnsureForUser(ctx, userID, termDays, now, newKey)
}

// BindingsByUser returns every license a user owns (newest first) with their
// current binding info (alive_install_id, alive_time), for the user self-service
// account page. It never exposes the alive_token hash (PL-R2).
func (r *Repo) BindingsByUser(ctx context.Context, userID int64) ([]LicenseBinding, error) {
	if !r.st.Available() {
		return nil, errors.New("licenses: database not configured")
	}
	var rows []struct {
		ID             int64
		UserID         int64
		LicenseKey     string
		Status         string
		TermStart      time.Time
		TermEnd        time.Time
		AliveInstallID *string
		AliveTime      *time.Time
	}
	res := r.st.DB().WithContext(ctx).Raw(`
		SELECT id, user_id, license_key, status, term_start, term_end,
		       alive_install_id, alive_time
		FROM c3_ls_license
		WHERE user_id = $1
		ORDER BY created_at DESC`, userID).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("licenses: bindings by user: %w", res.Error)
	}
	out := make([]LicenseBinding, len(rows))
	for i, row := range rows {
		out[i] = LicenseBinding{
			ID:             row.ID,
			UserID:         row.UserID,
			LicenseKey:     row.LicenseKey,
			Status:         row.Status,
			TermStart:      row.TermStart,
			TermEnd:        row.TermEnd,
			AliveInstallID: row.AliveInstallID,
			AliveTime:      row.AliveTime,
		}
	}
	return out, nil
}

// ListByUser returns every license a user owns, newest first, for the post-login
// page that shows the user their license_key(s).
func (r *Repo) ListByUser(ctx context.Context, userID int64) ([]License, error) {
	if !r.st.Available() {
		return nil, errors.New("licenses: database not configured")
	}
	var rows []licenseRow
	res := r.st.DB().WithContext(ctx).Raw(`
		SELECT id, user_id, license_key, status, term_start, term_end
		FROM c3_ls_license
		WHERE user_id = $1
		ORDER BY created_at DESC`, userID).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("licenses: list: %w", res.Error)
	}
	out := make([]License, len(rows))
	for i, row := range rows {
		out[i] = row.toLicense()
	}
	return out, nil
}

// BindInstallation binds installID to the license identified by licenseKey,
// rotating the alive token (so any prior binding's token stops validating) and
// recording the install as the exclusive live one. Rebinding to a different
// installation overwrites the previous binding — the displaced c3 discovers it on
// its next heartbeat ("one license, one installation"). Rejects an unknown key
// (ErrNotFound) or a non-active/expired license (ErrExpired — status not 'active'
// or term lapsed) and changes nothing. newAlive returns a fresh random plaintext
// token.
func (r *Repo) BindInstallation(ctx context.Context, licenseKey, installID string, now time.Time, newAlive func() string) (BindResult, error) {
	if !r.st.Available() {
		return BindResult{}, errors.New("licenses: database not configured")
	}

	var out BindResult
	err := r.st.DB().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var locked struct {
			ID      int64
			UserID  int64
			Status  string
			TermEnd time.Time
		}
		res := tx.Raw(`
			SELECT id, user_id, status, term_end
			FROM c3_ls_license
			WHERE license_key = $1
			FOR UPDATE`, licenseKey).Scan(&locked)
		if res.Error != nil {
			return fmt.Errorf("licenses: lock license: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrNotFound
		}
		// status != 'active' (e.g. an admin force-expired it) or a lapsed term ⇒ expired.
		if locked.Status != "active" || !now.Before(locked.TermEnd) {
			return ErrExpired
		}

		alive := newAlive()
		// Release this installation from any other license it was bound to, so an
		// installation maps to at most one license (heartbeat-by-install is then
		// unambiguous): re-binding the same install to a new license displaces the old.
		if err := tx.Exec(`
			UPDATE c3_ls_license
			SET alive_install_id = NULL, alive_token = NULL, updated_at = $2
			WHERE alive_install_id = $1 AND id <> $3`, installID, now, locked.ID).Error; err != nil {
			return fmt.Errorf("licenses: release prior binding: %w", err)
		}
		if err := tx.Exec(`
			UPDATE c3_ls_license
			SET alive_install_id = $2, alive_token = $3, alive_time = $4, updated_at = $4
			WHERE id = $1`, locked.ID, installID, HashCode(alive), now).Error; err != nil {
			return fmt.Errorf("licenses: bind installation: %w", err)
		}

		out = BindResult{
			License: License{
				ID:         locked.ID,
				UserID:     locked.UserID,
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

// HeartbeatByInstall confirms the live binding identified by the alive token,
// presented together with the installation id (no license_key — the c3 heartbeat
// carries only installId + aliveToken). The binding is found by the alive token's
// hash (effectively unique per bind). Outcomes:
//   - token matches no live binding (rotated away by a re-bind, or never valid)
//     ⇒ HeartbeatDisabled — the c3 gates and cannot recover offline (PL-R8);
//   - token bound to a different installation ⇒ HeartbeatDisabled;
//   - non-active status or a lapsed term ⇒ HeartbeatExpired;
//   - otherwise HeartbeatActive, refreshing alive_time and yielding the license
//     so a fresh entitlement token is minted.
func (r *Repo) HeartbeatByInstall(ctx context.Context, installID, aliveTokenPlain string, now time.Time) (HeartbeatResult, error) {
	if !r.st.Available() {
		return HeartbeatResult{}, errors.New("licenses: database not configured")
	}

	var out HeartbeatResult
	err := r.st.DB().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var locked struct {
			ID             int64
			UserID         int64
			LicenseKey     string
			Status         string
			AliveInstallID *string
			TermStart      time.Time
			TermEnd        time.Time
		}
		res := tx.Raw(`
			SELECT id, user_id, license_key, status, alive_install_id, term_start, term_end
			FROM c3_ls_license
			WHERE alive_token = $1
			FOR UPDATE`, HashCode(aliveTokenPlain)).Scan(&locked)
		if res.Error != nil {
			return fmt.Errorf("licenses: lock license: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			// Token matches no live binding: superseded by a re-bind, or invalid.
			out = HeartbeatResult{Status: HeartbeatDisabled}
			return nil
		}

		switch {
		case locked.AliveInstallID == nil || *locked.AliveInstallID != installID:
			// Token used from an installation that does not hold this binding.
			out = HeartbeatResult{Status: HeartbeatDisabled}
			return nil
		case locked.Status != "active" || !now.Before(locked.TermEnd):
			// status != 'active' (e.g. an admin force-expired it) or a lapsed term.
			out = HeartbeatResult{Status: HeartbeatExpired}
			return nil
		}

		if err := tx.Exec(`UPDATE c3_ls_license SET alive_time = $2, updated_at = $2 WHERE id = $1`, locked.ID, now).Error; err != nil {
			return fmt.Errorf("licenses: refresh alive_time: %w", err)
		}
		out = HeartbeatResult{
			Status: HeartbeatActive,
			License: License{
				ID:         locked.ID,
				UserID:     locked.UserID,
				LicenseKey: locked.LicenseKey,
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

// ExtendTermTx pushes a license's term_end out by months whole months from
// whichever is later — now or the current term_end — and reactivates it, within an
// existing transaction. The order-settlement path (orders.Repo.MarkPaid) calls it
// so the order transition and the license extension commit atomically (§5).
func (r *Repo) ExtendTermTx(tx *gorm.DB, licenseID int64, months int, now time.Time) error {
	if err := tx.Exec(`
		UPDATE c3_ls_license
		SET term_end = GREATEST(term_end, $2) + make_interval(months => $3),
		    status = 'active',
		    updated_at = $2
		WHERE id = $1`, licenseID, now, months).Error; err != nil {
		return fmt.Errorf("licenses: extend term: %w", err)
	}
	return nil
}
