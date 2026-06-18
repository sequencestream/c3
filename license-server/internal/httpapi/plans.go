package httpapi

import (
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
)

// plansCacheKey is the single key under which the catalog is cached.
const plansCacheKey = "catalog"

// planView is the public wire shape of a plan. PlanKey (the stable identifier) is
// named `planKey` on the wire (§10), distinct from plans.Plan's internal `id`.
type planView struct {
	PlanKey        string `json:"planKey"`
	Name           string `json:"name"`
	DurationMonths int    `json:"durationMonths"`
	PriceCents     int    `json:"priceCents"`
	Currency       string `json:"currency"`
}

// handlePlans serves the public plan catalog (GET /v1/plans). The catalog is read
// through the plans LRU cache so the same hot read path is exercised that
// license/auth/payment lookups will use. The plans service is the source: the
// persisted c3_ls_plan table, falling back to the code-owned catalog when the
// database is unavailable so the endpoint stays up in degraded mode.
func handlePlans(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		catalog, _ := d.Caches.Get(cache.NamePlans).GetOrLoad(plansCacheKey, func() (any, error) {
			return d.plans.Catalog(r.Context()), nil
		})
		ps, _ := catalog.([]plans.Plan)
		views := make([]planView, len(ps))
		for i, p := range ps {
			views[i] = planView{
				PlanKey:        p.ID,
				Name:           p.Name,
				DurationMonths: p.DurationMonths,
				PriceCents:     p.PriceCents,
				Currency:       p.Currency,
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"plans": views})
	}
}
