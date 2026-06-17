package lsdb

import (
	"context"
	"os"
	"testing"
)

func TestLoadSchemaFilesSortedAndEmbedded(t *testing.T) {
	fs, err := loadSchemaFiles(schemaFS)
	if err != nil {
		t.Fatalf("loadSchemaFiles: %v", err)
	}
	if len(fs) == 0 {
		t.Fatal("expected at least one embedded schema file")
	}
	for i := 1; i < len(fs); i++ {
		if fs[i-1].name >= fs[i].name {
			t.Errorf("schema files not sorted: %q before %q", fs[i-1].name, fs[i].name)
		}
	}
}

func TestNoSchemaMigrationsLedger(t *testing.T) {
	fs, err := loadSchemaFiles(schemaFS)
	if err != nil {
		t.Fatalf("loadSchemaFiles: %v", err)
	}
	for _, f := range fs {
		if f.name == "schema_migrations.sql" {
			t.Error("schema_migrations ledger should not exist; schema is applied idempotently without a ledger")
		}
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

func TestSplitStatementsKeepsSemicolonsInLiterals(t *testing.T) {
	// A semicolon inside a quoted COMMENT literal must not split the statement,
	// and a doubled '' escape must keep us inside the string.
	sql := `CREATE TABLE a (id INT);
COMMENT ON COLUMN a.id IS 'bound (exclusive); it''s fine';`
	stmts := splitStatements(sql)
	if len(stmts) != 2 {
		t.Fatalf("got %d statements, want 2: %#v", len(stmts), stmts)
	}
	if stmts[1] != "COMMENT ON COLUMN a.id IS 'bound (exclusive); it''s fine'" {
		t.Errorf("stmt[1] = %q", stmts[1])
	}
}

func TestSplitStatementsDropsCommentsAndBlanks(t *testing.T) {
	if got := splitStatements("-- only a comment\n\n\n"); len(got) != 0 {
		t.Errorf("comment/blank-only input yielded %#v", got)
	}
}

func TestSchemaFilesParseIntoStatements(t *testing.T) {
	fs, err := loadSchemaFiles(schemaFS)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range fs {
		if len(splitStatements(f.body)) == 0 {
			t.Errorf("%s split into 0 statements", f.name)
		}
	}
}

// TestEnsureSchemaIdempotent runs against a real PostgreSQL only when
// C3_LS_TEST_DATABASE_URL is set, and proves a second EnsureSchema is a no-op.
func TestEnsureSchemaIdempotent(t *testing.T) {
	dsn := os.Getenv("C3_LS_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("C3_LS_TEST_DATABASE_URL not set; skipping live schema test")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}()

	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatalf("EnsureSchema (first): %v", err)
	}
	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatalf("EnsureSchema (second, should be idempotent): %v", err)
	}
}
