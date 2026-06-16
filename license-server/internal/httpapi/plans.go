package httpapi

import (
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
)

// plansCacheKey is the single key under which the (static) catalog is cached.
const plansCacheKey = "catalog"

// handlePlans serves the public plan catalog (GET /v1/plans). The catalog is
// read through the plans LRU cache so the same hot read path is exercised that
// license/auth/payment lookups will use.
func handlePlans(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		catalog, _ := d.Caches.Get(cache.NamePlans).GetOrLoad(plansCacheKey, func() (any, error) {
			return plans.All(), nil
		})
		writeJSON(w, http.StatusOK, map[string]any{"plans": catalog})
	}
}
