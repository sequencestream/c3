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
import { join, relative, sep } from 'node:path'
import type { CodeGitStatus, IntentPrStatus } from '@ccc/shared/protocol'

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
// Read-only working-tree status snapshot (decorates the Codes file tree)
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain -z --untracked-files=all` output into a map of
 * repo-relative path → {@link CodeGitStatus}. NUL (`-z`) framing keeps spaces,
 * quotes and non-ASCII bytes in paths intact (no C-quoting to undo).
 *
 * Status columns are `XY`: `X` the index, `Y` the working tree. `??` ⇒
 * `untracked`; `X ∈ {A,M}` ⇒ `staged`; `Y === 'M'` ⇒ `modified`; flags compose
 * (`MM`/`AM` are staged **and** modified). Renames/copies carry a trailing
 * old-path token we consume and drop. Deletions, renames, copies and conflicts
 * never enter the snapshot. Pure (string in, map out) so it is unit-testable.
 */
export function parsePorcelainStatus(z: string): Record<string, CodeGitStatus> {
  const out: Record<string, CodeGitStatus> = {}
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
async function statusForRepo(repo: string, prefix: string): Promise<Record<string, CodeGitStatus>> {
  const res = await git(repo, ['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all'])
  if (res.code !== 0) return {}
  const parsed = parsePorcelainStatus(res.stdout)
  if (!prefix) return parsed
  const out: Record<string, CodeGitStatus> = {}
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
): Promise<Record<string, CodeGitStatus>> {
  if (isGitRepo(workspacePath)) return statusForRepo(workspacePath, '')
  const out: Record<string, CodeGitStatus> = {}
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
 */
export async function commitAndPush(workspacePath: string, message: string): Promise<CommitResult> {
  if (isGitRepo(workspacePath)) {
    return commitAndPushRepo(workspacePath, message, '')
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

/** Collapse multi-line git output into a single trimmed line for the UI. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
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
 * `baseBranch` defaults to `main`.
 */
export async function createGhPr(
  cwd: string,
  title: string,
  body: string,
  headBranch?: string,
  baseBranch = 'main',
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
 * `headBranch` is optional; `baseBranch` defaults to `main`.
 */
export async function createGlabMr(
  cwd: string,
  title: string,
  body: string,
  headBranch?: string,
  baseBranch = 'main',
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
 */
export async function createForgePr(
  cwd: string,
  title: string,
  body: string,
  headBranch?: string,
  baseBranch?: string,
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
 * Close a GitHub Pull Request via the `gh` CLI: `gh pr close <prId>`, no extra
 * flags (the PR number is enough). A non-zero exit is a failure — including a PR
 * already closed externally (`gh` returns "not open" / "Could not resolve to a
 * PullRequest"); the caller then leaves the intent untouched. `unavailable` is
 * set only for a missing CLI (ENOENT) or an auth failure, matching {@link createGhPr}.
 */
export async function closeGhPr(cwd: string, prId: string): Promise<ClosePrResult> {
  const { code, stdout, stderr } = await run('gh', cwd, ['pr', 'close', prId])
  if (code === -1) {
    return { ok: false, unavailable: true, error: 'gh CLI 未安装' }
  }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
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
 * the {@link closeGhPr} contract, including the unavailable CLI/auth distinction.
 */
export async function closeGlabMr(cwd: string, prId: string): Promise<ClosePrResult> {
  const { code, stdout, stderr } = await run('glab', cwd, ['mr', 'close', prId])
  if (code === -1) {
    return { ok: false, unavailable: true, error: 'glab CLI 未安装' }
  }
  if (code !== 0) {
    const out = oneLine(stderr || stdout)
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
