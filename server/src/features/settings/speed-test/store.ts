/**
 * Append-only history for model-provider speed tests.
 *
 * A finished run is written ONCE — head row plus every issued request detail, in
 * one transaction — and is never updated or deleted afterwards. That is the whole
 * storage model, and it is deliberate: a run costs real money upstream, so the
 * record of it must not be something a later edit can quietly reshape. Live
 * progress is therefore NOT persisted; it lives in the executor until the run
 * seals. The cost of that choice is stated plainly: a crash mid-run loses the
 * in-memory samples, and no resume is promised. Committed history is unaffected.
 *
 * `provider_id` is a WEAK reference — no foreign key, no cascade, no inner join on
 * read. Deleting a provider must not delete the evidence of how it performed, so
 * the display name is snapshotted at start and the report falls back to it (and
 * finally to the raw id) when the configuration is gone. A new provider that
 * happens to reuse a name does not inherit anything: identity is the id.
 *
 * Availability follows the established store contract — reads degrade to empty,
 * writes throw, so a failed save can never come back as a receipt.
 */
import {
  SPEED_TEST_COMPARE_CHOICE_LIMIT,
  SPEED_TEST_HISTORY_PAGE_SIZE,
  type ProtocolType,
  type SpeedTestApiDialect,
  type SpeedTestComparisonEntry,
  type SpeedTestFailureCategory,
  type SpeedTestHistoryPage,
  type SpeedTestHistoryProvider,
  type SpeedTestOutcome,
  type SpeedTestRequestOutcome,
  type SpeedTestRequestRecord,
  type SpeedTestRun,
  type SpeedTestRunDetail,
  type SpeedTestSummary,
  type SpeedTestTokenCountSource,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../../../kernel/infra/db.js'

// ---- Schema ----

const TABLES = `
CREATE TABLE IF NOT EXISTS model_provider_speed_tests (
  run_id                TEXT    PRIMARY KEY,
  provider_id           TEXT    NOT NULL,
  provider_display_name TEXT    NOT NULL,
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER NOT NULL,
  planned_count         INTEGER NOT NULL,
  completed_count       INTEGER NOT NULL,
  success_count         INTEGER NOT NULL,
  failure_count         INTEGER NOT NULL,
  cancelled_count       INTEGER NOT NULL,
  protocol_type         TEXT    NOT NULL CHECK(protocol_type IN ('openai','anthropic')),
  api_dialect           TEXT    NOT NULL CHECK(api_dialect IN ('chat','responses','messages')),
  model                 TEXT    NOT NULL,
  calibration_version   TEXT    NOT NULL,
  max_output_tokens     INTEGER NOT NULL,
  temperature           REAL    NOT NULL,
  outcome               TEXT    NOT NULL CHECK(outcome IN ('completed','failed','interrupted')),
  summary_json          TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS model_provider_speed_test_requests (
  run_id             TEXT    NOT NULL,
  sequence           INTEGER NOT NULL,
  started_at         INTEGER NOT NULL,
  outcome            TEXT    NOT NULL CHECK(outcome IN ('success','failure','cancelled')),
  failure_category   TEXT    CHECK(failure_category IS NULL OR failure_category IN ('timeout','http','network','stream')),
  http_status        INTEGER,
  ttft_ms            REAL,
  end_to_end_ms      REAL,
  output_tokens      INTEGER,
  token_count_source TEXT    CHECK(token_count_source IS NULL OR token_count_source IN ('usage','delta_estimate')),
  tpot_ms            REAL,
  PRIMARY KEY (run_id, sequence)
);
`

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_speed_test_provider_recent
  ON model_provider_speed_tests(provider_id, started_at DESC, run_id DESC);
`

/** Keyed on the connection: `resetDbForTests` hands out a new one to a new file. */
let schemaReadyFor: Db | null = null

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      d.exec(TABLES)
      d.exec(INDEXES)
    } catch {
      return null
    }
    schemaReadyFor = d
  }
  return d
}

/** Test hook: forget the "schema ensured" connection (pair with `resetDbForTests`). */
export function resetSpeedTestStoreForTests(): void {
  schemaReadyFor = null
}

/**
 * Materialize the tables so an unusable database is discovered BEFORE a run spends
 * the operator's credits. `false` ⇒ refuse to start.
 */
export function ensureSpeedTestSchema(): boolean {
  return db() !== null
}

function tx<T>(d: Db, fn: () => T): T {
  d.exec('BEGIN')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* noop */
    }
    throw err
  }
}

// ---- Rows ----

interface RunRow {
  run_id: string
  provider_id: string
  provider_display_name: string
  started_at: number
  finished_at: number
  planned_count: number
  protocol_type: string
  api_dialect: string
  model: string
  calibration_version: string
  max_output_tokens: number
  temperature: number
  outcome: string
  summary_json: string
}

/** A run row plus the two window columns the comparison query adds. */
interface ComparisonRow extends RunRow {
  run_count: number
  rn: number
}

interface RequestRow {
  sequence: number
  started_at: number
  outcome: string
  failure_category: string | null
  http_status: number | null
  ttft_ms: number | null
  end_to_end_ms: number | null
  output_tokens: number | null
  token_count_source: string | null
  tpot_ms: number | null
}

function toRun(row: RunRow): SpeedTestRun {
  return {
    runId: row.run_id,
    providerId: row.provider_id,
    providerDisplayName: row.provider_display_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    plannedCount: row.planned_count,
    protocolType: row.protocol_type as ProtocolType,
    apiDialect: row.api_dialect as SpeedTestApiDialect,
    model: row.model,
    calibrationVersion: row.calibration_version,
    maxOutputTokens: row.max_output_tokens,
    temperature: row.temperature,
    outcome: row.outcome as SpeedTestOutcome,
    summary: JSON.parse(row.summary_json) as SpeedTestSummary,
  }
}

function toRequest(row: RequestRow): SpeedTestRequestRecord {
  return {
    sequence: row.sequence,
    startedAt: row.started_at,
    outcome: row.outcome as SpeedTestRequestOutcome,
    failureCategory: (row.failure_category as SpeedTestFailureCategory | null) ?? null,
    httpStatus: row.http_status,
    ttftMs: row.ttft_ms,
    endToEndMs: row.end_to_end_ms,
    outputTokens: row.output_tokens,
    tokenCountSource: (row.token_count_source as SpeedTestTokenCountSource | null) ?? null,
    tpotMs: row.tpot_ms,
  }
}

// ---- Write ----

/** A save refused or failed. The caller keeps the in-memory result for a retry. */
export class SpeedTestStoreError extends Error {
  constructor(
    readonly code: 'db_unavailable' | 'write_failed',
    message: string,
  ) {
    super(message)
    this.name = 'SpeedTestStoreError'
  }
}

/**
 * Seal one run: head row plus all issued request details, in a single transaction.
 *
 * Idempotent by `runId` — a retried save after a failed commit, or a duplicate
 * seal from a race, finds the row already there and does nothing rather than
 * writing a second history entry for one execution. Returns whether this call was
 * the one that inserted.
 */
export function saveSpeedTestRun(detail: SpeedTestRunDetail): boolean {
  const d = db()
  if (!d) throw new SpeedTestStoreError('db_unavailable', 'speed test history is unavailable')
  const { run, requests } = detail
  try {
    return tx(d, () => {
      const existing = d.get<{ run_id: string }>(
        'SELECT run_id FROM model_provider_speed_tests WHERE run_id = ?',
        run.runId,
      )
      if (existing) return false
      d.run(
        `INSERT INTO model_provider_speed_tests (
           run_id, provider_id, provider_display_name, started_at, finished_at,
           planned_count, completed_count, success_count, failure_count, cancelled_count,
           protocol_type, api_dialect, model, calibration_version, max_output_tokens,
           temperature, outcome, summary_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        run.runId,
        run.providerId,
        run.providerDisplayName,
        run.startedAt,
        run.finishedAt,
        run.plannedCount,
        run.summary.completedCount,
        run.summary.successCount,
        run.summary.failureCount,
        run.summary.cancelledCount,
        run.protocolType,
        run.apiDialect,
        run.model,
        run.calibrationVersion,
        run.maxOutputTokens,
        run.temperature,
        run.outcome,
        JSON.stringify(run.summary),
      )
      for (const r of requests) {
        d.run(
          `INSERT INTO model_provider_speed_test_requests (
             run_id, sequence, started_at, outcome, failure_category, http_status,
             ttft_ms, end_to_end_ms, output_tokens, token_count_source, tpot_ms
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          run.runId,
          r.sequence,
          r.startedAt,
          r.outcome,
          r.failureCategory,
          r.httpStatus,
          r.ttftMs,
          r.endToEndMs,
          r.outputTokens,
          r.tokenCountSource,
          r.tpotMs,
        )
      }
      return true
    })
  } catch (err) {
    if (err instanceof SpeedTestStoreError) throw err
    throw new SpeedTestStoreError('write_failed', err instanceof Error ? err.message : String(err))
  }
}

// ---- Read ----

/**
 * One page of a provider's history, newest first by `(startedAt, runId)`. The sort
 * is on both columns so two runs sealed in the same millisecond keep a stable
 * order across pages instead of one of them appearing twice.
 */
export function listSpeedTestRuns(providerId: string, offset = 0): SpeedTestHistoryPage {
  const d = db()
  if (!d) return { providerId, runs: [], hasMore: false }
  const limit = SPEED_TEST_HISTORY_PAGE_SIZE
  // One extra row answers "is there a next page" without a second COUNT query.
  const rows = d.all<RunRow>(
    `SELECT * FROM model_provider_speed_tests
      WHERE provider_id = ?
      ORDER BY started_at DESC, run_id DESC
      LIMIT ? OFFSET ?`,
    providerId,
    limit + 1,
    Math.max(0, Math.trunc(offset)),
  )
  return {
    providerId,
    runs: rows.slice(0, limit).map(toRun),
    hasMore: rows.length > limit,
  }
}

/** One run with its details in issue order; `null` when the run id is unknown. */
export function getSpeedTestRunDetail(runId: string): SpeedTestRunDetail | null {
  const d = db()
  if (!d) return null
  const row = d.get<RunRow>('SELECT * FROM model_provider_speed_tests WHERE run_id = ?', runId)
  if (!row) return null
  const requests = d.all<RequestRow>(
    `SELECT sequence, started_at, outcome, failure_category, http_status,
            ttft_ms, end_to_end_ms, output_tokens, token_count_source, tpot_ms
       FROM model_provider_speed_test_requests
      WHERE run_id = ? ORDER BY sequence ASC`,
    runId,
  )
  return { run: toRun(row), requests: requests.map(toRequest) }
}

/**
 * Every provider that has history, each with its newest runs — the side-by-side
 * comparison's input.
 *
 * One grouped pass answers the whole view: the window functions give each run its
 * position within its provider and that provider's total, so a provider with a
 * thousand runs costs the same read as one with two, and no per-provider query
 * loop is needed. Rows beyond the choice limit are dropped here rather than in the
 * client, so the payload stays bounded no matter how much history accumulates.
 *
 * `currentNames` resolves the display name exactly as `listSpeedTestHistoryProviders`
 * does — a present provider shows its current name, an absent one its newest
 * snapshot. Entries come back newest-activity first; that order is the neutral
 * starting point only, since the view sorts by a chosen metric.
 */
export function listSpeedTestComparison(
  currentNames: ReadonlyMap<string, string>,
  choiceLimit: number = SPEED_TEST_COMPARE_CHOICE_LIMIT,
): SpeedTestComparisonEntry[] {
  const d = db()
  if (!d) return []
  const limit = Math.max(1, Math.trunc(choiceLimit))
  const rows = d.all<ComparisonRow>(
    `SELECT *, COUNT(*) OVER (PARTITION BY provider_id) AS run_count,
            ROW_NUMBER() OVER (PARTITION BY provider_id
                               ORDER BY started_at DESC, run_id DESC) AS rn
       FROM model_provider_speed_tests
      ORDER BY provider_id ASC, rn ASC`,
  )

  const byProvider = new Map<string, SpeedTestComparisonEntry>()
  for (const row of rows) {
    if (row.rn > limit) continue
    const entry = byProvider.get(row.provider_id)
    if (entry) {
      entry.runs.push(toRun(row))
      continue
    }
    const current = currentNames.get(row.provider_id)
    byProvider.set(row.provider_id, {
      providerId: row.provider_id,
      displayName: current ?? row.provider_display_name,
      present: current !== undefined,
      runCount: row.run_count,
      // The head row of a provider is its newest, which is also the name snapshot
      // an absent provider falls back to — hence no second query for it.
      runs: [toRun(row)],
    })
  }

  // Newest activity first, id as the tie-break so two providers last measured in
  // the same millisecond keep a stable order across reads. The tie-break compares
  // code points rather than collating: the order must not depend on the host's
  // locale, or the same database would read differently on two machines.
  return [...byProvider.values()].sort((a, b) => {
    const diff = (b.runs[0]?.startedAt ?? 0) - (a.runs[0]?.startedAt ?? 0)
    if (diff !== 0) return diff
    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0
  })
}

/**
 * Every provider id that has history, newest activity first. Providers that no
 * longer exist stay in the list — filtering them out is exactly what would strand
 * the records this table exists to keep.
 *
 * `currentNames` supplies the live configuration: a present provider shows its
 * CURRENT name (a rename must not rewrite history, but the picker should match
 * what the operator sees elsewhere), an absent one falls back to its newest
 * snapshot.
 */
export function listSpeedTestHistoryProviders(
  currentNames: ReadonlyMap<string, string>,
): SpeedTestHistoryProvider[] {
  const d = db()
  if (!d) return []
  const rows = d.all<{
    provider_id: string
    run_count: number
    last_started_at: number
    provider_display_name: string
  }>(
    `SELECT provider_id,
            COUNT(*)            AS run_count,
            MAX(started_at)     AS last_started_at,
            (SELECT provider_display_name
               FROM model_provider_speed_tests newest
              WHERE newest.provider_id = t.provider_id
              ORDER BY started_at DESC, run_id DESC LIMIT 1) AS provider_display_name
       FROM model_provider_speed_tests t
      GROUP BY provider_id
      ORDER BY last_started_at DESC`,
  )
  return rows.map((r) => {
    const current = currentNames.get(r.provider_id)
    return {
      providerId: r.provider_id,
      displayName: current ?? r.provider_display_name,
      runCount: r.run_count,
      lastStartedAt: r.last_started_at,
      present: current !== undefined,
    }
  })
}
