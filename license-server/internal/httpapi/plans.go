package httpapi

import (
	"context"
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
)

// plansCacheKey is the single key under which the catalog is cached.
const plansCacheKey = "catalog"

// handlePlans serves the public plan catalog (GET /v1/plans). The catalog is
// read through the plans LRU cache so the same hot read path is exercised that
// license/auth/payment lookups will use. The underlying source is the persisted
// c3_ls_plan table; when the database is unavailable it falls back to the
// code-owned catalog so the endpoint stays up in degraded mode.
// planView is the public wire shape of a plan. PlanKey (the stable identifier)
// is named `planKey` on the wire (§10), distinct from plans.Plan's internal `id`.
type planView struct {
	PlanKey        string `json:"planKey"`
	Name           string `json:"name"`
	DurationMonths int    `json:"durationMonths"`
	PriceCents     int    `json:"priceCents"`
	Currency       string `json:"currency"`
}

func handlePlans(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		catalog, _ := d.Caches.Get(cache.NamePlans).GetOrLoad(plansCacheKey, func() (any, error) {
			return loadCatalog(r.Context(), d), nil
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

// loadCatalog reads the persisted plan catalog, mapping it back to the public
// plans.Plan wire shape. It falls back to the code catalog when the store is
// unavailable, errors, or holds no rows (e.g. before the first seed).
func loadCatalog(ctx context.Context, d Deps) []plans.Plan {
	if d.Store.Available() {
		rows, err := d.Store.ListPlans(ctx)
		if err == nil && len(rows) > 0 {
			out := make([]plans.Plan, len(rows))
			for i, p := range rows {
				out[i] = plans.Plan{
					ID:             p.PlanKey,
					Name:           p.Name,
					DurationMonths: p.DurationMonths,
					PriceCents:     p.PriceCents,
					Currency:       p.Currency,
				}
			}
			return out
		}
	}
	return plans.All()
}
