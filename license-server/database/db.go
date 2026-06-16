// Package lsdb owns the license-server PostgreSQL connection and the embedded,
// idempotent schema migrations. It is rooted at license-server/database/ so the
// LS data lives entirely separate from c3's existing database/ area (ADR-0026).
package lsdb

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open connects to PostgreSQL using a pgx-backed database/sql handle and
// verifies connectivity with a ping.
func Open(ctx context.Context, dsn string) (*sql.DB, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, fmt.Errorf("lsdb: empty database DSN")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("lsdb: open: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("lsdb: ping: %w", err)
	}
	return db, nil
}

// migration is one embedded SQL file.
type migration struct {
	version string // the file name, e.g. "0001_init.sql"
	body    string
}

// loadMigrations reads and sorts the embedded migration files by version.
func loadMigrations(fsys fs.FS) ([]migration, error) {
	entries, err := fs.ReadDir(fsys, "migrations")
	if err != nil {
		return nil, fmt.Errorf("lsdb: read migrations dir: %w", err)
	}
	var out []migration
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		body, err := fs.ReadFile(fsys, "migrations/"+e.Name())
		if err != nil {
			return nil, fmt.Errorf("lsdb: read %s: %w", e.Name(), err)
		}
		out = append(out, migration{version: e.Name(), body: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// pendingMigrations returns, in order, the available versions not yet applied.
// Pure helper, unit-tested without a database.
func pendingMigrations(available []migration, applied map[string]bool) []migration {
	var pending []migration
	for _, m := range available {
		if !applied[m.version] {
			pending = append(pending, m)
		}
	}
	return pending
}

// splitStatements splits a SQL file into individual statements, dropping
// "--" line comments and blank statements. The LS migrations are plain DDL
// (no semicolons inside string literals or function bodies), so a semicolon
// split is sufficient and keeps the runner driver-agnostic.
func splitStatements(sqlText string) []string {
	var b strings.Builder
	for _, line := range strings.Split(sqlText, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "--") {
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	var stmts []string
	for _, part := range strings.Split(b.String(), ";") {
		if s := strings.TrimSpace(part); s != "" {
			stmts = append(stmts, s)
		}
	}
	return stmts
}

// Migrate applies every embedded migration not yet recorded in
// schema_migrations, each in its own transaction, in version order. It is safe
// to call on every startup: already-applied migrations are skipped and the DDL
// itself is idempotent (IF NOT EXISTS).
func Migrate(ctx context.Context, db *sql.DB) error {
	return migrateFS(ctx, db, migrationsFS)
}

func migrateFS(ctx context.Context, db *sql.DB, fsys fs.FS) error {
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("lsdb: ensure schema_migrations: %w", err)
	}

	applied, err := appliedVersions(ctx, db)
	if err != nil {
		return err
	}
	available, err := loadMigrations(fsys)
	if err != nil {
		return err
	}

	for _, m := range pendingMigrations(available, applied) {
		if err := applyMigration(ctx, db, m); err != nil {
			return fmt.Errorf("lsdb: apply %s: %w", m.version, err)
		}
	}
	return nil
}

func appliedVersions(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("lsdb: query applied: %w", err)
	}
	defer rows.Close()
	applied := map[string]bool{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("lsdb: scan applied: %w", err)
		}
		applied[v] = true
	}
	return applied, rows.Err()
}

func applyMigration(ctx context.Context, db *sql.DB, m migration) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	for _, stmt := range splitStatements(m.body) {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations(version) VALUES ($1)`, m.version); err != nil {
		return err
	}
	return tx.Commit()
}
