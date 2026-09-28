/**
 * Codex's Git-metadata write compensation (2026-09-28).
 *
 * A worktree's `.git` is a FILE pointing at the main repository's git dir
 * (`git worktree add`), which lives OUTSIDE the worktree. A `workspace-write`
 * sandbox therefore permits editing the working tree but denies every write the
 * agent needs to record a commit — `git add` (index), `git commit` (objects,
 * refs) — because all of it lands in the common git dir, not in `cwd`.
 *
 * The fix is a BOUNDED compensation, not a wider sandbox: the common git dir is
 * appended to `ThreadOptions.additionalDirectories` (→ codex `--add-dir`), so the
 * agent can write exactly that one directory and nothing else. This keeps
 * "automation may write Git metadata" without promoting the whole cell to
 * `danger-full-access`, and it lives entirely inside the codex adapter — the
 * neutral layer never learns that Codex has this shape.
 */
import { execFile } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'

/** Bounded so a hung `git` probe cannot stall session startup. */
const GIT_PROBE_TIMEOUT_MS = 5_000

/** The seam unit tests replace to avoid touching a real repository. */
export type GitCommonDirResolver = (cwd: string) => Promise<string | null>

/**
 * Resolve the main repository's git directory for `cwd` via
 * `git rev-parse --path-format=absolute --git-common-dir` — the one git fact
 * that answers "where do index/refs/objects actually live for this checkout".
 * Returns the absolute path, or `null` when cwd is not a repository, git is not
 * installed, or the probe fails. Never rejects.
 */
export const resolveGitCommonDir: GitCommonDirResolver = (cwd) =>
  new Promise((resolvePath) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { timeout: GIT_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' as const },
      (err, stdout) => {
        if (err) {
          resolvePath(null)
          return
        }
        const raw = stdout.trim()
        if (!raw) {
          resolvePath(null)
          return
        }
        // `--path-format=absolute` already yields an absolute path; the resolve()
        // is a no-op guard for older git that ignores the flag and echoes a
        // relative path against cwd.
        resolvePath(isAbsolute(raw) ? raw : resolve(cwd, raw))
      },
    )
  })
