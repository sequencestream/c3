/**
 * A last-resort database location for the test run, so a test can never reach the
 * developer's own `~/.c3/c3.db`.
 *
 * `dbPath()` resolves `--db` → `C3_DB_PATH` → `C3_DIR` → `~/.c3/c3.db`. Tests that
 * touch the database set `C3_DB_PATH` to a throwaway file in `beforeEach` and delete
 * it in `afterEach` — but code still in flight after teardown (a pending launch, a
 * subscription callback, a timer) opens the database with all three overrides gone
 * and lands on the real one. That is how a test run writes `auth.policyEpoch` (which
 * invalidates every issued token) and temp-dir rows into a developer's config.
 *
 * So: whenever no explicit override is in place, point `C3_DIR` at a throwaway home.
 * Re-pinned around every test because tests delete these variables themselves, and
 * this file's hooks run outermost — its `afterEach` fires after the test file's own,
 * which is exactly where the leak happens.
 *
 * `C3_TEST_DIR` overrides the location (e.g. `C3_TEST_DIR=/tmp/.c3-test pnpm test`).
 */
import { afterEach, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One home per worker: workers run files in parallel, and a shared fallback file
// would let two of them write the same database at once.
const worker = process.env.VITEST_WORKER_ID ?? '0'
const fallbackHome = join(process.env.C3_TEST_DIR ?? join(tmpdir(), 'c3-test-home'), `w${worker}`)

/** Aim the fallback home at the throwaway dir unless a test named a database.
 *  The directory itself is left uncreated — whoever opens the database creates it,
 *  so a worker that never leaks leaves nothing behind in the temp dir. */
function pinFallbackHome(): void {
  if (process.env.C3_DB_PATH || process.env.C3_DIR) return
  process.env.C3_DIR = fallbackHome
}

pinFallbackHome()
beforeEach(pinFallbackHome)
afterEach(pinFallbackHome)
