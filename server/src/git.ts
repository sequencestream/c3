/**
 * Minimal git helpers for the automation orchestrator. c3 normally lets the
 * Claude Code SDK run git via its `Bash` tool, but the orchestrator commits and
 * pushes itself — directly and synchronously — so it can detect failure (no
 * remote, rejected push, auth) and stop with a precise reason rather than
 * trusting an agent to report it.
 *
 * Every call is scoped to `cwd` via `git -C`; nothing here touches process.cwd().
 */
import { execFile } from 'node:child_process'

/** Run `git <args>` in `cwd`; resolve with stdout/stderr/exit code (never rejects). */
function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err
            ? 1
            : 0
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() })
    })
  })
}

/**
 * `git diff` summary for the working tree (staged + unstaged), as objective
 * evidence for the completion judge. Empty string when nothing changed or git
 * errors (the judge then leans on the assistant message alone).
 */
export async function gitDiffStat(projectPath: string): Promise<string> {
  const r = await git(projectPath, ['-C', projectPath, 'diff', 'HEAD', '--stat'])
  return r.code === 0 ? r.stdout.trim() : ''
}

/** Recent commit subjects (oneline), as completion evidence for the judge. */
export async function gitRecentLog(projectPath: string, n = 5): Promise<string> {
  const r = await git(projectPath, ['-C', projectPath, 'log', '--oneline', `-${n}`])
  return r.code === 0 ? r.stdout.trim() : ''
}

/**
 * Stage everything, commit with `message` (if there are changes), and **always
 * push**. The dev-skill agent may have already committed its own work, leaving
 * the tree clean — so an empty stage is NOT a no-op: we still push so those local
 * commits reach the remote. Returns `{ ok }` plus a one-line `error` reason the
 * orchestrator surfaces on the automation button. A push failure is a hard stop
 * (work is committed locally but not shared).
 */
export async function commitAndPush(
  projectPath: string,
  message: string,
): Promise<{ ok: boolean; committed: boolean; error?: string }> {
  const add = await git(projectPath, ['-C', projectPath, 'add', '-A'])
  if (add.code !== 0)
    return { ok: false, committed: false, error: `git add 失败: ${oneLine(add.stderr)}` }

  // Commit only when something is staged; an empty tree means the agent already
  // committed (or there was nothing to change) — fall through to push regardless.
  const status = await git(projectPath, ['-C', projectPath, 'status', '--porcelain'])
  const hasChanges = status.code === 0 && status.stdout.trim() !== ''
  let committed = false
  if (hasChanges) {
    const commit = await git(projectPath, ['-C', projectPath, 'commit', '-m', message])
    if (commit.code !== 0) {
      return {
        ok: false,
        committed: false,
        error: `git commit 失败: ${oneLine(commit.stderr || commit.stdout)}`,
      }
    }
    committed = true
  }

  const push = await git(projectPath, ['-C', projectPath, 'push'])
  // "Everything up-to-date" exits non-zero on some gits? No — it's 0. A real
  // failure (no upstream, rejected, auth) is a hard stop.
  if (push.code !== 0) {
    const detail = oneLine(push.stderr || push.stdout)
    // No configured remote/upstream: not fatal to local completion — report but
    // let the orchestrator decide. We treat it as an error so it's visible.
    return { ok: false, committed, error: `git push 失败: ${detail}` }
  }
  return { ok: true, committed }
}

/** Collapse multi-line git output into a single trimmed line for the UI. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
}
