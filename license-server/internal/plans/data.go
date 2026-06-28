package plans

import (
	"context"
	"errors"
	"fmt"

	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"gorm.io/gorm"
)

// Record is one persisted catalog row (c3_ls_plan). It is the database shape of a
// plan and carries the fields the wire-facing [Plan] omits: the auto-increment
// ID and the SortOrder used for stable display. PlanKey is the stable public
// identifier (the wire `planKey`).
type Record struct {
	ID             int64
	PlanKey        string
	Name           string
	DurationMonths int
	PriceCents     int
	Currency       string
	SortOrder      int
	Tier           string
}

// Repo is the c3_ls_plan data access. It owns every read/write of the persisted
// plan catalog; other modules that need a plan's price or duration go through it.
type Repo struct {
	st *store.Store
}

// NewRepo builds the plan repository over the shared store handle.
func NewRepo(st *store.Store) *Repo { return &Repo{st: st} }

// Available reports whether a database is configured.
func (r *Repo) Available() bool { return r.st.Available() }

// planRow is the raw select shape; mapped to Record.
type planRow struct {
	ID             int64
	PlanKey        string
	Name           string
	DurationMonths int
	PriceCents     int
	Currency       string
	SortOrder      int
	Tier           string
}

func (r planRow) toRecord() Record {
	return Record{
		ID:             r.ID,
		PlanKey:        r.PlanKey,
		Name:           r.Name,
		DurationMonths: r.DurationMonths,
		PriceCents:     r.PriceCents,
		Currency:       r.Currency,
		SortOrder:      r.SortOrder,
		Tier:           normalizeTier(r.Tier),
	}
}

func normalizeTier(tier string) string {
	switch tier {
	case "paid", "enterprise":
		return tier
	default:
		return "paid"
	}
}

// Seed bootstraps the catalog from the code-owned plan set, inserting any missing
// plan and leaving existing rows untouched (ON CONFLICT DO NOTHING). The database
// thus becomes the live store after the first seed, and an operator edit is never
// clobbered on the next startup. It is safe to call on every boot.
func (r *Repo) Seed(ctx context.Context, ps []Record) error {
	if !r.st.Available() {
		return errors.New("plans: database not configured")
	}
	if len(ps) == 0 {
		return nil
	}
	return r.st.DB().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, p := range ps {
			if err := tx.Exec(`
				INSERT INTO c3_ls_plan (plan_key, name, duration_months, price_cents, currency, sort_order, tier)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (plan_key) DO NOTHING`,
				p.PlanKey, p.Name, p.DurationMonths, p.PriceCents, p.Currency, p.SortOrder, normalizeTier(p.Tier)).Error; err != nil {
				return fmt.Errorf("plans: seed plan %q: %w", p.PlanKey, err)
			}
		}
		return nil
	})
}

// List returns the persisted catalog ordered for stable display (by sort_order,
// then plan_key as a tiebreaker).
func (r *Repo) List(ctx context.Context) ([]Record, error) {
	if !r.st.Available() {
		return nil, errors.New("plans: database not configured")
	}
	var rows []planRow
	res := r.st.DB().WithContext(ctx).Raw(`
		SELECT id, plan_key, name, duration_months, price_cents, currency, sort_order, tier
		FROM c3_ls_plan
		ORDER BY sort_order, plan_key`).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("plans: list: %w", res.Error)
	}
	out := make([]Record, len(rows))
	for i, row := range rows {
		out[i] = row.toRecord()
	}
	return out, nil
}

// ByKey returns the persisted catalog plan with the given plan_key and whether it
// exists. It is the server-authoritative price source: the checkout path derives
// an order's amount from the matched plan, never from a client-supplied value
// (PL-R9).
func (r *Repo) ByKey(ctx context.Context, planKey string) (Record, bool, error) {
	if !r.st.Available() {
		return Record{}, false, errors.New("plans: database not configured")
	}
	var row planRow
	res := r.st.DB().WithContext(ctx).Raw(`
		SELECT id, plan_key, name, duration_months, price_cents, currency, sort_order, tier
		FROM c3_ls_plan
		WHERE plan_key = $1`, planKey).Scan(&row)
	if res.Error != nil {
		return Record{}, false, fmt.Errorf("plans: by key: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return Record{}, false, nil
	}
	return row.toRecord(), true, nil
}

// DurationMonthsTx reads a plan's whole-month term length within an existing
// transaction. The order-settlement path (orders.Repo.MarkPaid) calls it to learn
// how far to push a renewed license's term, sharing the caller's tx so the read
// and the license extension commit atomically.
func (r *Repo) DurationMonthsTx(tx *gorm.DB, planKey string) (int, bool, error) {
	var months int
	res := tx.Raw(`SELECT duration_months FROM c3_ls_plan WHERE plan_key = $1`, planKey).Scan(&months)
	if res.Error != nil {
		return 0, false, fmt.Errorf("plans: duration: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return 0, false, nil
	}
	return months, true, nil
}

// ByKeyTx reads a plan row within an existing transaction.
func (r *Repo) ByKeyTx(tx *gorm.DB, planKey string) (Record, bool, error) {
	var row planRow
	res := tx.Raw(`
		SELECT id, plan_key, name, duration_months, price_cents, currency, sort_order, tier
		FROM c3_ls_plan
		WHERE plan_key = $1`, planKey).Scan(&row)
	if res.Error != nil {
		return Record{}, false, fmt.Errorf("plans: by key tx: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return Record{}, false, nil
	}
	return row.toRecord(), true, nil
}

// AnnualPaidPriceCents returns the paid one-year catalog price used for upgrade credit.
func (r *Repo) AnnualPaidPriceCents(ctx context.Context) (int, bool, error) {
	plan, ok, err := r.ByKey(ctx, "1y")
	if err != nil || !ok || plan.Tier != "paid" {
		return 0, ok, err
	}
	return plan.PriceCents, true, nil
}
