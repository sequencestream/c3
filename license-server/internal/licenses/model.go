// Package licenses is the LS license domain: the entitlement record (c3_ls_license)
// plus the binding/heartbeat business flow. It owns every read/write of the
// license table (the Repo) and the activation/bind/heartbeat orchestration (the
// Service), including minting the offline-verifiable entitlement token and the
// process-internal pending-bind registry.
//
// A license is identified to c3 by its random unique license_key. Activation binds
// an installation to a license_key; heartbeats confirm the binding is still the
// live one. Secret discipline (PL-R2/PL-R12): the per-binding alive token is stored
// ONLY as a SHA-256 hash; its plaintext is returned to c3 once, at bind, and is
// never recoverable from the database afterward.
package licenses

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"
)

// ErrNotFound is returned when a lookup matches no row (e.g. an unknown
// license_key).
var ErrNotFound = errors.New("licenses: not found")

// ErrExpired is the terminal license state a bind rejects.
var ErrExpired = errors.New("licenses: license expired")

// ErrNotOwned is returned by the bind service when the chosen license_key does not
// belong to the signed-in user.
var ErrNotOwned = errors.New("licenses: license not owned by user")

// Heartbeat statuses returned to c3. Only HeartbeatActive entitles new work; the
// rest gate it (PL-R6/PL-R8).
const (
	HeartbeatActive   = "active"
	HeartbeatExpired  = "expired"
	HeartbeatDisabled = "disabled" // the license was rebound to another installation
)

// HashCode is the one-way hash applied to the alive bearer token before storage.
func HashCode(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// License is the entitlement row (the subset the bind/heartbeat flow needs). The
// purchased plan is not carried here — it lives on the order (c3_ls_order.plan_key)
// that funded the term, not on the license.
type License struct {
	ID         int64
	UserID     int64
	LicenseKey string
	Status     string
	TermStart  time.Time
	TermEnd    time.Time
}

// LicenseBinding is a license with its current binding info (alive_install_id and
// alive_time). It is the shape used for the user self-service account page. The
// alive_token is intentionally excluded: it is stored only as a one-way hash and
// must never be returned to a page (PL-R2).
type LicenseBinding struct {
	ID             int64
	UserID         int64
	LicenseKey     string
	Status         string
	TermStart      time.Time
	TermEnd        time.Time
	AliveInstallID *string    // nil when no installation is bound
	AliveTime      *time.Time // nil when no binding has ever heartbeaten
}

// BindResult is what a successful bind produces.
type BindResult struct {
	License License
	// AliveToken is the plaintext per-binding validity token, returned to c3
	// exactly once; only its hash is persisted.
	AliveToken string
}

// HeartbeatResult is the verdict for one heartbeat; License is meaningful only
// when Status == HeartbeatActive (a refreshed entitlement is minted from it).
type HeartbeatResult struct {
	Status  string
	License License
}
