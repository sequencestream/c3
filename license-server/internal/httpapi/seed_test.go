package httpapi

import (
	"context"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/licenses"
	"github.com/sequencestream/code-creative-center/license-server/internal/orders"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/users"
)

// seeder lets DB-backed HTTP tests plant fixtures directly, mirroring the
// production per-domain repositories over one store handle. Its methods carry the
// pre-refactor names so the integration tests read unchanged apart from the
// receiver, while delegating to the owning domain repository.
type seeder struct {
	plans    *plans.Repo
	licenses *licenses.Repo
	users    *users.Repo
	orders   *orders.Repo
}

// newSeeder builds the seeding repositories over the shared store handle, wired
// exactly as NewServer wires the production ones.
func newSeeder(st *store.Store) *seeder {
	plansRepo := plans.NewRepo(st)
	licensesRepo := licenses.NewRepo(st)
	return &seeder{
		plans:    plansRepo,
		licenses: licensesRepo,
		users:    users.NewRepo(st),
		orders:   orders.NewRepo(st, plansRepo, licensesRepo),
	}
}

func (s *seeder) SeedPlans(ctx context.Context, recs []plans.Record) error {
	return s.plans.Seed(ctx, recs)
}

func (s *seeder) UpsertUser(ctx context.Context, githubID int64, login, email string) (int64, error) {
	return s.users.Upsert(ctx, githubID, login, email)
}

func (s *seeder) EnsureLicenseForUser(ctx context.Context, userID int64, termDays int, now time.Time, newKey func() string) (licenses.License, bool, error) {
	return s.licenses.EnsureForUser(ctx, userID, termDays, now, newKey)
}

func (s *seeder) ListLicensesByUser(ctx context.Context, userID int64) ([]licenses.License, error) {
	return s.licenses.ListByUser(ctx, userID)
}

func (s *seeder) BindInstallation(ctx context.Context, licenseKey, installID string, now time.Time, newAlive func() string) (licenses.BindResult, error) {
	return s.licenses.BindInstallation(ctx, licenseKey, installID, now, newAlive)
}

func (s *seeder) OrdersByUser(ctx context.Context, userID int64) ([]orders.Order, error) {
	return s.orders.ByUser(ctx, userID)
}

func (s *seeder) CreateOrder(ctx context.Context, in orders.CreateOrderInput, newOrderNo func() string) (orders.Order, error) {
	return s.orders.Create(ctx, in, newOrderNo)
}

func (s *seeder) MarkOrderPaid(ctx context.Context, orderNo, paymentRef string, now time.Time) (orders.Order, bool, error) {
	return s.orders.MarkPaid(ctx, orderNo, paymentRef, now)
}

func (s *seeder) OrderByID(ctx context.Context, id int64) (orders.Order, error) {
	return s.orders.ByID(ctx, id)
}
