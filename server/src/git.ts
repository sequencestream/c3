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

/**
 * Why a commit/push attempt failed, so the automation orchestrator can decide
 * whether to self-heal (`commit-hook` — a pre-commit lint failure is retryable)
 * or stop hard (`other` — push rejected, no upstream, auth, conflict-state, no
 * repo: a human must look). Defaults to `other` — only a clearly lint/hook-shaped
 * commit failure is `commit-hook`.
 */
export type CommitFailureKind = 'commit-hook' | 'other'

export interface CommitResult {
  ok: boolean
  committed: boolean
  error?: string
  /** Only meaningful when `ok` is false; absent on success. */
  failure?: CommitFailureKind
}

// Markers that a non-zero `git commit` failed inside the pre-commit hook chain
// (lint-staged → eslint/prettier), as opposed to git itself rejecting the commit.
const LINT_HOOK_MARKERS = ['eslint', 'prettier', 'lint-staged', 'husky', 'pre-commit', '✖']

/**
 * Classify a failed `git commit`'s combined output: `commit-hook` when it carries
 * a lint/format pre-commit-hook signature (so it may be auto-fixable), else
 * `other`. Pure (string in, kind out) so the heuristic is unit-testable.
 */
export function classifyCommitFailure(output: string): CommitFailureKind {
  const hay = output.toLowerCase()
  return LINT_HOOK_MARKERS.some((m) => hay.includes(m.toLowerCase())) ? 'commit-hook' : 'other'
}

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

/** A `.git` marker (dir, file, or worktree pointer) makes `dir` a repo root. */
function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/**
 * Working-tree change summary for one repo: `git diff HEAD --stat` for tracked
 * edits PLUS the list of untracked new files (`git ls-files --others`), which a
 * bare `diff HEAD` omits — a dev agent creating new-but-uncommitted files is real
 * evidence the judge must see. Read-only (never mutates the index). Empty on a
 * clean tree or git error.
 */
async function diffStatRepo(repo: string): Promise<string> {
  const diff = await git(repo, ['-C', repo, 'diff', 'HEAD', '--stat'])
  const others = await git(repo, ['-C', repo, 'ls-files', '--others', '--exclude-standard'])
  const parts: string[] = []
  if (diff.code === 0 && diff.stdout.trim()) parts.push(diff.stdout.trim())
  if (others.code === 0 && others.stdout.trim()) {
    const files = others.stdout
      .trim()
      .split('\n')
      .map((f) => ` ${f} (new file, untracked)`)
      .join('\n')
    parts.push(files)
  }
  return parts.join('\n')
}

/** `git log --oneline -n` for one repo; empty on error. */
async function recentLogRepo(repo: string, n: number): Promise<string> {
  const r = await git(repo, ['-C', repo, 'log', '--oneline', `-${n}`])
  return r.code === 0 ? r.stdout.trim() : ''
}

/**
 * Collect each affected sub-repo's evidence and label it with the repo's path
 * relative to `root`, so the judge sees WHICH repo changed in a multi-repo
 * workspace. Repos with no output are dropped; the surviving blocks are joined.
 */
async function collectFromSubRepos(
  root: string,
  perRepo: (repo: string) => Promise<string>,
): Promise<string> {
  const parts: string[] = []
  for (const repo of discoverSubRepos(root)) {
    const out = await perRepo(repo)
    if (out) parts.push(`# 仓库 ${relative(root, repo) || repo}\n${out}`)
  }
  return parts.join('\n\n')
}

/**
 * `git diff` summary as objective evidence for the completion judge.
 *
 * **Multi-repo aware, mirroring {@link commitAndPush}:** if `projectPath` is
 * itself a repo, report that one repo (classic path); otherwise the workspace
 * root holds repos in subdirectories — sum each sub-repo's diff, labelled by repo.
 * This stops evidence from being permanently empty just because the root isn't a
 * git repo and the changes live in a sub-repo. Empty string when nothing changed
 * or git errors (the judge then leans on the assistant message alone).
 */
export async function gitDiffStat(projectPath: string): Promise<string> {
  if (isGitRepo(projectPath)) return diffStatRepo(projectPath)
  return collectFromSubRepos(projectPath, diffStatRepo)
}

/**
 * Recent commit subjects (oneline) as completion evidence for the judge.
 * **Multi-repo aware** like {@link gitDiffStat}: a root repo reports its own log;
 * otherwise each sub-repo's recent log is summed and labelled by repo.
 */
export async function gitRecentLog(projectPath: string, n = 5): Promise<string> {
  if (isGitRepo(projectPath)) return recentLogRepo(projectPath, n)
  return collectFromSubRepos(projectPath, (repo) => recentLogRepo(repo, n))
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
): Promise<CommitResult> {
  const prefix = label ? `子仓库 ${label}: ` : ''
  const add = await git(repo, ['-C', repo, 'add', '-A'])
  if (add.code !== 0)
    return {
      ok: false,
      committed: false,
      error: `${prefix}git add 失败: ${oneLine(add.stderr)}`,
      failure: 'other',
    }

  // Commit only when something is staged; an empty tree means the agent already
  // committed (or there was nothing to change) — fall through to push regardless.
  const status = await git(repo, ['-C', repo, 'status', '--porcelain'])
  const hasChanges = status.code === 0 && status.stdout.trim() !== ''
  let committed = false
  if (hasChanges) {
    const commit = await git(repo, ['-C', repo, 'commit', '-m', message])
    if (commit.code !== 0) {
      // Classify so the orchestrator can self-heal a lint/pre-commit-hook failure
      // (retryable) versus stop hard on anything else (RM-A6).
      const out = commit.stderr || commit.stdout
      return {
        ok: false,
        committed: false,
        error: `${prefix}git commit 失败: ${oneLine(out)}`,
        failure: classifyCommitFailure(out),
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
      failure: 'other',
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
export async function commitAndPush(projectPath: string, message: string): Promise<CommitResult> {
  if (isGitRepo(projectPath)) {
    return commitAndPushRepo(projectPath, message, '')
  }

  const repos = discoverSubRepos(projectPath)
  if (repos.length === 0) {
    return {
      ok: false,
      committed: false,
      error: '工作区内未找到 git 仓库,无法提交',
      failure: 'other',
    }
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
        failure: 'other',
      }
    }
    const dirty = status.stdout.trim() !== ''
    // Clean tree with nothing ahead of upstream (or no upstream) → untouched repo,
    // leave it alone rather than pushing every repo in the workspace.
    if (!dirty && !(await isAhead(repo))) continue

    const res = await commitAndPushRepo(repo, message, label)
    // Propagate the per-repo failure kind so the orchestrator's lint self-heal
    // triggers on a sub-repo's pre-commit-hook failure too.
    if (!res.ok)
      return {
        ok: false,
        committed: anyCommitted || res.committed,
        error: res.error,
        failure: res.failure,
      }
    anyCommitted = anyCommitted || res.committed
  }
  return { ok: true, committed: anyCommitted }
}

/** Collapse multi-line git output into a single trimmed line for the UI. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
}
