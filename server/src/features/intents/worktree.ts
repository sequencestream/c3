/**
 * Git worktree management for intent development isolation.
 *
 * Creates detached worktrees at `<c3-home>/worktrees/<project>/intent-<ID>/`
 * (c3-home = `--settings` dir / `C3_DIR` / `~/.c3`) so the agent works on an
 * isolated branch without touching the main checkout.
 *
 * Why under the c3 home and not `$TMPDIR`: the sandbox bind-mounts the worktree
 * into the container at `/workspace` (ADR-0024, SND-R14). On macOS Docker
 * Desktop the default file-sharing set excludes `$TMPDIR` (`/var/folders`) and
 * `/tmp` but always includes the user's HOME — a worktree under `$TMPDIR` would
 * mount as an EMPTY `/workspace`. Anchoring under the c3 home (which lives under
 * HOME by default) keeps real sandbox runs working on macOS, and isolated
 * launches (`--settings <throwaway>`) keep their worktrees in the throwaway dir.
 *
 * Cross-session persistence: worktrees are NOT automatically removed — they
 * survive across agent / server restarts. Cleanup is a future feature (only
 * optionally on intent done / cancelled / archived).
 *
 * The worktree path is fully deterministic from (workspacePath, intentId), so
 * resume scenarios can compute it without database lookups.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { c3HomeDir } from '../../kernel/config/index.js'
import { projectDirName } from '../../kernel/config/workspace-path.js'

export { projectDirName } from '../../kernel/config/workspace-path.js'

// ---------------------------------------------------------------------------
// Local git helper — synchronous (worktree creation MUST be sync to preserve
// the automation controller's microtask timing; async git calls would defer
// runDevTurn and break the testable event-driven FSM contract).
// ---------------------------------------------------------------------------

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

function execGit(cwd: string, args: string[]): GitResult {
  try {
    const result = execFileSync('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout: result, stderr: '' }
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    return {
      code: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    }
  }
}

// ---------------------------------------------------------------------------
// Path computation — fully deterministic helpers
// ---------------------------------------------------------------------------

/** The base directory under the c3 home that holds all worktrees for a project. */
export function getWorktreeBase(workspacePath: string): string {
  return join(c3HomeDir(), 'worktrees', projectDirName(workspacePath))
}

/** The full path for a specific intent's worktree. Fully deterministic. */
export function getWorktreePath(workspacePath: string, intentId: string): string {
  return join(getWorktreeBase(workspacePath), `intent-${intentId}`)
}

export interface RemoveIntentGitResourcesResult {
  worktreeRemoved: boolean
  branchRemoved: boolean
}

/**
 * Remove only the deterministic c3 worktree and the exact recorded local intent
 * branch. Missing resources are already-clean success; every other git failure
 * is surfaced so the intent record remains available for a retry.
 */
export function removeIntentGitResources(
  workspacePath: string,
  intentId: string,
  branchName: string | null,
): RemoveIntentGitResourcesResult {
  if (branchName !== null && !branchName.startsWith('intent/')) {
    throw new Error(`refusing to delete branch outside intent namespace: ${branchName}`)
  }

  const worktreePath = getWorktreePath(workspacePath, intentId)
  let worktreeRemoved = false
  if (worktreeExists(worktreePath)) {
    const removed = execGit(workspacePath, ['worktree', 'remove', '--force', worktreePath])
    if (removed.code !== 0) {
      throw new Error((removed.stderr || removed.stdout).trim() || 'failed to remove worktree')
    }
    worktreeRemoved = true
  }

  let branchRemoved = false
  if (branchName !== null) {
    const exists = execGit(workspacePath, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branchName}`,
    ])
    if (exists.code === 0) {
      const removed = execGit(workspacePath, ['branch', '-D', '--', branchName])
      if (removed.code !== 0) {
        throw new Error(
          (removed.stderr || removed.stdout).trim() || 'failed to remove local branch',
        )
      }
      branchRemoved = true
    } else if (exists.code !== 1) {
      throw new Error((exists.stderr || exists.stdout).trim() || 'failed to inspect local branch')
    }
  }

  return { worktreeRemoved, branchRemoved }
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

/**
 * Generate a stable, legible git branch name from an intent id and title.
 *
 * Format: `intent/<short-id>-<slug>`
 *
 * - `short-id`: the first 8 hex chars of the intent UUID (dashes stripped).
 * - `slug`: lowercase, slashes → dashes, CJK kept, max 48 chars.
 *
 * The total branch name stays well under git's 255-char limit.
 *
 * Exported testably (no side effects).
 */
export function generateBranchName(intentId: string, title: string): string {
  const shortId = intentId.replace(/-/g, '').slice(0, 8)
  const slug = title
    .toLowerCase()
    .replace(/['"]/g, '') // remove quotes first
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric → dash
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .slice(0, 48) // cap for readability
  return `intent/${shortId}-${slug}`
}

// ---------------------------------------------------------------------------
// Worktree existence check
// ---------------------------------------------------------------------------

/**
 * Check if a worktree directory exists at the given path. A valid git
 * worktree has a `.git` file (pointer) or a `.git` directory.
 */
export function worktreeExists(worktreePath: string): boolean {
  return existsSync(join(worktreePath, '.git'))
}

// ---------------------------------------------------------------------------
// Branch name query
// ---------------------------------------------------------------------------

/**
 * Read the current branch name from a worktree/repo, or `null` on failure
 * or detached HEAD. Synchronous (uses execFileSync internally).
 */
export function readBranch(worktreePath: string): string | null {
  const res = execGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (res.code !== 0 || !res.stdout.trim()) return null
  const branch = res.stdout.trim()
  return branch === 'HEAD' ? null : branch
}

/**
 * Detect a repository's default branch for pre-filling the workspace setting.
 *
 * Resolution order:
 *  1. `origin/HEAD` — the remote's advertised default (`git symbolic-ref … →
 *     origin/main`, stripped to `main`).
 *  2. The current local HEAD branch (via {@link readBranch}).
 *
 * Returns `undefined` when neither resolves (detached HEAD with no remote, or a
 * non-git path) — callers then leave `defaultMainBranch` unset. Synchronous.
 */
export function detectDefaultBranch(workspacePath: string): string | undefined {
  const sym = execGit(workspacePath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (sym.code === 0) {
    const short = sym.stdout.trim().replace(/^origin\//, '')
    if (short) return short
  }
  return readBranch(workspacePath) ?? undefined
}

// ---------------------------------------------------------------------------
// Pull / fetch the latest before a work session starts (2026-06-20)
//
// Rule: a work session must build on up-to-date code, INCLUDING worktrees.
//  - worktree mode: fetch the base branch and root the new worktree at the
//    just-fetched remote tip (see createWorktree → fetchRemoteBase).
//  - current-branch mode: fast-forward the project checkout's current branch
//    (see pullCurrentBranch).
//
// Failure policy (区分对待):
//  - no remote / no upstream / offline → silently skip (best-effort): a
//    local-only or offline workspace must still be able to start work.
//  - local branch DIVERGED from upstream (non fast-forward) → HARD STOP: we
//    never auto-merge or auto-rebase the user's branch; the caller refuses to
//    start and tells the user to reconcile first.
// All synchronous (execFileSync), same rationale as createWorktree.
// ---------------------------------------------------------------------------

/** Prefer `origin`, else the first configured remote, else null (no remote). */
function resolveRemoteSync(workspacePath: string): string | null {
  const r = execGit(workspacePath, ['remote'])
  if (r.code !== 0) return null
  const remotes = r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (remotes.length === 0) return null
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

// Divergence markers that make a `git pull --ff-only` a HARD STOP (local has
// commits the remote doesn't — getting latest can't be done cleanly).
const DIVERGED_MARKERS = [
  'not possible to fast-forward',
  'non-fast-forward',
  'diverged',
  'divergent branches',
]

export interface PullResult {
  /** false ONLY on divergence — the caller must refuse to start the session. */
  ok: boolean
  /** true when pull was skipped best-effort (no remote / upstream / offline). */
  skipped: boolean
  /** git output, populated when `!ok` (divergence) for surfacing to the user. */
  message?: string
}

/**
 * Fast-forward the project checkout's CURRENT branch so current-branch-mode
 * development starts on up-to-date code. See the failure policy above.
 */
export function pullCurrentBranch(workspacePath: string): PullResult {
  // No remote (or not a git repo / multi-repo root) → nothing to pull.
  if (!resolveRemoteSync(workspacePath)) return { ok: true, skipped: true }
  const res = execGit(workspacePath, ['pull', '--ff-only'])
  if (res.code === 0) return { ok: true, skipped: false }
  const out = (res.stderr || res.stdout).trim()
  const hay = out.toLowerCase()
  if (DIVERGED_MARKERS.some((m) => hay.includes(m))) {
    return { ok: false, skipped: false, message: out }
  }
  // no upstream / offline / auth / unknown → best-effort skip (don't block).
  return { ok: true, skipped: true, message: out }
}

/**
 * Fetch `baseBranch` from the repo's remote so a worktree created off it starts
 * at the LATEST remote commit. Returns the ref to root the new worktree at —
 * `<remote>/<baseBranch>` on success, or `null` when there is no remote or the
 * fetch fails (offline / branch missing), in which case the caller falls back
 * to the LOCAL `baseBranch`. Fetch never merges, so it cannot diverge: there is
 * nothing to hard-stop on here.
 */
export function fetchRemoteBase(workspacePath: string, baseBranch: string): string | null {
  const remote = resolveRemoteSync(workspacePath)
  if (!remote) return null
  const res = execGit(workspacePath, ['fetch', remote, baseBranch])
  if (res.code !== 0) return null
  return `${remote}/${baseBranch}`
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface CreateWorktreeResult {
  worktreePath: string
  branchName: string
}

// ---------------------------------------------------------------------------
// Public API — create or reuse a worktree
// ---------------------------------------------------------------------------

/**
 * Ensure a git worktree exists for the given intent.
 *
 * - **Synchronous**: uses `execFileSync` — worktree creation is a fast,
 *   one-time setup operation that MUST complete before the dev turn starts.
 * - **Idempotent**: if the worktree already exists, returns its info without
 *   running any git command (safe to call repeatedly for resume).
 * - Creates parent directories on demand.
 * - Creates the branch via `git worktree add -b`. When `baseBranch` is given the
 *   new branch is rooted there (`… add -b <branch> <path> <base>`); otherwise it
 *   roots at the project's current HEAD. If the branch already exists (e.g.
 *   orphaned from a partially cleaned-up worktree), falls back to
 *   `git worktree add <path> <branch>`.
 *
 * Throws on git failure with a descriptive message so callers can catch and
 * communicate the error to the user (or stop the automation).
 */
export function createWorktree(
  workspacePath: string,
  intentId: string,
  title: string,
  baseBranch?: string,
): CreateWorktreeResult {
  const worktreePath = getWorktreePath(workspacePath, intentId)

  // Idempotent: existing worktree → return current info.
  if (worktreeExists(worktreePath)) {
    const branchName = readBranch(worktreePath)
    if (!branchName) {
      throw new Error(`worktree ${worktreePath} 存在但 HEAD 处于分离状态或不可读`)
    }
    return { worktreePath, branchName }
  }

  const branchName = generateBranchName(intentId, title)

  // Create parent directory chain.
  const parent = dirname(worktreePath)
  try {
    mkdirSync(parent, { recursive: true })
  } catch {
    throw new Error(`无法创建工作区临时目录: ${parent}`)
  }

  // Try `git worktree add -b` to create the branch. Root it at `baseBranch`
  // when provided (the workspace's default main branch), else at current HEAD.
  // To keep the worktree on LATEST code, fetch the base branch first and root
  // at the just-fetched remote tip when a remote is available.
  const addArgs = ['worktree', 'add', '-b', branchName]
  const base = baseBranch?.trim()
  if (base) {
    const remoteRef = fetchRemoteBase(workspacePath, base)
    if (remoteRef) {
      // Root at the just-fetched remote tip. `--no-track`: the intent branch
      // must NOT inherit `<remote>/<base>` as upstream, or a later `git push`
      // would target `<base>` (push.default=simple refuses on the name mismatch
      // → hard stop). The intent branch sets its own upstream on first push.
      addArgs.push('--no-track', worktreePath, remoteRef)
    } else {
      addArgs.push(worktreePath, base) // no remote / offline → local base
    }
  } else {
    addArgs.push(worktreePath) // no base → current HEAD
  }
  const res = execGit(workspacePath, addArgs)

  if (res.code === 0) {
    return { worktreePath, branchName }
  }

  // Branch already exists? Try with the existing branch instead.
  const stderr = res.stderr.toLowerCase()
  if (stderr.includes('already exists')) {
    const retry = execGit(workspacePath, ['worktree', 'add', worktreePath, branchName])
    if (retry.code === 0) {
      return { worktreePath, branchName }
    }
    throw new Error(
      `git worktree add 失败(已存在分支回退后仍然出错): ${retry.stderr || retry.stdout}`,
    )
  }

  throw new Error(`git worktree add 失败: ${res.stderr || res.stdout}`)
}
