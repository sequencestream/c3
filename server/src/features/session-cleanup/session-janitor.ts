// Session janitor: a process-local daily scheduler that prunes stale session
// transcripts from every vendor session store c3 can reach.
//
// Vendors persist a session transcript so a later turn can `resume` it: codex
// writes rollouts under `<CODEX_HOME>/sessions/`, claude writes JSONL under
// `<CLAUDE_CONFIG_DIR>/projects/`. Nothing prunes them per run — that is exactly
// what keeps a thread resumable — so they accumulate forever.
//
// Scope is global and vendor-neutral, matching the stores themselves: a store
// holds sessions from every workspace, so cleanup cannot be decided per
// workspace. Two roots are swept — c3's own relay home root (the isolated vendor
// homes relay runs write to) plus the host codex and claude homes. Within them the
// janitor never hard-codes a vendor: it walks a shallow depth looking for
// directories named by the shared session-store convention and prunes only inside
// those, so a new vendor following the convention is covered automatically and
// sibling files (`config.toml`, `skills/`, state sqlite, credentials) are never
// touched.
//
// Cleanup is opt-in: a single system-wide switch. A single module-level timer, a
// delayed first sweep on boot, then a fixed 24h cadence. Fully fail-soft: any fs
// error on one file/dir is logged and skipped — it never throws into the boot
// path or aborts the sweep.
import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { c3HomeDir, getSessionCleanup } from '../../kernel/config/index.js'
import { hostCodexHome, hostClaudeConfigDir } from '../../kernel/config/workspace-path.js'

/**
 * Directory names vendors use for their session transcripts (codex `sessions`,
 * claude `projects`). This is the convention the janitor matches on — not a
 * vendor registry: any vendor home following it is swept without a code change.
 */
const SESSION_DIR_NAMES = new Set(['sessions', 'projects'])

/**
 * How deep below a root a session dir may sit: the relay root puts it at 2
 * (`<root>/codex/sessions`), a host vendor home at 1. Bounding the walk keeps the
 * scan cheap and stops it from wandering into unrelated deep trees.
 */
const MAX_SCAN_DEPTH = 2

/** Delay before the first sweep so the server can settle on boot (ms). */
const INITIAL_DELAY_MS = 60_000
/** Fixed sweep cadence once running: once a day (ms). */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** ms per retention day. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Every root that may contain vendor session stores: c3's relay home root (the
 * isolated vendor homes a relay run writes to) and the host vendor homes a
 * subscription run writes to.
 */
function cleanupRoots(): string[] {
  return [join(c3HomeDir(), 'relay'), hostCodexHome(), hostClaudeConfigDir()]
}

/**
 * Collect session-store directories at or below `dir`, bounded by `depth`.
 * A directory whose name matches the convention is collected and NOT descended
 * into — everything under it is session data and gets pruned wholesale, so there
 * is nothing to look for deeper. Fail-soft: an unreadable directory yields none.
 */
function collectSessionDirs(dir: string, depth: number, out: Set<string>): void {
  if (depth <= 0) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // absent or unreadable — nothing to collect
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (SESSION_DIR_NAMES.has(entry.name)) out.add(full)
    else collectSessionDirs(full, depth - 1, out)
  }
}

/**
 * Recursively delete files under `dir` whose mtime is older than `cutoff`,
 * returning the count removed. Directories are walked but not themselves removed
 * (an emptied `sessions/YYYY/MM/DD` tree is harmless and cheap to keep). Fail-soft
 * per entry: a stat/unlink error is logged and skipped, never aborting the walk.
 */
function pruneStaleFiles(dir: string, cutoff: number): number {
  let removed = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0 // dir absent or unreadable — nothing to prune
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        removed += pruneStaleFiles(full, cutoff)
      } else if (entry.isFile()) {
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { force: true })
          removed++
        }
      }
    } catch (err) {
      console.log(`[c3:session-cleanup] prune skipped ${full}: ${(err as Error).message}`)
    }
  }
  return removed
}

/**
 * Run one prune sweep across every reachable vendor session store. Never throws.
 *
 * A no-op unless cleanup is switched on system-wide. When it is, each root is
 * scanned for session-store directories and files older than the retention
 * window are removed from them — regardless of which workspace or vendor wrote
 * them.
 */
export function runSessionPruneOnce(opts: { now?: number } = {}): number {
  const { enabled, retentionDays } = getSessionCleanup()
  if (!enabled) return 0 // opt-in: nothing is pruned until the switch is on
  const cutoff = (opts.now ?? Date.now()) - retentionDays * DAY_MS
  const dirs = new Set<string>()
  for (const root of cleanupRoots()) collectSessionDirs(root, MAX_SCAN_DEPTH, dirs)
  let removed = 0
  for (const dir of dirs) removed += pruneStaleFiles(dir, cutoff)
  if (removed > 0) console.log(`[c3:session-cleanup] pruned ${removed} stale session file(s)`)
  return removed
}

let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Start the process-local session-prune loop. A brief initial delay lets the
 * server settle on boot, then it self-reschedules on a fixed 24h cadence. The
 * switch is read per sweep, so toggling cleanup needs no restart. Idempotent —
 * a prior loop is stopped first. Fail-soft.
 */
export function startSessionJanitor(): void {
  stopSessionJanitor()
  const tick = (): void => {
    try {
      runSessionPruneOnce()
    } catch {
      /* fail-soft: never let the janitor crash the server */
    }
    timer = setTimeout(tick, SWEEP_INTERVAL_MS)
    timer.unref?.()
  }
  timer = setTimeout(tick, INITIAL_DELAY_MS)
  timer.unref?.()
}

/** Stop the session-prune loop (called on shutdown). */
export function stopSessionJanitor(): void {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
}
