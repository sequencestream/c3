/**
 * Settings persistence mechanism (2026-06-08-003) — the low-level, concurrency-safe
 * write primitives that make `~/.c3/settings.json` have a *single, serialized*
 * write path. This module owns ONLY the mechanics; the settings shape, `normalize`,
 * caches and merge policy live in `config/index.ts`, which funnels every write
 * through {@link withSettingsLock}.
 *
 * The double-lock model (see specs/domains/system-config/persistence.md):
 *  1. **In-process serialization** — the whole codebase's settings writes are
 *     synchronous with no `await` suspension points, so JS's single-threaded
 *     synchronous execution already serializes them (strictly stronger than an
 *     async mutex). We still funnel everything through one entry point so the
 *     invariant is structural, not incidental.
 *  2. **Cross-process file lock** — a zero-dependency, atomic `mkdirSync`-based
 *     directory lock guards the read-modify-write *sequence* across multiple c3
 *     instances (different `--workspace`). `mkdirSync` without `recursive` fails with
 *     `EEXIST` when the directory already exists, which is an atomic test-and-set on
 *     macOS/Linux/Windows alike — no native dependency, bundles cleanly into the
 *     single binary.
 *
 * Robustness: a stale lock (owner crashed) is reclaimed by age; acquisition has a
 * bounded timeout; on timeout we log loudly and proceed **best-effort** (we still
 * run the write) — degrading only the cross-process atomicity guarantee, never
 * silently dropping the write.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Max wall-clock to wait for the cross-process lock before degrading to best-effort. */
export const SETTINGS_LOCK_TIMEOUT_MS = 5_000
/** Backoff between lock-acquire attempts (synchronous sleep via `Atomics.wait`). */
export const SETTINGS_LOCK_RETRY_MS = 25
/** A held lock older than this is presumed abandoned (owner crashed) and reclaimed. */
export const SETTINGS_LOCK_STALE_MS = 30_000

/** Tunables for {@link withFileLock} — defaulted from the module constants; overridable in tests. */
export interface FileLockOptions {
  timeoutMs?: number
  retryMs?: number
  staleMs?: number
}

/**
 * Atomic write: `mkdir -p` the parent, write a pid-scoped temp file, then rename
 * over the target (rename is atomic on POSIX/NTFS). Guarantees a reader never sees
 * a half-written file; it does NOT serialize a read-modify-write sequence — that's
 * what {@link withFileLock} is for.
 */
export function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, file)
}

/**
 * Read + JSON-parse a file, returning `undefined` on any missing/parse error.
 * Used for the **fresh, cache-bypassing** disk read performed inside the lock so a
 * write never trusts a possibly-stale in-memory snapshot.
 */
export function readJsonFile<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as T
  } catch {
    return undefined
  }
}

/** Synchronous sleep without busy-spinning the CPU; falls back to a bounded busy
 *  wait if `SharedArrayBuffer`/`Atomics` is unavailable (e.g. disabled by policy). */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* busy-wait fallback */
    }
  }
}

/** Lock directory for a target file: a sibling `${file}.lock/` dir holding `meta.json`. */
function lockDirFor(file: string): string {
  return `${file}.lock`
}
function lockMetaFor(lockDir: string): string {
  return join(lockDir, 'meta.json')
}

interface LockMeta {
  pid: number
  /** ms since epoch the lock was acquired — drives stale reclaim. */
  ts: number
}

/** Whether a currently-held lock dir is older than `staleMs` (owner presumed dead). */
function isLockStale(lockDir: string, staleMs: number, now: number): boolean {
  const meta = readJsonFile<LockMeta>(lockMetaFor(lockDir))
  if (meta && typeof meta.ts === 'number' && Number.isFinite(meta.ts)) {
    return now - meta.ts > staleMs
  }
  // Meta missing/corrupt — fall back to the lock dir's own mtime.
  try {
    return now - statSync(lockDir).mtimeMs > staleMs
  } catch {
    // The dir vanished between the EEXIST and the stat — treat as free.
    return true
  }
}

/**
 * Acquire the cross-process lock for `file`. Returns `true` on success, `false` on
 * timeout. On timeout the caller proceeds best-effort (never drops the write). A
 * stale lock (older than `staleMs`) is reclaimed and retried.
 */
function acquireLock(file: string, opts: Required<FileLockOptions>): boolean {
  const lockDir = lockDirFor(file)
  mkdirSync(dirname(file), { recursive: true })
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    try {
      mkdirSync(lockDir) // atomic test-and-set: throws EEXIST when already held
      // Best-effort owner stamp (used for stale detection); a write failure here is
      // non-fatal — the dir itself is the lock.
      try {
        writeAtomic(lockMetaFor(lockDir), { pid: process.pid, ts: Date.now() } satisfies LockMeta)
      } catch {
        /* meta is advisory only */
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const now = Date.now()
      if (isLockStale(lockDir, opts.staleMs, now)) {
        // Reclaim the abandoned lock and retry immediately.
        try {
          rmSync(lockDir, { recursive: true, force: true })
        } catch {
          /* another process may have reclaimed it first — fall through to retry */
        }
        continue
      }
      if (now >= deadline) return false
      sleepSync(opts.retryMs)
    }
  }
}

function releaseLock(file: string): void {
  try {
    rmSync(lockDirFor(file), { recursive: true, force: true })
  } catch (err) {
    console.error('[c3] failed to release settings lock:', err)
  }
}

/**
 * Run `fn` while holding the cross-process file lock for `file`. The lock is always
 * released, even if `fn` throws. On lock-acquire timeout we log loudly and STILL run
 * `fn` (best-effort) so a write is never silently dropped — only the cross-process
 * atomicity guarantee degrades. `fn` is synchronous by contract (no `await`), which
 * is what gives the in-process serialization for free.
 */
export function withFileLock<T>(file: string, fn: () => T, opts?: FileLockOptions): T {
  const resolved: Required<FileLockOptions> = {
    timeoutMs: opts?.timeoutMs ?? SETTINGS_LOCK_TIMEOUT_MS,
    retryMs: opts?.retryMs ?? SETTINGS_LOCK_RETRY_MS,
    staleMs: opts?.staleMs ?? SETTINGS_LOCK_STALE_MS,
  }
  const acquired = acquireLock(file, resolved)
  if (!acquired) {
    console.error(
      `[c3] could not acquire settings lock for ${file} within ${resolved.timeoutMs}ms; ` +
        'proceeding best-effort (write preserved, cross-process atomicity not guaranteed)',
    )
  }
  try {
    return fn()
  } finally {
    if (acquired) releaseLock(file)
  }
}
