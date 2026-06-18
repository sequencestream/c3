// Package users is the LS account domain: the GitHub-backed identity record
// (c3_ls_user). It owns every read/write of the user table (the Repo) and the
// sign-in/registration orchestration (the Service), which guarantees every account
// leaves registration with a default license to bind.
//
// GitHub OAuth is used only to log in / register the account here — no GitHub data
// beyond the identity (id, login, email) is persisted.
package users

import (
	"context"
	"errors"
	"fmt"

	"github.com/sequencestream/code-creative-center/license-server/internal/store"
)

// Repo is the c3_ls_user data access. It owns every read/write of the user table.
type Repo struct {
	st *store.Store
}

// NewRepo builds the user repository over the shared store handle.
func NewRepo(st *store.Store) *Repo { return &Repo{st: st} }

// Available reports whether a database is configured.
func (r *Repo) Available() bool { return r.st.Available() }

// Upsert inserts or updates a GitHub user identity and returns its id.
func (r *Repo) Upsert(ctx context.Context, githubID int64, login, email string) (int64, error) {
	if !r.st.Available() {
		return 0, errors.New("users: database not configured")
	}
	var id int64
	err := r.st.DB().WithContext(ctx).Raw(`
		INSERT INTO c3_ls_user (github_id, github_login, email)
		VALUES ($1, $2, NULLIF($3, ''))
		ON CONFLICT (github_id) DO UPDATE
		SET github_login = EXCLUDED.github_login,
		    email = COALESCE(EXCLUDED.email, c3_ls_user.email)
		RETURNING id`, githubID, login, email).Scan(&id).Error
	if err != nil {
		return 0, fmt.Errorf("users: upsert: %w", err)
	}
	return id, nil
}
