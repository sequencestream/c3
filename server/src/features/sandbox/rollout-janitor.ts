// Sandbox rollout janitor: a process-local daily scheduler that prunes stale
// codex thread rollouts from the persistent per-workspace sandbox CODEX_HOME.
//
// The sandbox anchors codex's CODEX_HOME at a fixed per-workspace path
// (`~/.c3/sandbox-home/<project>/.codex`) so a thread's rollout survives across
// runs for the next turn's `resume`. Because that dir is never cleaned per-run,
// rollouts would otherwise accumulate forever. This janitor deletes rollout
// files whose mtime is older than the workspace's retention window (default 30
// days), keeping the store bounded without touching still-resumable sessions.
//
// A single module-level timer, a delayed first sweep on boot, then a fixed 24h
// cadence. Fully fail-soft: any fs error on one file/dir is logged and skipped —
// it never throws into the boot path or aborts the sweep.
import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  c3HomeDir,
  getSandboxRetentionDays,
  listConfiguredWorkspacePaths,
  DEFAULT_SANDBOX_RETENTION_DAYS,
} from '../../kernel/config/index.js'
import { projectDirName } from '../../kernel/config/workspace-path.js'

/** Root holding every workspace's persistent sandbox home. */
function sandboxHomeRoot(): string {
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
      console.log(`[c3:sandbox] rollout prune skipped ${full}: ${(err as Error).message}`)
    }
  }
  return removed
}

/**
 * Run one prune sweep across every on-disk sandbox home. Never throws.
 *
 * Retention is per workspace: build a `projectDirName → days` map from the
 * configured workspaces, then for each `sandbox-home/<dir>` apply its window
 * (default when the dir has no matching config, e.g. a removed workspace).
 * Prunes rollout files under `<dir>/.codex/sessions/` older than the window.
 */
export function runRolloutPruneOnce(opts: { now?: number } = {}): number {
  const now = opts.now ?? Date.now()
  const root = sandboxHomeRoot()
  // Map each configured workspace's on-disk dir segment to its retention window.
  const retentionByDir = new Map<string, number>()
  for (const ws of listConfiguredWorkspacePaths()) {
    retentionByDir.set(projectDirName(ws), getSandboxRetentionDays(ws))
  }
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return 0 // no sandbox homes yet — nothing to do
  }
  let removed = 0
  for (const dir of dirs) {
    const days = retentionByDir.get(dir) ?? DEFAULT_SANDBOX_RETENTION_DAYS
    const cutoff = now - days * DAY_MS
    const sessionsDir = join(root, dir, '.codex', 'sessions')
    removed += pruneStaleFiles(sessionsDir, cutoff)
  }
  if (removed > 0) console.log(`[c3:sandbox] pruned ${removed} stale codex rollout file(s)`)
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
