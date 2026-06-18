package plans

import "context"

// Service is the catalog read-through used by the public GET /v1/plans surface.
// It reads the persisted catalog (the live source after the first seed) and falls
// back to the code-owned catalog when the database is unavailable, errors, or
// holds no rows (e.g. before the first seed), so the endpoint stays up in degraded
// mode.
type Service struct {
	repo *Repo
}

// NewService builds the catalog service over the plan repository.
func NewService(repo *Repo) *Service { return &Service{repo: repo} }

// Catalog returns the public plan catalog, persisted rows preferred, falling back
// to the code-owned set. The returned plans use the wire-facing [Plan] shape
// (PlanKey carried as ID).
func (s *Service) Catalog(ctx context.Context) []Plan {
	if s.repo != nil && s.repo.st.Available() {
		rows, err := s.repo.List(ctx)
		if err == nil && len(rows) > 0 {
			out := make([]Plan, len(rows))
			for i, p := range rows {
				out[i] = Plan{
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
	return All()
}
