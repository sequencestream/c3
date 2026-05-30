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

/**
 * Stage everything, commit with `message`, and push. Returns `{ ok: true }` on
 * success (including a no-op when there's nothing to commit), or `{ ok: false,
 * error }` with a one-line reason the orchestrator surfaces on the automation
 * button. A push failure is a hard stop (the work is committed locally but not
 * shared).
 */
export async function commitAndPush(
  projectPath: string,
  message: string,
): Promise<{ ok: boolean; committed: boolean; error?: string }> {
  const add = await git(projectPath, ['-C', projectPath, 'add', '-A'])
  if (add.code !== 0)
    return { ok: false, committed: false, error: `git add 失败: ${oneLine(add.stderr)}` }

  // Nothing staged ⇒ the run produced no file changes. Treat as a successful
  // no-op so automation moves on (the judge already deemed it complete).
  const status = await git(projectPath, ['-C', projectPath, 'status', '--porcelain'])
  if (status.code === 0 && status.stdout.trim() === '') {
    return { ok: true, committed: false }
  }

  const commit = await git(projectPath, ['-C', projectPath, 'commit', '-m', message])
  if (commit.code !== 0) {
    return {
      ok: false,
      committed: false,
      error: `git commit 失败: ${oneLine(commit.stderr || commit.stdout)}`,
    }
  }

  const push = await git(projectPath, ['-C', projectPath, 'push'])
  if (push.code !== 0) {
    return {
      ok: false,
      committed: true,
      error: `git push 失败: ${oneLine(push.stderr || push.stdout)}`,
    }
  }
  return { ok: true, committed: true }
}

/** Collapse multi-line git output into a single trimmed line for the UI. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
}
