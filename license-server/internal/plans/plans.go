// Package plans is the license-server plan catalog — the public, fixed set of
// purchasable license terms. The catalog is code-owned (not database-driven) at
// the MVP stage: it is small, stable, and the same for every user, so it ships
// in the binary and is served from /v1/plans.
package plans

// Currency is the ISO-4217 code every plan price is denominated in. WeChat Pay
// settles in CNY (ADR-0026), and prices are expressed in the minor unit (cents).
const Currency = "CNY"

// Plan is one purchasable license term.
type Plan struct {
	// ID is a stable, public identifier safe to persist on orders and to send
	// to clients. It MUST NOT change once published.
	ID string `json:"id"`
	// Name is a short human-readable label.
	Name string `json:"name"`
	// DurationMonths is the license term length in whole months.
	DurationMonths int `json:"durationMonths"`
	// PriceCents is the price in the currency's minor unit (cents).
	PriceCents int `json:"priceCents"`
	// Currency is the ISO-4217 currency code (see [Currency]).
	Currency string `json:"currency"`
}

// catalog is the authoritative MVP plan set. Order is stable (shortest term
// first) so the served list is deterministic.
var catalog = []Plan{
	{ID: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: Currency},
	{ID: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: Currency},
	{ID: "1y", Name: "1 Year", DurationMonths: 12, PriceCents: 1090, Currency: Currency},
}

// All returns a copy of the catalog so callers cannot mutate the source of
// truth.
func All() []Plan {
	out := make([]Plan, len(catalog))
	copy(out, catalog)
	return out
}

// ByID returns the plan with the given id and whether it was found.
func ByID(id string) (Plan, bool) {
	for _, p := range catalog {
		if p.ID == id {
			return p, true
		}
	}
	return Plan{}, false
}
