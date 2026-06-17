package httpapi

import (
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/version"
)

// handleHealth reports service liveness with a redacted configuration view.
// Secrets are NEVER included — only presence indicators (PL-R12). When a
// database is configured, its reachability is reported as a sub-check; an
// unreachable database degrades the check but the foundation service still
// reports a usable status.
func handleHealth(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		checks := map[string]string{}
		if d.DB != nil {
			sqlDB, err := d.DB.DB()
			if err != nil {
				checks["database"] = "unreachable"
			} else if err := sqlDB.PingContext(r.Context()); err != nil {
				checks["database"] = "unreachable"
			} else {
				checks["database"] = "ok"
			}
		} else {
			checks["database"] = "not_configured"
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "healthy",
			"version": version.Version,
			"checks":  checks,
			"config":  d.Config.Redacted(),
		})
	}
}
