package lsdb

import (
	"context"
	"os"
	"testing"
)

func TestLoadMigrationsSortedAndEmbedded(t *testing.T) {
	ms, err := loadMigrations(migrationsFS)
	if err != nil {
		t.Fatalf("loadMigrations: %v", err)
	}
	if len(ms) == 0 {
		t.Fatal("expected at least one embedded migration")
	}
	for i := 1; i < len(ms); i++ {
		if ms[i-1].version >= ms[i].version {
			t.Errorf("migrations not sorted: %q before %q", ms[i-1].version, ms[i].version)
		}
	}
	if ms[0].version != "0001_init.sql" {
		t.Errorf("first migration = %q, want 0001_init.sql", ms[0].version)
	}
}

func TestPendingMigrations(t *testing.T) {
	avail := []migration{{version: "0001_init.sql"}, {version: "0002_x.sql"}, {version: "0003_y.sql"}}
	applied := map[string]bool{"0001_init.sql": true, "0002_x.sql": true}
	pending := pendingMigrations(avail, applied)
	if len(pending) != 1 || pending[0].version != "0003_y.sql" {
		t.Errorf("pending = %+v, want [0003_y.sql]", pending)
	}
	if len(pendingMigrations(avail, map[string]bool{})) != 3 {
		t.Error("with nothing applied, all are pending")
	}
	if len(pendingMigrations(avail, map[string]bool{"0001_init.sql": true, "0002_x.sql": true, "0003_y.sql": true})) != 0 {
		t.Error("with all applied, none are pending (idempotent)")
	}
}

func TestSplitStatements(t *testing.T) {
	sql := `
-- a comment
CREATE TABLE a (id INT);

-- another
CREATE TABLE b (id INT);
`
	stmts := splitStatements(sql)
	if len(stmts) != 2 {
		t.Fatalf("got %d statements, want 2: %#v", len(stmts), stmts)
	}
	if stmts[0] != "CREATE TABLE a (id INT)" {
		t.Errorf("stmt[0] = %q", stmts[0])
	}
}

func TestSplitStatementsDropsCommentsAndBlanks(t *testing.T) {
	if got := splitStatements("-- only a comment\n\n\n"); len(got) != 0 {
		t.Errorf("comment/blank-only input yielded %#v", got)
	}
}

func TestInitMigrationParsesIntoStatements(t *testing.T) {
	ms, err := loadMigrations(migrationsFS)
	if err != nil {
		t.Fatal(err)
	}
	stmts := splitStatements(ms[0].body)
	if len(stmts) < 6 {
		t.Errorf("0001_init split into %d statements, expected the core LS tables", len(stmts))
	}
}

// TestMigrateIdempotent runs against a real PostgreSQL only when
// LS_TEST_DATABASE_URL is set, and proves a second Migrate is a no-op.
func TestMigrateIdempotent(t *testing.T) {
	dsn := os.Getenv("LS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("LS_TEST_DATABASE_URL not set; skipping live migration test")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("Migrate (first): %v", err)
	}
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("Migrate (second, should be idempotent): %v", err)
	}

	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	if count == 0 {
		t.Error("expected at least one recorded migration")
	}
}
