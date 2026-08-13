/**
 * The self-update staging area — everything the console's updater keeps on disk
 * between "a new release was downloaded" and "the new binary is running".
 *
 * It lives under the c3 home (`<c3Home>/update-staging/`), so a relocated
 * instance (`--db`) stages into its own home and two instances never share a
 * half-downloaded package. Only plain files are used: the relaunch helper runs as
 * a separate process and must be able to read this state without opening SQLite.
 *
 * Two records, each written whole via a temp file + rename so a crash can never
 * leave a half-parsed one:
 *
 *   - `staged.json` — "a verified package is ready". Its presence IS the readiness
 *     signal; it is written last, after the download verified and unpacked.
 *   - `apply-failure.json` — the helper's way to report back after the server that
 *     asked for the swap is already gone. The next boot reads it, surfaces it, and
 *     clears it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SelfUpdateFailureCode } from '@ccc/shared/protocol'

/** Directory name under the c3 home. */
const STAGING_DIR_NAME = 'update-staging'
const STAGED_RECORD_NAME = 'staged.json'
const APPLY_FAILURE_NAME = 'apply-failure.json'

/** A verified, unpacked release waiting for someone to restart into it. */
export interface StagedUpdateRecord {
  /** The normalized version staged. */
  version: string
  /** The published tag the package came from. */
  tag: string
  /** Absolute path of the unpacked binary to install. */
  binPath: string
  /** The installed binary this package is meant to replace. */
  execPath: string
  /** The version that was running when this package was staged. */
  fromVersion: string
}

/** What went wrong inside the relaunch helper, handed back to the next boot. */
export interface ApplyFailureRecord {
  code: SelfUpdateFailureCode
  detail?: string
}

/** The staging directory for a given c3 home. */
export function stagingDir(c3Home: string): string {
  return join(c3Home, STAGING_DIR_NAME)
}

/** Wipe and recreate the staging directory, so a new download starts from nothing. */
export function resetStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/** Remove the staging directory entirely. */
export function clearStaging(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/**
 * The staged record, or null when nothing is staged. A record whose unpacked
 * binary has since disappeared counts as nothing staged — the readiness claim
 * must be backed by a file that still exists.
 */
export function readStagedRecord(dir: string): StagedUpdateRecord | null {
  const record = readJson<StagedUpdateRecord>(join(dir, STAGED_RECORD_NAME))
  if (!record || typeof record.version !== 'string' || typeof record.binPath !== 'string') {
    return null
  }
  return existsSync(record.binPath) ? record : null
}

export function writeStagedRecord(dir: string, record: StagedUpdateRecord): void {
  writeJson(join(dir, STAGED_RECORD_NAME), record)
}

export function readApplyFailure(dir: string): ApplyFailureRecord | null {
  const record = readJson<ApplyFailureRecord>(join(dir, APPLY_FAILURE_NAME))
  return record && typeof record.code === 'string' ? record : null
}

export function writeApplyFailure(dir: string, record: ApplyFailureRecord): void {
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, APPLY_FAILURE_NAME), record)
}

export function clearApplyFailure(dir: string): void {
  rmSync(join(dir, APPLY_FAILURE_NAME), { force: true })
}
