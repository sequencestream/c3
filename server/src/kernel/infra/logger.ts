/**
 * Process-level file logging for c3, persisted under `~/.c3/log/` (honoring the
 * same `--settings` / `C3_DIR` override as the rest of c3 home).
 *
 * c3 has no structured logger — every runtime line is a `console.log/error/warn`
 * that only reaches the terminal. Rather than rewrite dozens of call sites, this
 * module installs a one-shot tee: `initLogging()` wraps `process.stdout.write` /
 * `process.stderr.write` so the terminal still gets every byte while the same
 * text is appended to the live log file `c3.log`.
 *
 * Archival is by host LOCAL calendar day (deliberately NOT the configured
 * scheduler timezone — the logger must keep working even if settings fail to
 * load, so it never reaches back into config). At a day boundary the live
 * `c3.log` is renamed to `c3-<the day that just ended>.log` and a fresh `c3.log`
 * continues. Retention keeps the most recent {@link RETENTION_DAYS} archives.
 *
 * Best-effort by contract: a missing/unwritable dir, a failed rename, or a
 * failed unlink is caught, warned to the terminal, and otherwise ignored — the
 * logging subsystem must never crash the main process (and must never go
 * silent). All disk work is synchronous (`appendFileSync`), so a write is
 * durable on return and shutdown needs only to restore the original streams.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { c3HomeDir } from '../config/index.js'

/** Name of the always-current live log file. */
export const LIVE_LOG_NAME = 'c3.log'

/** Default number of most-recent archive days to keep. */
export const RETENTION_DAYS = 30

/** Low-frequency boundary check so archival still fires when the process is idle. */
const BOUNDARY_TIMER_MS = 60 * 60 * 1000

const ARCHIVE_RE = /^c3-(\d{4})-(\d{2})-(\d{2})\.log$/

/** Host-local `YYYY-MM-DD` key for a date — the unit of archival. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Archive filename for a given `YYYY-MM-DD` date key. */
export function archiveFilename(dateKey: string): string {
  return `c3-${dateKey}.log`
}

/**
 * Host-local second-precision line prefix `YYYY-MM-DD HH:mm:ss ` (trailing space).
 * Reuses {@link localDateKey}'s local-calendar reading of the date — no timezone
 * library, no scheduler config — so a timestamped line locates an event to the
 * second in both the terminal and `c3.log`.
 */
export function timestampPrefix(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  return `${localDateKey(now)} ${hh}:${mm}:${ss} `
}

/**
 * A stateful per-stream transformer that prepends {@link timestampPrefix} to the
 * start of every real log LINE. It tracks whether the stream is currently at a
 * line start so a line split across multiple `write` calls is prefixed exactly
 * once: the tail of a chunk that does not end in `\n` stays "mid-line", and the
 * next chunk continues it without a new prefix. Each `\n` (even an empty line)
 * counts as emitting a line, so the following content gets its own prefix.
 */
export function makeLinePrefixer(): { transform: (text: string) => string } {
  let atLineStart = true
  return {
    transform(text: string): string {
      if (text === '') return ''
      let out = ''
      for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (atLineStart) {
          out += timestampPrefix(new Date())
          atLineStart = false
        }
        out += c
        if (c === '\n') atLineStart = true
      }
      return out
    },
  }
}

/**
 * Parse a `c3-YYYY-MM-DD.log` archive name to its local date (midnight), or
 * `null` if the name does not match or encodes an impossible calendar date.
 */
export function parseArchiveDate(filename: string): Date | null {
  const m = ARCHIVE_RE.exec(filename)
  if (!m) return null
  const [, y, mo, d] = m
  const date = new Date(Number(y), Number(mo) - 1, Number(d))
  // Reject overflow (e.g. 2026-13-40 rolling into another month).
  if (localDateKey(date) !== `${y}-${mo}-${d}`) return null
  return date
}

/**
 * Whether an archive file is past the retention window. An archive dated
 * exactly `retentionDays` ago is KEPT (boundary inclusive); only strictly older
 * archives expire. Non-archive names (incl. the live log) are never expired.
 */
export function isExpiredArchive(
  filename: string,
  now: Date,
  retentionDays: number = RETENTION_DAYS,
): boolean {
  const date = parseArchiveDate(filename)
  if (!date) return false
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cutoff.setDate(cutoff.getDate() - retentionDays)
  return date.getTime() < cutoff.getTime()
}

// ---- Module state (installed tee) ----

type WriteFn = typeof process.stdout.write

let installed = false
let activeLogDir: string | null = null
/** Local date key the live `c3.log` currently belongs to. */
let activeDateKey: string | null = null
let origStdoutWrite: WriteFn | null = null
let origStderrWrite: WriteFn | null = null
let boundaryTimer: ReturnType<typeof setInterval> | null = null

/**
 * Emit an internal warning to the terminal ONLY (never teed to file) — appending
 * to file is exactly what may have failed, and re-teeing would risk recursion.
 */
function warnInternal(message: string): void {
  // Reuse the same prefix format so internal warnings carry timing info too, but
  // write straight to the real stderr (never back through the tee) to avoid the
  // recursion / disk-failure loop the tee could otherwise trigger.
  const line = `${timestampPrefix(new Date())}[c3][logger] ${message}\n`
  try {
    const write = origStderrWrite ?? process.stderr.write.bind(process.stderr)
    write(line)
  } catch {
    // Last resort: swallow — we must never throw out of the logger.
  }
}

/**
 * Delete archives older than the retention window. Missing dir, unreadable dir,
 * or a failed unlink are all caught (warned) — never thrown.
 */
export function cleanupOldArchives(
  logDir: string,
  now: Date,
  retentionDays: number = RETENTION_DAYS,
): void {
  let entries: string[]
  try {
    entries = readdirSync(logDir)
  } catch {
    return // dir absent / unreadable — nothing to clean
  }
  for (const name of entries) {
    if (!isExpiredArchive(name, now, retentionDays)) continue
    try {
      unlinkSync(join(logDir, name))
    } catch (err) {
      warnInternal(`failed to delete expired archive ${name}: ${String(err)}`)
    }
  }
}

/**
 * If the live log belongs to a day before `now`, rename it to its dated archive
 * and run retention. Returns the date key the (new) live log now belongs to —
 * always today's key. A failed rename is caught and the day key still advances
 * so writes continue into a fresh file rather than appending to stale content.
 */
export function archiveStaleLiveLog(logDir: string, now: Date, liveDateKey: string): string {
  const todayKey = localDateKey(now)
  if (liveDateKey === todayKey) return todayKey
  const live = join(logDir, LIVE_LOG_NAME)
  try {
    if (existsSync(live)) {
      renameSync(live, join(logDir, archiveFilename(liveDateKey)))
    }
  } catch (err) {
    warnInternal(
      `failed to archive ${LIVE_LOG_NAME} as ${archiveFilename(liveDateKey)}: ${String(err)}`,
    )
  }
  cleanupOldArchives(logDir, now)
  return todayKey
}

/**
 * Startup catch-up: if a leftover `c3.log` exists from a previous run whose
 * mtime is an earlier day (process spanned midnight while down), archive it
 * under that day before opening a fresh live log. Returns today's date key.
 */
export function startupArchive(logDir: string, now: Date): string {
  const live = join(logDir, LIVE_LOG_NAME)
  let liveDateKey = localDateKey(now)
  try {
    if (existsSync(live)) {
      liveDateKey = localDateKey(statSync(live).mtime)
    }
  } catch (err) {
    warnInternal(`failed to stat ${LIVE_LOG_NAME} on startup: ${String(err)}`)
  }
  return archiveStaleLiveLog(logDir, now, liveDateKey)
}

/** Append one chunk to the live log, rolling the day over first if needed. */
function appendToLive(text: string): void {
  if (!activeLogDir || activeDateKey === null) return
  const now = new Date()
  if (localDateKey(now) !== activeDateKey) {
    activeDateKey = archiveStaleLiveLog(activeLogDir, now, activeDateKey)
  }
  try {
    appendFileSync(join(activeLogDir, LIVE_LOG_NAME), text)
  } catch (err) {
    warnInternal(`failed to append to ${LIVE_LOG_NAME}: ${String(err)}`)
  }
}

/**
 * Wrap a stream's `write` so each line is timestamp-prefixed first, then the same
 * formatted text is sent to BOTH the terminal and the live log — keeping the two
 * byte-for-byte identical. Non-text chunks and any transform fault fall back to a
 * best-effort raw passthrough so the tee never disturbs the real write.
 */
function makeTee(original: WriteFn, stream: NodeJS.WriteStream): WriteFn {
  const prefixer = makeLinePrefixer()
  return function (this: unknown, ...args: unknown[]): boolean {
    const chunk = args[0]
    let text: string | null = null
    if (typeof chunk === 'string') text = chunk
    else if (chunk instanceof Uint8Array) {
      try {
        text = Buffer.from(chunk).toString('utf8')
      } catch {
        text = null
      }
    }

    // Non-text chunk (or a decode failure): pass through untouched, no file tee.
    if (text === null) return original.apply(stream, args as Parameters<WriteFn>)

    let formatted: string
    try {
      formatted = prefixer.transform(text)
    } catch {
      formatted = text // best-effort: emit the original line rather than dropping it
    }

    // Re-emit the formatted text through the original stream, preserving any
    // trailing encoding/callback args in their original positions. Re-encode a
    // buffer input back to a Buffer so the terminal sees the same type it would
    // have; the file gets the identical text via appendToLive.
    const outArgs = args.slice()
    outArgs[0] = chunk instanceof Uint8Array ? Buffer.from(formatted, 'utf8') : formatted
    const ret = original.apply(stream, outArgs as Parameters<WriteFn>)
    try {
      appendToLive(formatted)
    } catch {
      // Tee must never disturb the real write — swallow.
    }
    return ret
  } as WriteFn
}

/**
 * Install the file-logging tee. Idempotent. On any setup failure (e.g. the log
 * dir cannot be created) it warns to stderr and returns, leaving terminal-only
 * output intact — the main process keeps running.
 */
export function initLogging(): void {
  if (installed) return
  let logDir: string
  try {
    logDir = join(c3HomeDir(), 'log')
    mkdirSync(logDir, { recursive: true })
  } catch (err) {
    warnInternal(`failed to create log dir, file logging disabled: ${String(err)}`)
    return
  }

  const now = new Date()
  activeLogDir = logDir
  try {
    activeDateKey = startupArchive(logDir, now)
  } catch (err) {
    warnInternal(`startup archive failed: ${String(err)}`)
    activeDateKey = localDateKey(now)
  }
  cleanupOldArchives(logDir, now)

  origStdoutWrite = process.stdout.write.bind(process.stdout)
  origStderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = makeTee(origStdoutWrite, process.stdout)
  process.stderr.write = makeTee(origStderrWrite, process.stderr)
  installed = true

  boundaryTimer = setInterval(() => {
    if (!activeLogDir || activeDateKey === null) return
    const tick = new Date()
    if (localDateKey(tick) !== activeDateKey) {
      activeDateKey = archiveStaleLiveLog(activeLogDir, tick, activeDateKey)
    }
  }, BOUNDARY_TIMER_MS)
  boundaryTimer.unref?.()
}

/** Restore the original streams and stop the boundary timer. Idempotent. */
export function shutdownLogging(): void {
  if (boundaryTimer) {
    clearInterval(boundaryTimer)
    boundaryTimer = null
  }
  if (!installed) return
  if (origStdoutWrite) process.stdout.write = origStdoutWrite
  if (origStderrWrite) process.stderr.write = origStderrWrite
  origStdoutWrite = null
  origStderrWrite = null
  activeLogDir = null
  activeDateKey = null
  installed = false
}

/** Test seam: tear down all module state without touching disk. */
export function resetLoggingForTests(): void {
  shutdownLogging()
}
