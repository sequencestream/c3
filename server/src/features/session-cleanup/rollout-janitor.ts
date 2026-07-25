// Session-cleanup rollout janitor: a process-local daily scheduler that prunes
// stale codex thread rollouts from the persistent per-workspace CODEX_HOME.
//
// A sandboxed codex run anchors CODEX_HOME at a fixed per-workspace path
// (`~/.c3/sandbox-home/<project>/.codex`) so a thread's rollout survives across
// runs for the next turn's `resume`. Because that dir is never cleaned per-run,
// rollouts would otherwise accumulate forever. Cleanup is a store-governance
// decision, not an isolation one: it is driven solely by the workspace's
// `sessionCleanup` config and never consults the sandbox config.
//
// Cleanup is opt-in. Only workspaces with `sessionCleanup.enabled === true` are
// swept; unconfigured workspaces and orphan directories (a removed workspace)
// are left alone rather than falling back to a default window.
//
// A single module-level timer, a delayed first sweep on boot, then a fixed 24h
// cadence. Fully fail-soft: any fs error on one file/dir is logged and skipped —
// it never throws into the boot path or aborts the sweep.
import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  c3HomeDir,
  getSessionCleanup,
  listConfiguredWorkspacePaths,
} from '../../kernel/config/index.js'
import { projectDirName } from '../../kernel/config/workspace-path.js'

/** Root holding every workspace's persistent session store (sandbox CODEX_HOME). */
function sessionStoreRoot(): string {
  return join(c3HomeDir(), 'sandbox-home')
}

/** Delay before the first sweep so the server can settle on boot (ms). */
const INITIAL_DELAY_MS = 60_000
/** Fixed sweep cadence once running: once a day (ms). */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** ms per retention day. */
const DAY_MS = 24 * 60 * 60 * 1000

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
      console.log(`[c3:session-cleanup] rollout prune skipped ${full}: ${(err as Error).message}`)
    }
  }
  return removed
}

/**
 * Run one prune sweep across the workspaces that opted into cleanup. Never throws.
 *
 * Builds a `projectDirName → retention days` map from the configured workspaces
 * whose `sessionCleanup` is enabled, then prunes rollout files under
 * `<store root>/<dir>/.codex/sessions/` for exactly those dirs. A directory with
 * no enabled workspace behind it is skipped entirely.
 */
export function runRolloutPruneOnce(opts: { now?: number } = {}): number {
  const now = opts.now ?? Date.now()
  // Map each opted-in workspace's on-disk dir segment to its retention window.
  const retentionByDir = new Map<string, number>()
  for (const ws of listConfiguredWorkspacePaths()) {
    const cleanup = getSessionCleanup(ws)
    if (!cleanup.enabled) continue
    retentionByDir.set(projectDirName(ws), cleanup.retentionDays)
  }
  if (retentionByDir.size === 0) return 0 // nobody opted in — nothing to sweep
  const root = sessionStoreRoot()
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return 0 // no session stores yet — nothing to do
  }
  let removed = 0
  for (const dir of dirs) {
    const days = retentionByDir.get(dir)
    if (days === undefined) continue // not an opted-in workspace — leave it untouched
    const cutoff = now - days * DAY_MS
    removed += pruneStaleFiles(join(root, dir, '.codex', 'sessions'), cutoff)
  }
  if (removed > 0) console.log(`[c3:session-cleanup] pruned ${removed} stale codex rollout file(s)`)
  return removed
}

let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Start the process-local rollout-prune loop. A brief initial delay lets the
 * server settle on boot, then it self-reschedules on a fixed 24h cadence.
 * Idempotent — a prior loop is stopped first. Fail-soft.
 */
export function startRolloutJanitor(): void {
  stopRolloutJanitor()
  const tick = (): void => {
    try {
      runRolloutPruneOnce()
    } catch {
      /* fail-soft: never let the janitor crash the server */
    }
    timer = setTimeout(tick, SWEEP_INTERVAL_MS)
    timer.unref?.()
  }
  timer = setTimeout(tick, INITIAL_DELAY_MS)
  timer.unref?.()
}

/** Stop the rollout-prune loop (called on shutdown). */
export function stopRolloutJanitor(): void {
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
}
