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
	Tier           string `json:"tier"`
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
				Tier:           p.Tier,
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"plans": views})
	}
}

type tierCapabilityView struct {
	Label      string `json:"label"`
	Free       string `json:"free"`
	Paid       string `json:"paid"`
	Enterprise string `json:"enterprise"`
}

type planTierView struct {
	Tier string `json:"tier"`
	Name string `json:"name"`
}

func handlePlanTiers() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"tiers": []planTierView{
				{Tier: "free", Name: "免费版 / Free"},
				{Tier: "paid", Name: "付费版 / Paid"},
				{Tier: "enterprise", Name: "企业版 / Enterprise"},
			},
			"capabilities": []tierCapabilityView{
				{Label: "注册 workspace 数 / Workspaces", Free: "5", Paid: "不限 / Unlimited", Enterprise: "不限 / Unlimited"},
				{Label: "并发活跃 worktree / Active worktrees", Free: "1", Paid: "不限 / Unlimited", Enterprise: "不限 / Unlimited"},
				{Label: "单次讨论参与者(不含主持人) / Discussion participants", Free: "2", Paid: "不限 / Unlimited", Enterprise: "不限 / Unlimited"},
				{Label: "启用中的 schedule / Enabled schedules", Free: "2", Paid: "不限 / Unlimited", Enterprise: "不限 / Unlimited"},
				{Label: "启用 sandbox / Sandbox", Free: "不可 / No", Paid: "可 / Yes", Enterprise: "可 / Yes"},
				{Label: "权限控制 / Permission controls", Free: "基础 / Basic", Paid: "基础 / Basic", Enterprise: "更高级的权限控制(预告) / Advanced controls (preview)"},
				{Label: "价格 / 期限 / Price / Term", Free: "免费、长期 / Free, long-lived", Paid: "见购买页 / See checkout", Enterprise: "见购买页 / See checkout"},
			},
		})
	}
}
