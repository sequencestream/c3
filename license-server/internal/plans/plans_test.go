package plans

import "testing"

func TestCatalogIsTheThreeMVPPlans(t *testing.T) {
	got := All()
	want := []Plan{
		{ID: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY"},
		{ID: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY"},
		{ID: "1y", Name: "1 Year", DurationMonths: 12, PriceCents: 1090, Currency: "CNY"},
	}
	if len(got) != len(want) {
		t.Fatalf("All() len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("plan[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestPricesAreStable(t *testing.T) {
	cases := map[string]int{"1m": 100, "6m": 590, "1y": 1090}
	for id, price := range cases {
		p, ok := ByID(id)
		if !ok {
			t.Errorf("ByID(%q) not found", id)
			continue
		}
		if p.PriceCents != price {
			t.Errorf("plan %q price = %d, want %d", id, p.PriceCents, price)
		}
	}
}

func TestByIDUnknown(t *testing.T) {
	if _, ok := ByID("nope"); ok {
		t.Error("ByID(nope) should not be found")
	}
}

func TestAllReturnsCopy(t *testing.T) {
	a := All()
	a[0].PriceCents = 999999
	b := All()
	if b[0].PriceCents == 999999 {
		t.Error("All() must return a copy; source catalog was mutated")
	}
}
