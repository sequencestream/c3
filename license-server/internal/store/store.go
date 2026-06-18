// Package store is the LS database-connection primitive: a thin wrapper around a
// GORM *gorm.DB handle that the per-domain repositories build on. It deliberately
// holds NO CRUD and NO domain types — those live in the owning domain modules
// (users, licenses, orders, plans); store only answers "is a database configured"
// and hands out the live handle (ADR-0026).
//
// A nil DB makes Available report false, so a repository can guard on it rather
// than panicking, and the service degrades to "database not configured" instead
// of crashing the foundation surface.
package store

import "gorm.io/gorm"

// Store wraps a database handle. A nil DB (LS running without a configured
// database) makes Available report false; callers guard on it before reads.
type Store struct {
	db *gorm.DB
}

// New builds a Store. db may be nil when LS runs without a database; callers
// should check Available first.
func New(db *gorm.DB) *Store { return &Store{db: db} }

// Available reports whether a database is configured. It is nil-receiver safe so
// a zero/absent Store still answers cleanly.
func (s *Store) Available() bool { return s != nil && s.db != nil }

// DB returns the live GORM handle for the domain repositories. It is nil when no
// database is configured — repositories call Available first.
func (s *Store) DB() *gorm.DB {
	if s == nil {
		return nil
	}
	return s.db
}
