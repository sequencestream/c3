package orders

import (
	"context"
	"errors"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/licenses"
)

// Service is the checkout/renewal business layer. It composes the order repository
// with the license service (to resolve and validate the renewal target) and
// enforces the renewal rules — ownership of the target license and the one-year
// term cap — before recording a pending order.
type Service struct {
	repo     *Repo
	licenses *licenses.Service
}

// NewService builds the order service over the order repository and the license
// service used for ownership/term checks.
func NewService(repo *Repo, lic *licenses.Service) *Service {
	return &Service{repo: repo, licenses: lic}
}

// Available reports whether the database is configured.
func (s *Service) Available() bool { return s.repo.Available() }

// RenewalInput is a validated checkout request: the signed-in user, the renewal
// target license, the chosen plan, and the agreement version accepted before
// payment. The amount is never carried — it is derived server-side from the plan.
type RenewalInput struct {
	UserID           int64
	LicenseID        int64
	PlanKey          string
	AgreementVersion string
}

// CreateRenewal records a pending renewal order after enforcing the renewal rules:
// the target must be a license the signed-in user owns (ErrLicenseNotChosen) and
// its term must not already extend beyond the one-year cap (ErrTermCapExceeded).
// It maps the repository's plan/agreement errors to the domain's
// ErrPlanUnavailable / ErrAgreementRequired. The acceptance is timestamped at now.
func (s *Service) CreateRenewal(ctx context.Context, in RenewalInput, now time.Time) (Order, error) {
	bindings, err := s.licenses.ListBindings(ctx, in.UserID)
	if err != nil {
		return Order{}, err
	}
	target, ok := findLicense(bindings, in.LicenseID)
	if !ok {
		return Order{}, ErrLicenseNotChosen
	}
	if target.TermEnd.After(now.AddDate(0, config.MaxLicenseTermAheadMonths, 0)) {
		return Order{}, ErrTermCapExceeded
	}

	order, err := s.repo.Create(ctx, CreateOrderInput{
		UserID:              in.UserID,
		LicenseID:           in.LicenseID,
		PlanKey:             in.PlanKey,
		AgreementVersion:    in.AgreementVersion,
		AgreementAcceptedAt: now,
	}, func() string { return NewOrderNo(time.Now()) })
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Order{}, ErrPlanUnavailable
		}
		return Order{}, err
	}
	return order, nil
}

// Status returns the status of the named order scoped to the signed-in user, and
// whether such an order exists. Backs the checkout page's payment-confirmation poll.
func (s *Service) Status(ctx context.Context, userID int64, orderNo string) (string, bool, error) {
	return s.repo.StatusByNo(ctx, userID, orderNo)
}

// ListPaid returns the signed-in user's paid orders, newest first.
func (s *Service) ListPaid(ctx context.Context, userID int64) ([]Order, error) {
	return s.repo.PaidByUser(ctx, userID)
}

// findLicense returns the user's license with licenseID, if present.
func findLicense(ls []licenses.LicenseBinding, licenseID int64) (licenses.LicenseBinding, bool) {
	for _, l := range ls {
		if l.ID == licenseID {
			return l, true
		}
	}
	return licenses.LicenseBinding{}, false
}
