// Package httpapi wires the license-server HTTP surface on the Go standard
// library's net/http ServeMux (no framework — ADR-0026). It mounts the foundation
// endpoints (/healthz, /v1/plans) and serves the embedded Vue frontend with SPA
// fallback for every other route.
package httpapi

import (
	"database/sql"
	"io/fs"
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
)

// Deps are the runtime dependencies of the HTTP surface. DB may be nil when the
// service runs without a configured database (the health endpoint degrades
// rather than failing).
type Deps struct {
	Config *config.Config
	Caches *cache.Registry
	DB     *sql.DB
	Static fs.FS // embedded frontend, rooted at the dist directory
}

// NewServer builds the HTTP handler with every route mounted. API routes are
// registered with method-specific patterns; the catch-all "/" serves static
// assets and falls back to the SPA entry point.
func NewServer(d Deps) http.Handler {
	mux := http.NewServeMux()
	// API routes are registered without a method constraint and enforce the
	// method in-handler: the catch-all "/" (needed for SPA fallback) overlaps
	// every path, so relying on the mux's method matching would mask a wrong
	// method as a static 404 instead of a clean 405.
	mux.HandleFunc("/healthz", allowGET(handleHealth(d)))
	mux.HandleFunc("/v1/plans", allowGET(handlePlans(d)))
	mux.Handle("/", staticHandler(d.Static))
	return mux
}

// allowGET wraps a handler so a non-GET request gets a JSON 405 rather than
// falling through to the static/SPA catch-all.
func allowGET(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only GET is allowed")
			return
		}
		h(w, r)
	}
}
