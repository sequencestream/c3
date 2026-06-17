// Package lsdb owns the license-server PostgreSQL connection and the embedded,
// idempotent schema DDL. It is rooted at license-server/database/ so the LS data
// lives entirely separate from c3's existing database/ area (ADR-0026).
//
// There is intentionally no migration ledger: the schema is a set of per-table
// DDL files under sql/, every one written with IF NOT EXISTS, applied in full on
// every startup. Re-running is a no-op, so a separate schema_migrations table to
// track "what has been applied" would only add moving parts for no benefit. To
// evolve a table, edit its sql/<table>.sql (additively — new columns/indexes
// stay IF NOT EXISTS so existing databases converge on the next start).
package lsdb

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

//go:embed sql/*.sql
var schemaFS embed.FS

// Open connects to PostgreSQL through GORM and verifies connectivity with a
// ping on the underlying driver connection.
func Open(ctx context.Context, dsn string) (*gorm.DB, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, fmt.Errorf("lsdb: empty database DSN")
	}
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, fmt.Errorf("lsdb: open: %w", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("lsdb: driver db: %w", err)
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("lsdb: ping: %w", err)
	}
	return db, nil
}

// schemaFile is one embedded per-table DDL file.
type schemaFile struct {
	name string // the file name, e.g. "user.sql"
	body string
}

// loadSchemaFiles reads and sorts the embedded DDL files by name. The order is
// deterministic for stable logs; correctness does not depend on it, since the LS
// tables carry no foreign keys (relationships are enforced in business logic).
func loadSchemaFiles(fsys fs.FS) ([]schemaFile, error) {
	entries, err := fs.ReadDir(fsys, "sql")
	if err != nil {
		return nil, fmt.Errorf("lsdb: read sql dir: %w", err)
	}
	var out []schemaFile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		body, err := fs.ReadFile(fsys, "sql/"+e.Name())
		if err != nil {
			return nil, fmt.Errorf("lsdb: read %s: %w", e.Name(), err)
		}
		out = append(out, schemaFile{name: e.Name(), body: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
}

// splitStatements splits a SQL file into individual statements, dropping
// "--" line comments and blank statements. The LS DDL is plain (no semicolons
// inside string literals or function bodies), so a semicolon split is sufficient
// and keeps the runner driver-agnostic.
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

// EnsureSchema applies every embedded DDL file, each in its own transaction, in
// name order. It is safe to call on every startup: the DDL is idempotent
// (IF NOT EXISTS), so an already-current database is left unchanged.
func EnsureSchema(ctx context.Context, db *gorm.DB) error {
	return ensureSchemaFS(ctx, db, schemaFS)
}

func ensureSchemaFS(ctx context.Context, db *gorm.DB, fsys fs.FS) error {
	files, err := loadSchemaFiles(fsys)
	if err != nil {
		return err
	}
	for _, f := range files {
		if err := applySchemaFile(ctx, db, f); err != nil {
			return fmt.Errorf("lsdb: apply %s: %w", f.name, err)
		}
	}
	return nil
}

func applySchemaFile(ctx context.Context, db *gorm.DB, f schemaFile) error {
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, stmt := range splitStatements(f.body) {
			if err := tx.Exec(stmt).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
