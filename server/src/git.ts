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
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { FileGitStatus, IntentPrStatus } from '@ccc/shared/protocol'

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
  return run('git', cwd, args)
}

/**
 * Run an arbitrary binary in `cwd`; resolve with stdout/stderr/exit code (never
 * rejects). `code` is the process exit code, or `-1` when the binary itself could
 * not be spawned (ENOENT — not installed), so callers can tell "command missing"
 * apart from "command ran and failed".
 */
function run(
  bin: string,
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const errno = err as (NodeJS.ErrnoException & { code?: unknown }) | null
      const code =
        errno && errno.code === 'ENOENT'
          ? -1
          : errno && typeof errno.code === 'number'
            ? (errno.code as number)
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
 * Return the current git branch name for a repo directory, or `null` when the
 * directory isn't a git repo, git is unavailable, or HEAD is detached.
 */
export async function getCurrentBranch(workspacePath: string): Promise<string | null> {
  const res = await git(workspacePath, ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (res.code !== 0 || !res.stdout.trim()) return null
  const branch = res.stdout.trim()
  // HEAD detached → `rev-parse --abbrev-ref HEAD` returns "HEAD"
  return branch === 'HEAD' ? null : branch
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
 * **Multi-repo aware, mirroring {@link commitAndPush}:** if `workspacePath` is
 * itself a repo, report that one repo (classic path); otherwise the workspace
 * root holds repos in subdirectories — sum each sub-repo's diff, labelled by repo.
 * This stops evidence from being permanently empty just because the root isn't a
 * git repo and the changes live in a sub-repo. Empty string when nothing changed
 * or git errors (the judge then leans on the assistant message alone).
 */
export async function gitDiffStat(workspacePath: string): Promise<string> {
  if (isGitRepo(workspacePath)) return diffStatRepo(workspacePath)
  return collectFromSubRepos(workspacePath, diffStatRepo)
}

/**
 * Per-repo HEAD commit, keyed by repo path. Multi-repo aware (mirrors
 * {@link gitDiffStat}): the dev directory itself when it is a repo, else each
 * sub-repo under it. A repo whose HEAD cannot be resolved is omitted. Used to
 * capture a fast-mode turn's git baseline at launch.
 */
export async function gitHeadCommits(devDir: string): Promise<Record<string, string>> {
  const repos = isGitRepo(devDir) ? [devDir] : discoverSubRepos(devDir)
  const out: Record<string, string> = {}
  for (const repo of repos) {
    const res = await git(repo, ['-C', repo, 'rev-parse', 'HEAD'])
    if (res.code === 0 && res.stdout.trim()) out[repo] = res.stdout.trim()
  }
  return out
}

/** One parsed `git diff --numstat` entry. */
export interface GitNumstatEntry {
  /** Diff path (a rename reports the target/new path once). */
  path: string
  additions: number
  deletions: number
  /** True when git reported `-` (binary) instead of a numeric count. */
  binary: boolean
}

/**
 * Parse a repo's `git diff --numstat` output. With `ref`, diffs the working tree
 * (HEAD plus uncommitted tracked changes) against that commit — i.e. everything
 * that changed since the baseline, committed or not. Without `ref`, only the
 * uncommitted working-tree changes. Empty on error or when nothing changed.
 */
export async function gitNumstat(repo: string, ref?: string): Promise<GitNumstatEntry[]> {
  const args = ref ? ['diff', '--numstat', ref] : ['diff', '--numstat']
  const res = await git(repo, ['-C', repo, ...args])
  if (res.code !== 0) return []
  const out: GitNumstatEntry[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    const [a, d, ...rest] = line.split('\t')
    const path = rest.join('\t')
    if (!path) continue
    if (a === '-' || d === '-') {
      out.push({ path, additions: 0, deletions: 0, binary: true })
    } else {
      out.push({ path, additions: Number(a) || 0, deletions: Number(d) || 0, binary: false })
    }
  }
  return out
}

/** Untracked files in a repo (`git ls-files --others --exclude-standard`), sorted. */
export async function gitUntracked(repo: string): Promise<string[]> {
  const res = await git(repo, ['-C', repo, 'ls-files', '--others', '--exclude-standard'])
  if (res.code !== 0) return []
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
}

/**
 * Recent commit subjects (oneline) as completion evidence for the judge.
 * **Multi-repo aware** like {@link gitDiffStat}: a root repo reports its own log;
 * otherwise each sub-repo's recent log is summed and labelled by repo.
 */
export async function gitRecentLog(workspacePath: string, n = 5): Promise<string> {
  if (isGitRepo(workspacePath)) return recentLogRepo(workspacePath, n)
  return collectFromSubRepos(workspacePath, (repo) => recentLogRepo(repo, n))
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

// ---------------------------------------------------------------------------
// Read-only working-tree status snapshot (decorates the Files file tree)
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain -z --untracked-files=all` output into a map of
 * repo-relative path → {@link FileGitStatus}. NUL (`-z`) framing keeps spaces,
 * quotes and non-ASCII bytes in paths intact (no C-quoting to undo).
 *
 * Status columns are `XY`: `X` the index, `Y` the working tree. `??` ⇒
 * `untracked`; `X ∈ {A,M}` ⇒ `staged`; `Y === 'M'` ⇒ `modified`; flags compose
 * (`MM`/`AM` are staged **and** modified). Renames/copies carry a trailing
 * old-path token we consume and drop. Deletions, renames, copies and conflicts
 * never enter the snapshot. Pure (string in, map out) so it is unit-testable.
 */
export function parsePorcelainStatus(z: string): Record<string, FileGitStatus> {
  const out: Record<string, FileGitStatus> = {}
  const tokens = z.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]
    // Each record is `XY <path>`: 2 status chars + a space + the path.
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)

    // Renames/copies emit a second NUL token (the OLD path) — skip it and the
    // whole record: neither the new nor old path enters the snapshot.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      i++
      continue
    }
    // Unmerged/conflict states (`DD`, `AA`, or any `U`) are excluded.
    if (x === 'U' || y === 'U' || (x === 'D' && y === 'D') || (x === 'A' && y === 'A')) continue
    // Working-tree deletions never appear as tree nodes — drop them.
    if (y === 'D') continue

    const untracked = x === '?' && y === '?'
    const staged = x === 'A' || x === 'M'
    const modified = y === 'M'
    if (!untracked && !staged && !modified) continue // pure staged deletion etc.
    out[path] = { modified, untracked, staged }
  }
  return out
}

/** Run the read-only porcelain status in one repo; `{}` on any git error. */
async function statusForRepo(repo: string, prefix: string): Promise<Record<string, FileGitStatus>> {
  const res = await git(repo, ['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all'])
  if (res.code !== 0) return {}
  const parsed = parsePorcelainStatus(res.stdout)
  if (!prefix) return parsed
  const out: Record<string, FileGitStatus> = {}
  for (const [p, flags] of Object.entries(parsed)) out[`${prefix}/${p}`] = flags
  return out
}

/**
 * Read-only working-tree status for a whole workspace, keyed by workspace-relative
 * path. **Multi-repo aware** like {@link commitAndPush}: a root that is itself a
 * repo reports that repo directly; otherwise each discovered sub-repo is queried
 * and its paths prefixed with the repo's path relative to the root, so the output
 * is always workspace-relative. A non-git root (no root repo, no sub-repos) or any
 * single sub-repo failure degrades to an empty/partial map — it never throws, and
 * never returns absolute paths or git stderr.
 */
export async function collectGitStatus(
  workspacePath: string,
): Promise<Record<string, FileGitStatus>> {
  if (isGitRepo(workspacePath)) return statusForRepo(workspacePath, '')
  const out: Record<string, FileGitStatus> = {}
  for (const repo of discoverSubRepos(workspacePath)) {
    const prefix = relative(workspacePath, repo).split(sep).join('/')
    Object.assign(out, await statusForRepo(repo, prefix))
  }
  return out
}

/**
 * Single-repo commit+push, scoped to one repo root. Stage everything, commit with
 * `message` (only if there are changes), and **always push**. The dev-skill agent
 * may have already committed its own work, leaving the tree clean — so an empty
 * stage is NOT a no-op: we still push so those local commits reach the remote.
 * `label` prefixes error reasons (empty for the project-root repo). A push failure
 * is a hard stop (work is committed locally but not shared).
 */
/**
 * Resolve the remote to push to: prefer `origin`, else the first configured
 * remote, else null (no remote at all — caller treats that as a hard failure).
 */
async function resolveRemote(repo: string): Promise<string | null> {
  const r = await git(repo, ['-C', repo, 'remote'])
  if (r.code !== 0) return null
  const remotes = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (remotes.length === 0) return null
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/**
 * Push `repo`'s current branch. A fresh `intent/*` branch (worktree- or
 * current-branch-mode) has no configured upstream, so a bare `git push` fails
 * with "has no upstream branch". We don't rely on the user's global
 * `push.autoSetupRemote`: on that specific failure we retry with
 * `git push -u <remote> HEAD`, which both pushes and sets the upstream. The
 * happy path (upstream already set) is unchanged — bare push, no extra git call.
 */
async function pushRepo(repo: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const push = await git(repo, ['-C', repo, 'push'])
  if (push.code === 0) return push
  const out = push.stderr || push.stdout
  if (!/no upstream branch|has no upstream/i.test(out)) return push
  const remote = await resolveRemote(repo)
  if (!remote) return push
  return git(repo, ['-C', repo, 'push', '-u', remote, 'HEAD'])
}

async function commitAndPushRepo(
  repo: string,
  message: string,
  label: string,
  onPhase?: CommitPhaseListener,
): Promise<CommitResult> {
  const prefix = label ? `子仓库 ${label}: ` : ''
  onPhase?.('committing')
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

  onPhase?.('pushing')
  const push = await pushRepo(repo)
  // "Everything up-to-date" exits 0. A real failure (rejected, auth) is a hard
  // stop. A missing upstream is NOT one: pushRepo self-heals it (see below).
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

/**
 * Observer of {@link commitAndPush}'s two internal boundaries, so a caller can
 * report "committing" versus "pushing" progress. Purely observational: it never
 * changes what is committed / pushed, nor the returned result. In a multi-repo
 * workspace it fires once per affected repo, so a consumer that needs one-way
 * progress must de-duplicate.
 */
export type CommitPhaseListener = (phase: 'committing' | 'pushing') => void

/** True if `repo` has local commits ahead of its configured upstream. */
async function isAhead(repo: string): Promise<boolean> {
  const r = await git(repo, ['-C', repo, 'rev-list', '--count', '@{u}..HEAD'])
  return r.code === 0 && r.stdout.trim() !== '' && r.stdout.trim() !== '0'
}

/**
 * Commit & push the work a finished automation turn produced.
 *
 * If `workspacePath` is itself a git repo (root has `.git`), behaviour is the
 * classic single-repo path — unchanged. Otherwise the workspace root holds one or
 * more git repos in subdirectories: we discover them and commit each **affected**
 * repo independently. `git -C <repo> add -A` naturally scopes staging to that
 * repo, so changed files group to their owning repo by location. A repo counts as
 * affected when its working tree is dirty OR it has local commits ahead of upstream
 * (the dev skill may have self-committed in a subrepo); untouched repos are left
 * alone. Any repo's push failure is a hard stop, and the error names the repo.
 * Finding no git repo at all is also an error (nothing can be committed).
 *
 * `onPhase` is an optional {@link CommitPhaseListener} for progress reporting; it
 * observes the commit/push boundary without changing any of the above.
 */
export async function commitAndPush(
  workspacePath: string,
  message: string,
  onPhase?: CommitPhaseListener,
): Promise<CommitResult> {
  if (isGitRepo(workspacePath)) {
    return commitAndPushRepo(workspacePath, message, '', onPhase)
  }

  const repos = discoverSubRepos(workspacePath)
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
    const label = relative(workspacePath, repo) || repo
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

    const res = await commitAndPushRepo(repo, message, label, onPhase)
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

/** True if `repo`'s working tree is dirty (tracked edits or untracked files). */
async function isDirty(repo: string): Promise<boolean> {
  const status = await git(repo, ['-C', repo, 'status', '--porcelain'])
  return status.code === 0 && status.stdout.trim() !== ''
}

/**
 * Whether a workspace has anything the cleanup could commit or push: a dirty
 * working tree OR local commits ahead of upstream, in the root repo (single-repo
 * path) or in ANY sub-repo (multi-repo workspace root). Mirrors {@link commitAndPush}'s
 * repo discovery so "no changes" here means "nothing for commitAndPush to do".
 */
export async function hasCommittableChanges(workspacePath: string): Promise<boolean> {
  if (isGitRepo(workspacePath)) {
    return (await isDirty(workspacePath)) || (await isAhead(workspacePath))
  }
  for (const repo of discoverSubRepos(workspacePath)) {
    if ((await isDirty(repo)) || (await isAhead(repo))) return true
  }
  return false
}

/**
 * Whether a single repo differs from `baseBranch`: tracked-file diffs against
 * the base, OR commits in HEAD that the base doesn't contain. Unlike
 * {@link hasCommittableChanges} this never consults the upstream, so a worktree
 * branch without tracking config is still recognised as having work.
 *
 * The base ref is resolved BEFORE comparing: fetch `baseBranch` from the repo's
 * remote (prefer `origin`, else the first configured remote — mirroring
 * {@link commitAndPush}), and compare against the freshly-updated
 * `<remote>/<base>` when it resolves; fall back to the local `<base>` ref when
 * the remote ref is unavailable. A fetch failure alone is NOT "no diff" — only
 * when neither the remote nor the local base ref can be resolved does the gate
 * reject with a clear "target branch unresolvable" error, so a misconfigured
 * workspace fails here (before any commit/push/forge work) instead of passing
 * through to an error that is harder to attribute downstream.
 *
 * Note `git diff <base> --stat` ignores untracked files — an untracked-only
 * tree with no commits ahead of the base reads as false.
 *
 * @throws {Error} when `baseBranch` resolves neither as `<remote>/<base>` (after
 *   fetch) nor as a local ref — the caller must treat that as a hard rejection.
 */
export async function hasDiffAgainstBase(repoPath: string, baseBranch: string): Promise<boolean> {
  const remote = await resolveRemote(repoPath)
  if (remote) await git(repoPath, ['-C', repoPath, 'fetch', remote, baseBranch])

  const remoteRef = remote ? `${remote}/${baseBranch}` : null
  const resolves = async (ref: string): Promise<boolean> => {
    const r = await git(repoPath, ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref])
    return r.code === 0 && r.stdout.trim() !== ''
  }

  let baseRef: string | null = null
  if (remoteRef && (await resolves(remoteRef))) baseRef = remoteRef
  if (!baseRef && (await resolves(baseBranch))) baseRef = baseBranch
  if (!baseRef) {
    throw new Error(`目标分支 ${baseBranch} 无法解析(本地与远端均无该分支)`)
  }

  const diff = await git(repoPath, ['-C', repoPath, 'diff', baseRef, '--stat'])
  if (diff.code === 0 && diff.stdout.trim() !== '') return true

  const ahead = await git(repoPath, ['-C', repoPath, 'rev-list', '--count', `${baseRef}..HEAD`])
  return ahead.code === 0 && ahead.stdout.trim() !== '' && ahead.stdout.trim() !== '0'
}

/**
 * The current HEAD commit hash of a workspace's repo, or `null` when it can't be
 * resolved (not a repo / git error). For a multi-repo workspace root (root is not
 * itself a repo), reports the first discovered sub-repo's HEAD — a best-effort
 * single value for the intent's `latestCommitHash`.
 */
export async function getHeadCommit(workspacePath: string): Promise<string | null> {
  const repo = isGitRepo(workspacePath) ? workspacePath : discoverSubRepos(workspacePath)[0]
  if (!repo) return null
  const r = await git(repo, ['-C', repo, 'rev-parse', 'HEAD'])
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

// ---------------------------------------------------------------------------
// Delivery branch lifecycle (ADR-0036 slice 2/3)
//
// A delivery must have ONE real remote branch to collect every associated
// intent's PR. These helpers back the explicit `init_delivery_branch` action:
// the branch is created/bound on the remote, never silently overwritten, and
// the baseline is the JUST-FETCHED `origin/<base_branch>` HEAD — never a local
// ref (a stale local ref would root the delivery behind the team's mainline).
// All async (unlike `createWorktree`'s sync `execFileSync`): branch init is a
// standalone user action, not a step that must block an automation FSM.
// ---------------------------------------------------------------------------

/**
 * Whether a workspace is "multi-repo" for the delivery-branch purpose: the root
 * is not itself a git repo AND sub-repos are discovered beneath it. Mirrors
 * {@link commitAndPush}'s repo discovery so the verdict matches what would
 * actually happen there. A root that is a repo (single-repo classic path) is
 * NOT multi-repo even if nested repos lurk inside it (they are treated as part
 * of the boundary repo). A single sub-repo under a non-repo root counts as
 * multi-repo: `createDeliveryBranch` must operate on the ROOT, and a root that
 * is not a repo cannot host the branch.
 */
export function isMultiRepoWorkspace(workspacePath: string): boolean {
  return !isGitRepo(workspacePath) && discoverSubRepos(workspacePath).length > 0
}

/**
 * Fetch `baseBranch` from the repo's remote (async) and return the ref to root a
 * new branch at — `<remote>/<baseBranch>` when the fetch succeeded and the ref
 * resolves, else `null` (no remote / offline / branch missing). Fetch never
 * merges, so it cannot diverge. The async sibling of
 * `features/intents/worktree.ts`'s synchronous `fetchRemoteBase`; branch init is
 * a standalone user action and must not block a synchronous FSM.
 */
export async function fetchRemoteBaseAsync(
  repoPath: string,
  baseBranch: string,
): Promise<string | null> {
  const remote = await resolveRemote(repoPath)
  if (!remote) return null
  const res = await git(repoPath, ['-C', repoPath, 'fetch', remote, baseBranch])
  if (res.code !== 0) return null
  const verify = await git(repoPath, [
    '-C',
    repoPath,
    'rev-parse',
    '--verify',
    '--quiet',
    `${remote}/${baseBranch}`,
  ])
  return verify.code === 0 && verify.stdout.trim() ? `${remote}/${baseBranch}` : null
}

/**
 * The HEAD commit hash of `<remote>/<branchName>` on the remote, or `null` when
 * the branch does not exist there (or the remote/ls-remote is unavailable). Used
 * by the orphan-defense check: compare the remote branch's head against the
 * fetched baseline to tell "my own failed push" from "someone else's branch".
 */
export async function remoteBranchHead(
  repoPath: string,
  branchName: string,
): Promise<string | null> {
  const remote = await resolveRemote(repoPath)
  if (!remote) return null
  const res = await git(repoPath, ['-C', repoPath, 'ls-remote', '--heads', remote, branchName])
  if (res.code !== 0) return null
  const want = `refs/heads/${branchName}`
  for (const line of res.stdout.split('\n')) {
    const [hash, ref] = line.trim().split(/\s+/)
    if (ref === want && /^[0-9a-f]+$/i.test(hash)) return hash
  }
  return null
}

/**
 * The full commit hash a ref resolves to (`git rev-parse --verify`), or `null`
 * when it does not resolve. The ref is expected to be `<remote>/<baseBranch>`
 * (the just-fetched baseline) — the "expected start" the orphan-defense compares
 * the remote branch head against.
 */
export async function resolveRefHead(repoPath: string, ref: string): Promise<string | null> {
  const res = await git(repoPath, ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref])
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null
}

/**
 * Create a delivery branch on the remote, rooted at the just-fetched
 * `origin/<baseBranch>` HEAD. Semantics deliberately DISTINCT from
 * {@link createWorktree}: that helper makes an intent's isolated worktree +
 * local branch; this one only creates and pushes the ONE remote branch a
 * delivery integrates into — no checkout, no worktree.
 *
 * Internal order: `fetch remote <baseBranch>` → `git branch <branchName>
 * <remote>/<baseBranch>` → `git push -u origin <branchName>`.
 *
 * A push rejected because the remote branch appeared meanwhile (race) is a
 * branch conflict (`errorKind: 'branchConflict'`) — never force-pushed. The
 * caller writes the DB ONLY on `ok: true`; if that write then fails, the next
 * retry idempotently binds the orphan through the remote-head match.
 */
export interface CreateDeliveryBranchResult {
  ok: boolean
  /** Human-readable failure reason (the caller frames it with a `detail`). */
  error?: string
  /**
   * Machine-readable failure class: `branchConflict` maps to the
   * `delivery.branchConflict` UI code (remote/locally occupied — never
   * overwritten), `other` to a generic `detail` error. Absent on success.
   */
  errorKind?: 'branchConflict' | 'other'
}

/** Coarse phases inside {@link createDeliveryBranch}, for progress reporting. */
export type DeliveryBranchCreatePhase = 'creating' | 'pushing'

export interface CreateDeliveryBranchOptions {
  /** Observational progress sink; never changes what is created or pushed. */
  onPhase?: (phase: DeliveryBranchCreatePhase) => void
}

/** The first of `refs` that `git rev-parse --verify` resolves, or `null`. */
async function firstResolvableRef(repoPath: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    if (await resolveRefHead(repoPath, ref)) return ref
  }
  return null
}

/** Whether `ancestor` is an ancestor of `descendant`; `null` when undecidable. */
async function isAncestorCommit(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  const res = await git(repoPath, [
    '-C',
    repoPath,
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  ])
  if (res.code === 0) return true
  // git documents exit 1 for "not an ancestor"; anything else (bad ref, not a
  // repo, git missing) is "cannot tell", never a false "no".
  return res.code === 1 ? false : null
}

/**
 * Whether linking an intent to a delivery would produce a BLOATED PR diff: the
 * intent's commits branch off mainline PAST the point the delivery branch forked
 * from it, so a PR `intent head → delivery branch` would carry the whole
 * mainline-vs-delivery-branch difference on top of the intent's own work.
 *
 * The test is on the intent's FORK POINT, not on plain ancestry. Say the
 * delivery branch `d` forked from mainline at `M0` and mainline has since moved
 * to `M5`; an intent branched at `M5` still has `M0` as an ancestor, so an
 * ancestry test would see nothing wrong — yet its PR into `d` shows `M1..M5`
 * plus the intent's commits. So:
 *
 *   fork = merge-base(mainline, intentCommit)   // where the intent left mainline
 *   bloated ⟺ fork is NOT an ancestor of the delivery branch head
 *
 * Purely observational and fail-open: a missing branch, a non-repo path or any
 * git failure returns `false` (no warning), because a warning we cannot justify
 * is worse than no warning. Returns `false` too when there is no delivery branch
 * yet — a branch created later starts at the CURRENT mainline head, which makes
 * the intent's fork point an ancestor by construction.
 */
export async function detectDeliveryDiffBloat(
  repoPath: string,
  intentCommit: string,
  baseBranch: string,
  deliveryBranch: string | null,
): Promise<boolean> {
  if (!deliveryBranch) return false
  const repo = isGitRepo(repoPath) ? repoPath : discoverSubRepos(repoPath)[0]
  if (!repo) return false
  const remote = await resolveRemote(repo)
  const baseRef = await firstResolvableRef(
    repo,
    remote ? [`${remote}/${baseBranch}`, baseBranch] : [baseBranch],
  )
  const deliveryRef = await firstResolvableRef(
    repo,
    remote ? [deliveryBranch, `${remote}/${deliveryBranch}`] : [deliveryBranch],
  )
  if (!baseRef || !deliveryRef) return false
  if (!(await resolveRefHead(repo, intentCommit))) return false
  const forkPoint = await git(repo, ['-C', repo, 'merge-base', baseRef, intentCommit])
  const fork = forkPoint.code === 0 ? forkPoint.stdout.trim() : ''
  if (!fork) return false
  return (await isAncestorCommit(repo, fork, deliveryRef)) === false
}

export async function createDeliveryBranch(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  options?: CreateDeliveryBranchOptions,
): Promise<CreateDeliveryBranchResult> {
  const remote = await resolveRemote(repoPath)
  if (!remote) {
    return { ok: false, error: '工作区未配置 git 远端,无法创建交付分支', errorKind: 'other' }
  }
  const fetch = await git(repoPath, ['-C', repoPath, 'fetch', remote, baseBranch])
  if (fetch.code !== 0) {
    return {
      ok: false,
      error: `fetch 基线 ${baseBranch} 失败: ${oneLine(fetch.stderr || fetch.stdout)}`,
      errorKind: 'other',
    }
  }
  const baseRef = `${remote}/${baseBranch}`
  const verify = await git(repoPath, ['-C', repoPath, 'rev-parse', '--verify', '--quiet', baseRef])
  if (verify.code !== 0 || !verify.stdout.trim()) {
    return {
      ok: false,
      error: `远端基线 ${baseRef} 无法解析`,
      errorKind: 'other',
    }
  }

  options?.onPhase?.('creating')
  const branch = await git(repoPath, ['-C', repoPath, 'branch', branchName, baseRef])
  if (branch.code !== 0) {
    const out = oneLine(branch.stderr || branch.stdout)
    return {
      ok: false,
      error: `git branch 失败: ${out}`,
      errorKind: /already exists/i.test(out) ? 'branchConflict' : 'other',
    }
  }

  options?.onPhase?.('pushing')
  const push = await git(repoPath, ['-C', repoPath, 'push', '-u', remote, branchName])
  if (push.code !== 0) {
    const out = oneLine(push.stderr || push.stdout)
    return {
      ok: false,
      error: `git push 失败: ${out}`,
      // A rejected push (non-fast-forward / fetch-first / ref exists) means the
      // remote branch appeared between our check and the push — a conflict.
      errorKind: /non-fast-forward|fetch first|already exists|refusing/i.test(out)
        ? 'branchConflict'
        : 'other',
    }
  }
  return { ok: true }
}

/**
 * How many commits `aheadRef` holds that `behindRef` does not, or `null` when
 * either ref cannot be resolved. Pure read — resolves the refs it is given and
 * fetches nothing, so a caller that wants a FRESH answer must fetch first.
 */
export async function countCommitsAhead(
  repoPath: string,
  behindRef: string,
  aheadRef: string,
): Promise<number | null> {
  for (const ref of [behindRef, aheadRef]) {
    const verify = await git(repoPath, ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref])
    if (verify.code !== 0 || !verify.stdout.trim()) return null
  }
  const res = await git(repoPath, [
    '-C',
    repoPath,
    'rev-list',
    '--count',
    `${behindRef}..${aheadRef}`,
  ])
  if (res.code !== 0) return null
  const n = Number.parseInt(res.stdout.trim(), 10)
  return Number.isFinite(n) ? n : null
}

/** One coarse phase of a `syncDeliveryMainline` run. */
export type SyncMainlinePhase = 'fetching' | 'merging' | 'pushing'

export interface SyncMainlineResult {
  ok: boolean
  /** Single-line git output when `!ok`; the page shows it verbatim. */
  error?: string
  /** True when the merge stopped on conflicts — the user resolves them, not c3. */
  conflict?: boolean
  /** Commits mainline was ahead by before the merge; `null` when undeterminable. */
  ahead?: number | null
}

/**
 * Merge `origin/<baseBranch>` INTO the delivery branch and push the result — the
 * "同步主线" action, always user-invoked.
 *
 * The point is to move conflict handling EARLIER: a delivery that tracks mainline
 * as it goes reaches its final `verified → delivered` merge close to a
 * fast-forward, instead of discovering weeks of drift at the worst moment. It is
 * never scheduled: a background job that silently rewrites a shared branch — and
 * whose failures nobody reads — is exactly what the never-auto-merge stance
 * exists to prevent.
 *
 * The merge runs in a THROWAWAY detached worktree pointed at the remote delivery
 * tip, so the user's checkout and every intent worktree stay untouched. A
 * conflict aborts the merge and is reported verbatim; nothing is pushed, and c3
 * never picks a resolution.
 */
export async function syncDeliveryMainline(
  repoPath: string,
  branchName: string,
  baseBranch: string,
  onPhase?: (p: SyncMainlinePhase) => void,
): Promise<SyncMainlineResult> {
  const remote = await resolveRemote(repoPath)
  if (!remote) return { ok: false, error: '工作区未配置 git 远端,无法同步主线' }

  onPhase?.('fetching')
  const fetch = await git(repoPath, ['-C', repoPath, 'fetch', remote, baseBranch, branchName])
  if (fetch.code !== 0) {
    return { ok: false, error: `fetch 失败: ${oneLine(fetch.stderr || fetch.stdout)}` }
  }
  const baseRef = `${remote}/${baseBranch}`
  const deliveryRef = `${remote}/${branchName}`
  const ahead = await countCommitsAhead(repoPath, deliveryRef, baseRef)
  if (ahead === null) return { ok: false, error: `远端引用 ${baseRef} / ${deliveryRef} 无法解析` }
  if (ahead === 0) return { ok: true, ahead: 0 }

  // A throwaway worktree keeps the user's checkout and every intent worktree
  // untouched: the merge happens on a detached copy of the remote delivery tip.
  const scratch = join(tmpdir(), `c3-sync-${randomUUID()}`)
  const add = await git(repoPath, [
    '-C',
    repoPath,
    'worktree',
    'add',
    '--detach',
    scratch,
    deliveryRef,
  ])
  if (add.code !== 0) {
    return { ok: false, error: `准备同步工作区失败: ${oneLine(add.stderr || add.stdout)}` }
  }
  try {
    onPhase?.('merging')
    const merge = await git(scratch, ['-C', scratch, 'merge', '--no-edit', baseRef])
    if (merge.code !== 0) {
      const out = oneLine(merge.stderr || merge.stdout)
      await git(scratch, ['-C', scratch, 'merge', '--abort'])
      return { ok: false, conflict: true, error: out, ahead }
    }
    onPhase?.('pushing')
    const push = await git(scratch, ['-C', scratch, 'push', remote, `HEAD:${branchName}`])
    if (push.code !== 0) {
      return { ok: false, error: `git push 失败: ${oneLine(push.stderr || push.stdout)}`, ahead }
    }
    return { ok: true, ahead }
  } finally {
    await git(repoPath, ['-C', repoPath, 'worktree', 'remove', '--force', scratch])
  }
}

/**
 * Delete a LOCAL branch reference (best-effort). Delivery cleanup only ever
 * touches the local ref — the remote branch is never deleted automatically.
 * Returns false when the branch doesn't exist / isn't deletable; the caller
 * treats a missing branch as "nothing to clean".
 */
export async function deleteLocalBranch(repoPath: string, branchName: string): Promise<boolean> {
  const res = await git(repoPath, ['-C', repoPath, 'branch', '-D', branchName])
  return res.code === 0
}

/** Collapse multi-line git output into a single trimmed line for the UI. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** What a local merge trial of the delivery branch into mainline found. */
export interface MergeTrialResult {
  /** `origin/<baseBranch>` head at trial time; `null` when unresolvable. */
  baseSha: string | null
  /** `origin/<branchName>` head at trial time; `null` when unresolvable. */
  headSha: string | null
  /**
   * Conflicting paths, empty when the merge applied cleanly OR the trial could
   * not run at all. The two are deliberately not distinguished: the forge's own
   * "unmergeable" verdict is the fact that matters, and this list is only the
   * explanation offered on top of it.
   */
  conflictFiles: string[]
}

/**
 * Find out WHICH files conflict when the delivery branch merges into mainline,
 * by actually trying it — in a throwaway detached worktree pointed at
 * `origin/<baseBranch>`, exactly like {@link syncDeliveryMainline}. Nothing is
 * committed, nothing is pushed and neither the user's checkout nor any intent
 * worktree is touched.
 *
 * Purely observational: the forge already decided the PR is unmergeable, and this
 * only names the files. Every failure path (no remote, unresolvable refs, worktree
 * setup failure) degrades to an empty list with whatever SHAs could be read.
 */
export async function deliveryMergeTrial(
  repoPath: string,
  branchName: string,
  baseBranch: string,
): Promise<MergeTrialResult> {
  const empty: MergeTrialResult = { baseSha: null, headSha: null, conflictFiles: [] }
  const remote = await resolveRemote(repoPath)
  if (!remote) return empty

  await git(repoPath, ['-C', repoPath, 'fetch', remote, baseBranch, branchName])
  const baseRef = `${remote}/${baseBranch}`
  const headRef = `${remote}/${branchName}`
  const baseSha = await resolveRefHead(repoPath, baseRef)
  const headSha = await resolveRefHead(repoPath, headRef)
  if (!baseSha || !headSha) return { baseSha, headSha, conflictFiles: [] }

  const scratch = join(tmpdir(), `c3-merge-trial-${randomUUID()}`)
  const add = await git(repoPath, ['-C', repoPath, 'worktree', 'add', '--detach', scratch, baseRef])
  if (add.code !== 0) return { baseSha, headSha, conflictFiles: [] }
  try {
    const merge = await git(scratch, [
      '-C',
      scratch,
      'merge',
      '--no-commit',
      '--no-ff',
      '--no-edit',
      headRef,
    ])
    if (merge.code === 0) return { baseSha, headSha, conflictFiles: [] }
    const names = await git(scratch, [
      '-C',
      scratch,
      'diff',
      '--name-only',
      '--diff-filter=U',
      '--relative',
    ])
    const conflictFiles =
      names.code === 0
        ? names.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        : []
    return { baseSha, headSha, conflictFiles }
  } finally {
    await git(scratch, ['-C', scratch, 'merge', '--abort'])
    await git(repoPath, ['-C', repoPath, 'worktree', 'remove', '--force', scratch])
  }
}

// ---------------------------------------------------------------------------
// Forge change-request creation
// ---------------------------------------------------------------------------

/** Supported hosting forges for pull/merge-request creation. */
export type ForgeProvider = 'github' | 'gitlab'

export interface CreatePrResult {
  ok: boolean
  prId?: string
  prUrl?: string
  error?: string
  /**
   * True when the forge CLI is missing or not authenticated. Lets callers surface
   * a distinct install / log-in message versus a generic change-request failure.
   */
  unavailable?: boolean
}

export interface ForgePrStatusResult {
  ok: boolean
  status?: IntentPrStatus
  prUrl?: string
  rawState?: string
  error?: string
  unavailable?: boolean
}

// `gh` prints these when no usable auth token is configured.
const GH_NOT_LOGGED_IN_MARKERS = [
  'gh auth login',
  'not logged',
  'no git remotes found',
  'authentication',
]

// `glab` prints these when no usable auth token is configured.
const GLAB_NOT_LOGGED_IN_MARKERS = [
  'glab auth login',
  'not logged',
  'not authenticated',
  'authentication',
  'unauthorized',
]

/**
 * Detect the forge for `cwd` from its `origin` URL. GitHub is identified by its
 * hostname; every other URL, including self-hosted GitLab, resolves to GitLab.
 * A missing or unreadable origin also deterministically falls back to GitLab.
 */
export async function detectForge(cwd: string): Promise<ForgeProvider> {
  const remote = await git(cwd, ['-C', cwd, 'remote', 'get-url', 'origin'])
  return remote.code === 0 && remote.stdout.includes('github.com') ? 'github' : 'gitlab'
}

/**
 * Create a GitHub Pull Request via the `gh` CLI.
 *
 * Runs `gh pr create --title <title> --body <body>` in `cwd` (the project root).
 * On success, parses the output URL (e.g.
 * `https://github.com/owner/repo/pull/123`) and extracts the PR number.
 * Returns `{ ok, prId, prUrl }` on success, or `{ ok: false, error, unavailable? }`
 * on failure. `unavailable` is set when `gh` is not installed (ENOENT) or not
 * authenticated, so the caller can ask the user to install / log in.
 *
 * `headBranch` is optional — when omitted `gh` uses the current branch.
 * `baseBranch` is REQUIRED (no implicit default): the caller resolves the
 * workspace's effective base (`defaultMainBranch` or explicit `main`) and passes
 * it, so the merge target can never silently fall back to a literal `main`.
 */
export async function createGhPr(
  cwd: string,
  title: string,
  body: string,
  headBranch: string | undefined,
  baseBranch: string,
): Promise<CreatePrResult> {
  const args = ['pr', 'create', '--title', title, '--body', body, '--base', baseBranch]
  if (headBranch) args.push('--head', headBranch)

  const { code, stdout, stderr } = await run('gh', cwd, args)
  if (code === -1) {
    return { ok: false, unavailable: true, error: 'gh CLI 未安装' }
  }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    const notLoggedIn = GH_NOT_LOGGED_IN_MARKERS.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || 'gh pr create 失败',
    }
  }

  // `gh pr create` prints the PR URL to stdout, e.g.
  //   https://github.com/owner/repo/pull/123
  const url = stdout.trim()
  const match = url.match(/\/pull\/(\d+)$/)
  if (match) {
    return { ok: true, prId: match[1], prUrl: url }
  }

  // Fallback: try to parse from stderr (older gh versions) or use the raw URL.
  if (url) {
    return { ok: true, prId: url, prUrl: url }
  }

  return { ok: false, error: 'gh pr create 输出未包含 PR URL' }
}

/**
 * Create a GitLab Merge Request via the `glab` CLI. The result uses the shared
 * change-request contract, including unavailable CLI/authentication failures.
 * `headBranch` is optional; `baseBranch` is REQUIRED (no implicit default) —
 * the caller resolves the workspace's effective base and passes it explicitly.
 */
export async function createGlabMr(
  cwd: string,
  title: string,
  body: string,
  headBranch: string | undefined,
  baseBranch: string,
): Promise<CreatePrResult> {
  const args = [
    'mr',
    'create',
    '--title',
    title,
    '--description',
    body,
    '--target-branch',
    baseBranch,
  ]
  if (headBranch) args.push('--source-branch', headBranch)

  const { code, stdout, stderr } = await run('glab', cwd, args)
  if (code === -1) {
    return { ok: false, unavailable: true, error: 'glab CLI 未安装' }
  }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    const notLoggedIn = GLAB_NOT_LOGGED_IN_MARKERS.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || 'glab mr create 失败',
    }
  }

  const url = stdout.trim()
  const match = url.match(/\/-\/merge_requests\/(\d+)/)
  if (match) {
    return { ok: true, prId: match[1], prUrl: url }
  }

  return { ok: false, error: 'glab mr create 输出未包含 MR URL' }
}

/**
 * Create a pull or merge request through the selected forge. An explicit
 * provider takes precedence; otherwise the repository's origin determines it.
 * `baseBranch` is REQUIRED (no implicit default) — the caller resolves the
 * workspace's effective base (`defaultMainBranch` or explicit `main`) and passes
 * it, so every entry surface shares the same resolved merge target.
 */
export async function createForgePr(
  cwd: string,
  title: string,
  body: string,
  headBranch: string | undefined,
  baseBranch: string,
  providerOverride?: ForgeProvider,
): Promise<CreatePrResult> {
  const provider = providerOverride ?? (await detectForge(cwd))
  return provider === 'github'
    ? createGhPr(cwd, title, body, headBranch, baseBranch)
    : createGlabMr(cwd, title, body, headBranch, baseBranch)
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function normalizeGithubPrStatus(row: Record<string, unknown>): ForgePrStatusResult {
  const state = typeof row.state === 'string' ? row.state.toUpperCase() : ''
  const mergedAt = typeof row.mergedAt === 'string' ? row.mergedAt : ''
  const url = typeof row.url === 'string' ? row.url : undefined
  if (mergedAt || state === 'MERGED')
    return { ok: true, status: 'merged', prUrl: url, rawState: state }
  if (state === 'CLOSED') return { ok: true, status: 'closed', prUrl: url, rawState: state }
  return { ok: true, status: 'reviewing', prUrl: url, rawState: state || undefined }
}

function normalizeGitlabMrStatus(row: Record<string, unknown>): ForgePrStatusResult {
  const state = typeof row.state === 'string' ? row.state.toLowerCase() : ''
  const mergedAt =
    typeof row.merged_at === 'string'
      ? row.merged_at
      : typeof row.mergedAt === 'string'
        ? row.mergedAt
        : ''
  const url =
    typeof row.web_url === 'string'
      ? row.web_url
      : typeof row.webUrl === 'string'
        ? row.webUrl
        : undefined
  if (mergedAt || state === 'merged')
    return { ok: true, status: 'merged', prUrl: url, rawState: state }
  if (state === 'closed') return { ok: true, status: 'closed', prUrl: url, rawState: state }
  return { ok: true, status: 'reviewing', prUrl: url, rawState: state || undefined }
}

export async function getGhPrStatus(cwd: string, prId: string): Promise<ForgePrStatusResult> {
  const { code, stdout, stderr } = await run('gh', cwd, [
    'pr',
    'view',
    prId,
    '--json',
    'state,mergedAt,url',
  ])
  if (code === -1) return { ok: false, unavailable: true, error: 'gh CLI 未安装' }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    const notLoggedIn = GH_NOT_LOGGED_IN_MARKERS.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || 'gh pr view 失败',
    }
  }
  const row = parseJsonObject(stdout)
  if (!row) return { ok: false, error: 'gh pr view 输出不是有效 JSON' }
  return normalizeGithubPrStatus(row)
}

export async function getGlabMrStatus(cwd: string, prId: string): Promise<ForgePrStatusResult> {
  const { code, stdout, stderr } = await run('glab', cwd, ['mr', 'view', prId, '--output', 'json'])
  if (code === -1) return { ok: false, unavailable: true, error: 'glab CLI 未安装' }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    const notLoggedIn = GLAB_NOT_LOGGED_IN_MARKERS.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || 'glab mr view 失败',
    }
  }
  const row = parseJsonObject(stdout)
  if (!row) return { ok: false, error: 'glab mr view 输出不是有效 JSON' }
  return normalizeGitlabMrStatus(row)
}

export async function getForgePrStatus(
  cwd: string,
  prId: string,
  providerOverride?: ForgeProvider,
): Promise<ForgePrStatusResult> {
  const provider = providerOverride ?? (await detectForge(cwd))
  return provider === 'github' ? getGhPrStatus(cwd, prId) : getGlabMrStatus(cwd, prId)
}

// ---------------------------------------------------------------------------
// Forge change-request closing
// ---------------------------------------------------------------------------

export interface ClosePrResult {
  ok: boolean
  error?: string
  /**
   * True when the forge CLI is missing or not authenticated, mirroring
   * {@link CreatePrResult.unavailable} so callers can distinguish install / log-in
   * from a genuine close failure.
   */
  unavailable?: boolean
}

/**
 * Forge CLI output fragments meaning "this change request is not open any more".
 * Closing something already closed is the state the caller wanted, so it counts
 * as SUCCESS — otherwise an externally-closed PR would deadlock every flow that
 * must close before it may proceed (intent cancellation, delivery unlink).
 *
 * Deliberately does NOT include "merged": a merged PR is a different state that
 * callers must refuse, never absorb. Same substring-matching style as
 * {@link GH_NOT_LOGGED_IN_MARKERS}.
 */
const PR_ALREADY_CLOSED_MARKERS = [
  'not open', // gh: "Pull request #12 is not open"
  'already closed',
  'is closed',
  'cannot close', // glab: "cannot close a closed merge request"
]

function isAlreadyClosedOutput(out: string): boolean {
  const lower = out.toLowerCase()
  if (lower.includes('merged')) return false
  return PR_ALREADY_CLOSED_MARKERS.some((m) => lower.includes(m))
}

/**
 * Close a GitHub Pull Request via the `gh` CLI: `gh pr close <prId>`, no extra
 * flags (the PR number is enough). A PR that is ALREADY closed reports success
 * (the desired state already holds) with a warn log; every other non-zero exit
 * is a failure and the caller leaves its own state untouched. `unavailable` is
 * set only for a missing CLI (ENOENT) or an auth failure, matching {@link createGhPr}.
 */
export async function closeGhPr(cwd: string, prId: string): Promise<ClosePrResult> {
  const { code, stdout, stderr } = await run('gh', cwd, ['pr', 'close', prId])
  if (code === -1) {
    return { ok: false, unavailable: true, error: 'gh CLI 未安装' }
  }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    if (isAlreadyClosedOutput(out)) {
      console.warn(`[git] gh pr close #${prId}: PR 已是关闭态,视为成功 — ${out}`)
      return { ok: true }
    }
    const notLoggedIn = GH_NOT_LOGGED_IN_MARKERS.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || 'gh pr close 失败',
    }
  }
  return { ok: true }
}

/**
 * Close a GitLab Merge Request via the `glab` CLI: `glab mr close <prId>`. Shares
 * the {@link closeGhPr} contract, including the already-closed-is-success rule
 * and the unavailable CLI/auth distinction.
 */
export async function closeGlabMr(cwd: string, prId: string): Promise<ClosePrResult> {
  const { code, stdout, stderr } = await run('glab', cwd, ['mr', 'close', prId])
  if (code === -1) {
    return { ok: false, unavailable: true, error: 'glab CLI 未安装' }
  }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    if (isAlreadyClosedOutput(out)) {
      console.warn(`[git] glab mr close !${prId}: MR 已是关闭态,视为成功 — ${out}`)
      return { ok: true }
    }
    const notLoggedIn = GLAB_NOT_LOGGED_IN_MARKERS.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || 'glab mr close 失败',
    }
  }
  return { ok: true }
}

/**
 * Close a pull or merge request through the selected forge. An explicit provider
 * takes precedence; otherwise the repository's origin determines it. Mirrors
 * {@link createForgePr}'s routing so GitLab intent cancellations close their MR too.
 */
export async function closeForgePr(
  cwd: string,
  prId: string,
  providerOverride?: ForgeProvider,
): Promise<ClosePrResult> {
  const provider = providerOverride ?? (await detectForge(cwd))
  return provider === 'github' ? closeGhPr(cwd, prId) : closeGlabMr(cwd, prId)
}

// ---------------------------------------------------------------------------
// Delivery PR facts — the 「交付分支 → 主线」 change request
//
// Two questions the intent-PR helpers above cannot answer, both needed before a
// delivery may be declared `delivered`:
//   1. "Does an OPEN PR already exist for this (head, base)?" — asked BEFORE every
//      create, so a retry adopts the PR a lost response already made instead of
//      opening a duplicate. A local return code is never treated as proof.
//   2. "Why can this PR not be merged?" — and specifically, is it a CONFLICT (the
//      code must change) or a failing check / missing approval (the code is fine,
//      something external is)? Merging those two into one verdict is what would
//      make a user redo a verification that was never invalidated.
// GitHub and GitLab are normalized onto the same field set here, so no caller
// ever branches on the provider.
// ---------------------------------------------------------------------------

/** One open change request the forge already holds for a (head, base) pair. */
export interface OpenForgePr {
  /** In-repo PR / MR number. */
  number: string
  url: string | null
}

export interface FindOpenPrResult {
  ok: boolean
  /** The open PR, or `null` when the forge holds none. Only meaningful when `ok`. */
  pr?: OpenForgePr | null
  error?: string
  unavailable?: boolean
}

function parseJsonArray(stdout: string): Record<string, unknown>[] | null {
  try {
    const value: unknown = JSON.parse(stdout)
    if (!Array.isArray(value)) return null
    return value.filter(
      (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v),
    )
  } catch {
    return null
  }
}

/** Read a PR / MR number from a forge JSON row, as the string the CLIs address it by. */
function readPrNumber(row: Record<string, unknown>): string | null {
  const raw = row.number ?? row.iid
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return null
}

function readPrUrl(row: Record<string, unknown>): string | null {
  for (const key of ['url', 'web_url', 'webUrl']) {
    const v = row[key]
    if (typeof v === 'string' && v) return v
  }
  return null
}

/** The PR states a (head, base) lookup asks the forge about. */
type ForgePrLookupState = 'open' | 'merged'

/** The states one lookup accepts on a returned row, normalized across forges. */
const FORGE_PR_STATE_ALIASES: Record<ForgePrLookupState, readonly string[]> = {
  open: ['open', 'opened'],
  merged: ['merged'],
}

/**
 * The pull/merge request the forge holds for `headBranch → baseBranch` in the
 * given STATE, or `null` when it holds none. `ok: false` means the question could
 * not be ANSWERED (CLI missing / not logged in / offline) — which a caller must
 * treat as "unknown", never as "none".
 *
 * One query path for both states: `open` drives the create-time idempotency (a
 * duplicate PR is the failure to avoid) and `merged` answers 「这条交付分支是不
 * 是已经通过 PR 进主线了」, and they must not drift on row filtering or provider
 * quirks.
 */
async function findForgePrByState(
  cwd: string,
  headBranch: string,
  baseBranch: string,
  state: ForgePrLookupState,
  providerOverride?: ForgeProvider,
): Promise<FindOpenPrResult> {
  const provider = providerOverride ?? (await detectForge(cwd))
  const label = state === 'open' ? '开放' : '已合并'
  const [bin, args, markers] =
    provider === 'github'
      ? ([
          'gh',
          [
            'pr',
            'list',
            '--head',
            headBranch,
            '--base',
            baseBranch,
            '--state',
            state,
            '--json',
            'number,url',
            '--limit',
            '1',
          ],
          GH_NOT_LOGGED_IN_MARKERS,
        ] as const)
      : ([
          'glab',
          [
            'mr',
            'list',
            '--source-branch',
            headBranch,
            '--target-branch',
            baseBranch,
            // `glab mr list` defaults to opened; merged rows only appear when asked
            // for explicitly.
            ...(state === 'merged' ? ['--merged'] : []),
            '--output',
            'json',
          ],
          GLAB_NOT_LOGGED_IN_MARKERS,
        ] as const)

  const { code, stdout, stderr } = await run(bin, cwd, [...args])
  if (code === -1) return { ok: false, unavailable: true, error: `${bin} CLI 未安装` }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    const notLoggedIn = markers.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || `${bin} 查询${label} PR 失败`,
    }
  }
  const rows = parseJsonArray(stdout)
  if (!rows) return { ok: false, error: `${bin} 查询${label} PR 的输出不是有效 JSON` }
  const accepted = FORGE_PR_STATE_ALIASES[state]
  for (const row of rows) {
    // `glab mr list` has no `--state` flag equivalent to gh's, so a row that says
    // otherwise is filtered here and both providers answer the same question.
    const rowState = typeof row.state === 'string' ? row.state.toLowerCase() : ''
    if (rowState && !accepted.includes(rowState)) continue
    const number = readPrNumber(row)
    if (number) return { ok: true, pr: { number, url: readPrUrl(row) } }
  }
  return { ok: true, pr: null }
}

/**
 * The OPEN pull/merge request the forge already holds for `headBranch → baseBranch`,
 * or `null` when it holds none. `ok: false` means the question could not be
 * ANSWERED (CLI missing / not logged in / offline) — which a caller must treat as
 * "unknown", never as "none", or it would open a duplicate PR.
 */
export async function findOpenForgePr(
  cwd: string,
  headBranch: string,
  baseBranch: string,
  providerOverride?: ForgeProvider,
): Promise<FindOpenPrResult> {
  return findForgePrByState(cwd, headBranch, baseBranch, 'open', providerOverride)
}

/**
 * The MERGED pull/merge request the forge holds for `headBranch → baseBranch`, or
 * `null` when it holds none — the PR identity behind a delivery branch that
 * already reached mainline. Only ever used to ENRICH a verdict git already
 * reached, so `ok: false` is never fatal to the caller: not knowing the PR number
 * does not make the merge less true.
 */
export async function findMergedForgePr(
  cwd: string,
  headBranch: string,
  baseBranch: string,
  providerOverride?: ForgeProvider,
): Promise<FindOpenPrResult> {
  return findForgePrByState(cwd, headBranch, baseBranch, 'merged', providerOverride)
}

/**
 * A delivery PR's live facts, normalized across forges. `conflict`, `ciFailed`
 * and `approvalMissing` are only meaningful while `status === 'reviewing'`.
 */
export interface DeliveryPrFactsResult {
  ok: boolean
  status?: 'reviewing' | 'merged' | 'closed'
  prUrl?: string | null
  /** The forge judges the PR unmergeable against its base — the code must change. */
  conflict?: boolean
  /** Required checks are failing — the code is fine, CI is not. */
  ciFailed?: boolean
  /** Required approvals are missing — the code is fine, a human review is. */
  approvalMissing?: boolean
  error?: string
  unavailable?: boolean
}

/** GitHub check conclusions/states that mean "this check failed", not "still running". */
const GH_FAILED_CHECK_VERDICTS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
])

function ghAnyCheckFailed(rollup: unknown): boolean {
  if (!Array.isArray(rollup)) return false
  return rollup.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const row = entry as Record<string, unknown>
    for (const key of ['conclusion', 'state']) {
      const v = row[key]
      if (typeof v === 'string' && GH_FAILED_CHECK_VERDICTS.has(v.toUpperCase())) return true
    }
    return false
  })
}

function normalizeGithubDeliveryPrFacts(row: Record<string, unknown>): DeliveryPrFactsResult {
  const base = normalizeGithubPrStatus(row)
  const status =
    base.status === 'merged' ? 'merged' : base.status === 'closed' ? 'closed' : 'reviewing'
  const mergeable = typeof row.mergeable === 'string' ? row.mergeable.toUpperCase() : ''
  const reviewDecision =
    typeof row.reviewDecision === 'string' ? row.reviewDecision.toUpperCase() : ''
  return {
    ok: true,
    status,
    prUrl: base.prUrl ?? null,
    conflict: mergeable === 'CONFLICTING',
    ciFailed: ghAnyCheckFailed(row.statusCheckRollup),
    // `REVIEW_REQUIRED` = nobody approved yet; `CHANGES_REQUESTED` = a reviewer
    // said no. Both are "a human still has to act", which is what 「合并受阻」 means.
    approvalMissing: reviewDecision === 'REVIEW_REQUIRED' || reviewDecision === 'CHANGES_REQUESTED',
  }
}

function normalizeGitlabDeliveryPrFacts(row: Record<string, unknown>): DeliveryPrFactsResult {
  const base = normalizeGitlabMrStatus(row)
  const status =
    base.status === 'merged' ? 'merged' : base.status === 'closed' ? 'closed' : 'reviewing'
  const detailed =
    typeof row.detailed_merge_status === 'string' ? row.detailed_merge_status.toLowerCase() : ''
  const mergeStatus = typeof row.merge_status === 'string' ? row.merge_status.toLowerCase() : ''
  const pipeline = asRecord(row.head_pipeline) ?? asRecord(row.pipeline)
  const pipelineStatus = typeof pipeline?.status === 'string' ? pipeline.status.toLowerCase() : ''
  return {
    ok: true,
    status,
    prUrl: base.prUrl ?? null,
    conflict:
      row.has_conflicts === true || detailed === 'conflict' || mergeStatus === 'cannot_be_merged',
    ciFailed: detailed === 'ci_must_pass' || pipelineStatus === 'failed',
    approvalMissing: detailed === 'not_approved',
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/**
 * The delivery PR's live facts from the forge: merged / open / closed, plus WHY
 * an open one cannot be merged. `ok: false` means the forge could not be reached
 * or understood — the caller then changes nothing and offers a retry, because an
 * unreadable forge is not evidence about the PR.
 */
export async function getForgeDeliveryPrFacts(
  cwd: string,
  prId: string,
  providerOverride?: ForgeProvider,
): Promise<DeliveryPrFactsResult> {
  const provider = providerOverride ?? (await detectForge(cwd))
  const [bin, args, markers] =
    provider === 'github'
      ? ([
          'gh',
          [
            'pr',
            'view',
            prId,
            '--json',
            'state,mergedAt,url,mergeable,reviewDecision,statusCheckRollup',
          ],
          GH_NOT_LOGGED_IN_MARKERS,
        ] as const)
      : (['glab', ['mr', 'view', prId, '--output', 'json'], GLAB_NOT_LOGGED_IN_MARKERS] as const)

  const { code, stdout, stderr } = await run(bin, cwd, [...args])
  if (code === -1) return { ok: false, unavailable: true, error: `${bin} CLI 未安装` }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
    const notLoggedIn = markers.some((m) => out.toLowerCase().includes(m))
    return {
      ok: false,
      ...(notLoggedIn ? { unavailable: true } : {}),
      error: out || `${bin} 读取 PR 状态失败`,
    }
  }
  const row = parseJsonObject(stdout)
  if (!row) return { ok: false, error: `${bin} 读取 PR 状态的输出不是有效 JSON` }
  return provider === 'github'
    ? normalizeGithubDeliveryPrFacts(row)
    : normalizeGitlabDeliveryPrFacts(row)
}
