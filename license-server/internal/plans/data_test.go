package plans

import (
	"context"
	"os"
	"testing"

	lsdb "github.com/sequencestream/code-creative-center/license-server/database"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
)

// liveRepo connects to C3_LS_TEST_DATABASE_URL, migrates, and truncates the LS
// tables so each test starts clean. Skips when no DB is configured.
func liveRepo(t *testing.T) (*Repo, context.Context) {
	t.Helper()
	dsn := os.Getenv("C3_LS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("C3_LS_TEST_DATABASE_URL not set; skipping live store test")
	}
	ctx := context.Background()
	db, err := lsdb.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if err := lsdb.EnsureSchema(ctx, db); err != nil {
		t.Fatalf("ensure schema: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.WithContext(ctx).Exec(
		`TRUNCATE c3_ls_license, c3_ls_order, c3_ls_user, c3_ls_plan RESTART IDENTITY CASCADE`).Error; err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return NewRepo(store.New(db)), ctx
}

func TestSeedAndListPlans(t *testing.T) {
	r, ctx := liveRepo(t)

	seed := []Record{
		{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 100, Currency: "CNY", SortOrder: 0, Tier: "paid"},
		{PlanKey: "6m", Name: "6 Months", DurationMonths: 6, PriceCents: 590, Currency: "CNY", SortOrder: 1, Tier: "paid"},
		{PlanKey: "1y", Name: "1 Year", DurationMonths: 12, PriceCents: 1090, Currency: "CNY", SortOrder: 2, Tier: "paid"},
	}
	if err := r.Seed(ctx, seed); err != nil {
		t.Fatalf("seed plans: %v", err)
	}

	got, err := r.List(ctx)
	if err != nil {
		t.Fatalf("list plans: %v", err)
	}
	if len(got) != len(seed) {
		t.Fatalf("List len = %d, want %d", len(got), len(seed))
	}
	for i := range seed {
		// id is auto-assigned by the database; compare the rest field-for-field.
		if got[i].ID <= 0 {
			t.Errorf("plan[%d] should carry an auto-assigned id, got %d", i, got[i].ID)
		}
		got[i].ID = 0
		if got[i] != seed[i] {
			t.Errorf("plan[%d] = %+v, want %+v", i, got[i], seed[i])
		}
	}

	// Re-seeding with a changed price is a no-op (ON CONFLICT DO NOTHING): the
	// database is the live store after the first seed; operator edits survive.
	bumped := []Record{{PlanKey: "1m", Name: "1 Month", DurationMonths: 1, PriceCents: 999, Currency: "CNY", SortOrder: 0, Tier: "paid"}}
	if err := r.Seed(ctx, bumped); err != nil {
		t.Fatalf("re-seed: %v", err)
	}
	got, err = r.List(ctx)
	if err != nil {
		t.Fatalf("list after re-seed: %v", err)
	}
	if got[0].PriceCents != 100 {
		t.Errorf("re-seed clobbered existing row: price = %d, want 100", got[0].PriceCents)
	}
}
