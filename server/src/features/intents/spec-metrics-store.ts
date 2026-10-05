/**
 * Persistence for the spec quality metrics: the analyzer's warnings and the
 * one-off baseline aggregates, in one table.
 *
 * Every write here is a SIDECHANNEL. The analyzer runs at session launch and
 * records what it found; if the write fails the session must still start, so
 * `recordSpecWarnings` swallows the error with a warning, exactly like
 * `safeInsertIntentLog` does for the lifecycle trail. Nothing in this module
 * participates in a prompt, a gate, or a verdict.
 */

import { randomUUID } from 'node:crypto'
import type { SpecRuleDetectionKind } from './spec-rules.js'
import type { SpecWarning } from './spec-analyzer.js'
import { getIntentsDb } from './store.js'

export interface SpecWarningRecord {
  readonly intentId: string | null
  readonly fingerprint: string | null
  readonly warning: SpecWarning
}

export interface SpecBaselineRecord {
  /** Which of the four comparison metrics this row holds. */
  readonly metric: string
  readonly value: number
  readonly sampleSize: number
  /** The measurement definition, so a stored number is readable on its own. */
  readonly note: string
}

interface MetricsRow {
  id: string
  kind: string
  intent_id: string | null
  rule_id: string | null
  detection: string | null
  severity: string
  location: string | null
  message: string | null
  spec_fingerprint: string | null
  sample_size: number | null
  value: number | null
  created_at: number
}

/** Write one warning per record. Returns how many rows landed; never throws. */
export function recordSpecWarnings(records: readonly SpecWarningRecord[]): number {
  if (records.length === 0) return 0
  try {
    const d = getIntentsDb()
    if (!d) return 0
    const now = Date.now()
    for (const record of records) {
      const { warning } = record
      d.run(
        `INSERT INTO spec_metrics
           (id, kind, intent_id, rule_id, detection, severity, location, message, spec_fingerprint, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        'warning',
        record.intentId,
        warning.ruleId,
        warning.detection,
        warning.severity,
        JSON.stringify(warning.location),
        warning.message,
        record.fingerprint,
        now,
      )
    }
    return records.length
  } catch (err) {
    // A missing/damaged metrics table must not take a session launch with it.
    console.warn(
      `[c3:intents] spec warning write failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 0
  }
}

/** Write one baseline aggregate row per metric. Returns how many landed. */
export function recordSpecBaselines(records: readonly SpecBaselineRecord[]): number {
  if (records.length === 0) return 0
  try {
    const d = getIntentsDb()
    if (!d) return 0
    const now = Date.now()
    for (const record of records) {
      d.run(
        `INSERT INTO spec_metrics
           (id, kind, rule_id, message, sample_size, value, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        randomUUID(),
        'baseline',
        record.metric,
        record.note,
        record.sampleSize,
        record.value,
        now,
      )
    }
    return records.length
  } catch (err) {
    console.warn(
      `[c3:intents] spec baseline write failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return 0
  }
}

/** An aggregate of the warning rows for one rule — the false-positive numerator's basis. */
export interface SpecRuleWarningRate {
  readonly ruleId: string
  readonly detections: number
  readonly specsScanned: number
}

/**
 * Per-rule warning counts plus how many distinct specs were scanned. The
 * false-positive rate of a rule is judged against these two numbers once a
 * human has adjudicated the hits; the table itself only stores the raw counts.
 */
export function listSpecWarningRates(): SpecRuleWarningRate[] {
  const d = getIntentsDb()
  if (!d) return []
  const rows = d.all<{ rule_id: string; hits: number; scanned: number }>(
    `SELECT rule_id,
            COUNT(*) AS hits,
            COUNT(DISTINCT COALESCE(spec_fingerprint, intent_id, id)) AS scanned
       FROM spec_metrics
      WHERE kind='warning' AND rule_id IS NOT NULL
      GROUP BY rule_id`,
  )
  return rows.map((row) => ({
    ruleId: row.rule_id,
    detections: row.hits,
    specsScanned: row.scanned,
  }))
}

/** Every baseline row, newest first. Empty when the backfill has not run. */
export function listSpecBaselines(): SpecBaselineRecord[] {
  const d = getIntentsDb()
  if (!d) return []
  return d
    .all<MetricsRow>(
      "SELECT * FROM spec_metrics WHERE kind='baseline' ORDER BY created_at DESC, rowid DESC",
    )
    .map((row) => ({
      metric: row.rule_id ?? '',
      value: row.value ?? 0,
      sampleSize: row.sample_size ?? 0,
      note: row.message ?? '',
    }))
}

/** An intent's own warnings, newest first — the observability side of the channel. */
export function listSpecWarnings(intentId: string): SpecWarning[] {
  const d = getIntentsDb()
  if (!d) return []
  return d
    .all<MetricsRow>(
      "SELECT * FROM spec_metrics WHERE kind='warning' AND intent_id=? ORDER BY created_at DESC, rowid DESC",
      intentId,
    )
    .map((row) => ({
      ruleId: row.rule_id ?? '',
      detection: (row.detection ?? '') as SpecRuleDetectionKind,
      severity: 'warn' as const,
      location: row.location
        ? (JSON.parse(row.location) as SpecWarning['location'])
        : { section: '(unknown)', line: 0 },
      message: row.message ?? '',
    }))
}
