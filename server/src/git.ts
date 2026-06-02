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
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

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

/** A `.git` marker (dir, file, or worktree pointer) makes `dir` a repo root. */
function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

// Heavy / irrelevant directories we never descend into while hunting for repos.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache'])

/**
 * Find git repositories under `root` (excluding `root` itself). A directory that
 * is itself a repo is a boundary — we record it and do NOT descend (nested
 * repos/submodules below it are treated as part of it). Bounded depth and a skip
 * list keep the scan cheap on a large workspace.
 */
function discoverSubRepos(root: string, maxDepth = 6): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      const child = join(dir, e.name)
      if (isGitRepo(child)) {
        found.push(child) // boundary — don't descend
        continue
      }
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return found.sort()
}

/**
 * Single-repo commit+push, scoped to one repo root. Stage everything, commit with
 * `message` (only if there are changes), and **always push**. The dev-skill agent
 * may have already committed its own work, leaving the tree clean — so an empty
 * stage is NOT a no-op: we still push so those local commits reach the remote.
 * `label` prefixes error reasons (empty for the project-root repo). A push failure
 * is a hard stop (work is committed locally but not shared).
 */
async function commitAndPushRepo(
  repo: string,
  message: string,
  label: string,
): Promise<{ ok: boolean; committed: boolean; error?: string }> {
  const prefix = label ? `子仓库 ${label}: ` : ''
  const add = await git(repo, ['-C', repo, 'add', '-A'])
  if (add.code !== 0)
    return { ok: false, committed: false, error: `${prefix}git add 失败: ${oneLine(add.stderr)}` }

  // Commit only when something is staged; an empty tree means the agent already
  // committed (or there was nothing to change) — fall through to push regardless.
  const status = await git(repo, ['-C', repo, 'status', '--porcelain'])
  const hasChanges = status.code === 0 && status.stdout.trim() !== ''
  let committed = false
  if (hasChanges) {
    const commit = await git(repo, ['-C', repo, 'commit', '-m', message])
    if (commit.code !== 0) {
      return {
        ok: false,
        committed: false,
        error: `${prefix}git commit 失败: ${oneLine(commit.stderr || commit.stdout)}`,
      }
    }
    committed = true
  }

  const push = await git(repo, ['-C', repo, 'push'])
  // "Everything up-to-date" exits 0. A real failure (no upstream, rejected, auth)
  // is a hard stop.
  if (push.code !== 0) {
    return {
      ok: false,
      committed,
      error: `${prefix}git push 失败: ${oneLine(push.stderr || push.stdout)}`,
    }
  }
  return { ok: true, committed }
}

/** True if `repo` has local commits ahead of its configured upstream. */
async function isAhead(repo: string): Promise<boolean> {
  const r = await git(repo, ['-C', repo, 'rev-list', '--count', '@{u}..HEAD'])
  return r.code === 0 && r.stdout.trim() !== '' && r.stdout.trim() !== '0'
}

/**
 * Commit & push the work a finished automation turn produced.
 *
 * If `projectPath` is itself a git repo (root has `.git`), behaviour is the
 * classic single-repo path — unchanged. Otherwise the workspace root holds one or
 * more git repos in subdirectories: we discover them and commit each **affected**
 * repo independently. `git -C <repo> add -A` naturally scopes staging to that
 * repo, so changed files group to their owning repo by location. A repo counts as
 * affected when its working tree is dirty OR it has local commits ahead of upstream
 * (the dev skill may have self-committed in a subrepo); untouched repos are left
 * alone. Any repo's push failure is a hard stop, and the error names the repo.
 * Finding no git repo at all is also an error (nothing can be committed).
 */
export async function commitAndPush(
  projectPath: string,
  message: string,
): Promise<{ ok: boolean; committed: boolean; error?: string }> {
  if (isGitRepo(projectPath)) {
    return commitAndPushRepo(projectPath, message, '')
  }

  const repos = discoverSubRepos(projectPath)
  if (repos.length === 0) {
    return { ok: false, committed: false, error: '工作区内未找到 git 仓库,无法提交' }
  }

  let anyCommitted = false
  for (const repo of repos) {
    const label = relative(projectPath, repo) || repo
    const status = await git(repo, ['-C', repo, 'status', '--porcelain'])
    if (status.code !== 0) {
      return {
        ok: false,
        committed: anyCommitted,
        error: `子仓库 ${label}: git status 失败: ${oneLine(status.stderr)}`,
      }
    }
    const dirty = status.stdout.trim() !== ''
    // Clean tree with nothing ahead of upstream (or no upstream) → untouched repo,
    // leave it alone rather than pushing every repo in the workspace.
    if (!dirty && !(await isAhead(repo))) continue

    const res = await commitAndPushRepo(repo, message, label)
    if (!res.ok) return { ok: false, committed: anyCommitted || res.committed, error: res.error }
    anyCommitted = anyCommitted || res.committed
  }
  return { ok: true, committed: anyCommitted }
}

/** Collapse multi-line git output into a single trimmed line for the UI. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
}
