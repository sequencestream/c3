package users

import (
	"context"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/licenses"
)

// Service is the account sign-in/registration business layer. It composes the user
// repository with the license service so that registration encodes the rule that
// every account owns a default license to bind (§4/§5).
type Service struct {
	repo     *Repo
	licenses *licenses.Service
}

// NewService builds the account service over the user repository and the license
// service used to provision the default license.
func NewService(repo *Repo, lic *licenses.Service) *Service {
	return &Service{repo: repo, licenses: lic}
}

// Register records the GitHub identity (insert or update) and guarantees the
// account owns at least one license, returning the user id. It is the single entry
// point for GitHub sign-in: a new user is created and provisioned; a returning user
// is updated and left with their existing license.
func (s *Service) Register(ctx context.Context, githubID int64, login, email string, now time.Time) (int64, error) {
	userID, err := s.repo.Upsert(ctx, githubID, login, email)
	if err != nil {
		return 0, err
	}
	if _, _, err := s.licenses.EnsureDefault(ctx, userID, now); err != nil {
		return 0, err
	}
	return userID, nil
}
