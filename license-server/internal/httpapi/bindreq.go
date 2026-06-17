package httpapi

import (
	"sync"
	"time"
)

// bindTTL bounds how long a completed (installId, requestId) binding waits in
// memory for c3 server's checkbind to collect it. It matches the order/payment
// window order of magnitude; a request not collected within it is discarded.
const bindTTL = 15 * time.Minute

// bindEntry is the secret material a completed bind makes available to c3 server
// via checkbind: the plaintext alive token and the signed entitlement token,
// neither of which ever reaches the browser (PL-R2). It is consumed on first
// read.
type bindEntry struct {
	aliveToken       string
	entitlementToken string
	termEnd          int64
	createdAt        time.Time
}

// bindRegistry is the process-wide map from a binding round (installId,
// requestId) to its completed secret material. It is deliberately in-memory and
// not persisted (ADR-0006 process-internal state discipline): a binding round is
// short-lived, and losing it on restart only forces the user to retry the
// browser flow. Entries expire after bindTTL and are consumed on collection.
type bindRegistry struct {
	mu sync.Mutex
	m  map[string]bindEntry
	// now is injectable so tests can drive TTL deterministically.
	now func() time.Time
}

func newBindRegistry() *bindRegistry {
	return &bindRegistry{m: map[string]bindEntry{}, now: time.Now}
}

func bindKey(installID, requestID string) string {
	return installID + "\x00" + requestID
}

// put records the completed binding for (installID, requestID).
func (r *bindRegistry) put(installID, requestID string, e bindEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e.createdAt.IsZero() {
		e.createdAt = r.now()
	}
	r.m[bindKey(installID, requestID)] = e
}

// take returns the completed binding for (installID, requestID) and removes it,
// so a binding's secrets are collected exactly once. A missing or expired entry
// returns ok=false (checkbind then reports "pending").
func (r *bindRegistry) take(installID, requestID string) (bindEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := bindKey(installID, requestID)
	e, ok := r.m[key]
	if !ok {
		return bindEntry{}, false
	}
	delete(r.m, key)
	if r.now().Sub(e.createdAt) > bindTTL {
		return bindEntry{}, false
	}
	return e, true
}
