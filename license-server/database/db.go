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

// splitStatements splits a SQL file into individual statements on semicolons,
// dropping "--" line comments and blank statements. It scans character by
// character so that semicolons and "--" sequences appearing INSIDE single-quoted
// string literals (e.g. table/column COMMENT text) are treated as literal text,
// not as statement terminators or comments. A SQL literal escapes a quote by
// doubling it (”); the simple in-string toggle handles that, since the second
// quote of the pair flips the state straight back to "inside the string".
func splitStatements(sqlText string) []string {
	var stmts []string
	var cur strings.Builder
	inString := false
	inLineComment := false
	runes := []rune(sqlText)
	for i := 0; i < len(runes); i++ {
		c := runes[i]
		switch {
		case inLineComment:
			if c == '\n' {
				inLineComment = false
				cur.WriteByte('\n')
			}
		case inString:
			cur.WriteRune(c)
			if c == '\'' {
				inString = false
			}
		case c == '-' && i+1 < len(runes) && runes[i+1] == '-':
			inLineComment = true
			i++ // consume the second '-'
		case c == '\'':
			inString = true
			cur.WriteRune(c)
		case c == ';':
			if s := strings.TrimSpace(cur.String()); s != "" {
				stmts = append(stmts, s)
			}
			cur.Reset()
		default:
			cur.WriteRune(c)
		}
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		stmts = append(stmts, s)
	}
	return stmts
}

// schemaAdvisoryLockKey is an arbitrary, stable 64-bit key for the
// transaction-level advisory lock that serializes schema application (see
// ensureSchemaFS).
const schemaAdvisoryLockKey int64 = 0x6333_6c73_5f64_6462 // "c3ls_db" packed

// EnsureSchema applies every embedded DDL file in name order, in a single
// advisory-locked transaction (see ensureSchemaFS). It is safe to call on every
// startup and concurrently: the DDL is idempotent (IF NOT EXISTS), so an
// already-current database is left unchanged.
func EnsureSchema(ctx context.Context, db *gorm.DB) error {
	return ensureSchemaFS(ctx, db, schemaFS)
}

func ensureSchemaFS(ctx context.Context, db *gorm.DB, fsys fs.FS) error {
	files, err := loadSchemaFiles(fsys)
	if err != nil {
		return err
	}
	// Apply the whole schema in one transaction guarded by a transaction-level
	// advisory lock. The lock serializes concurrent callers (parallel test
	// binaries against one database, or several instances booting at once):
	// applying the idempotent DDL in parallel otherwise deadlocks on the catalog
	// locks `COMMENT ON` takes. A transaction-level lock runs on the transaction's
	// own connection and auto-releases at commit/rollback, so nothing leaks back
	// into the pool. The DDL stays idempotent (IF NOT EXISTS), so an
	// already-current database commits an empty no-op.
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`SELECT pg_advisory_xact_lock(?)`, schemaAdvisoryLockKey).Error; err != nil {
			return fmt.Errorf("lsdb: acquire schema lock: %w", err)
		}
		for _, f := range files {
			for _, stmt := range splitStatements(f.body) {
				if err := tx.Exec(stmt).Error; err != nil {
					return fmt.Errorf("lsdb: apply %s: %w", f.name, err)
				}
			}
		}
		return nil
	})
}
