-- create_database.sql — bootstrap the license-server PostgreSQL database + role.
--
-- This is a ONE-TIME bootstrap script, run by an operator (or local dev) as a
-- PostgreSQL superuser BEFORE the service ever starts. It is deliberately NOT in
-- sql/ and is NOT embedded into the binary: lsdb.EnsureSchema only owns the
-- in-database table DDL (sql/<table>.sql) and runs against an already-created
-- database. CREATE DATABASE / CREATE ROLE cannot run inside a transaction and
-- have no IF NOT EXISTS, so we make the script idempotent with psql's \gexec.
--
-- Run it with psql connected to an existing maintenance database (e.g. postgres):
--   psql "postgres://postgres:<pw>@localhost:5432/postgres" -f create_database.sql
--
-- Afterwards point the service at the new database:
--   export C3_LS_DATABASE_URL='postgres://c3_ls:c3_ls@localhost:5432/c3_ls?sslmode=disable'
-- and the per-table schema is applied automatically on startup (lsdb.EnsureSchema).

-- 1. Login role that owns the database. Idempotent: only created when absent.
--    NOTE: change the password for any non-local deployment.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'c3_ls') THEN
        CREATE ROLE c3_ls LOGIN PASSWORD 'c3_ls';
    END IF;
END$$;

-- 2. The database, owned by the c3_ls role. CREATE DATABASE cannot run inside a
--    transaction or a DO block, so guard it with \gexec: the SELECT emits the
--    CREATE statement only when the database does not yet exist, and \gexec runs
--    whatever the query returned (nothing => no-op on re-run).
SELECT 'CREATE DATABASE c3_ls OWNER c3_ls'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'c3_ls')\gexec

-- 3. Make sure the owner has full rights on its own database (no-op if already so).
GRANT ALL PRIVILEGES ON DATABASE c3_ls TO c3_ls;
