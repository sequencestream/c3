/**
 * Git worktree management for intent development isolation.
 *
 * Creates detached worktrees at `$TMPDIR/c3-worktrees/<project>/intent-<ID>/` so
 * the agent works on an isolated branch without touching the main checkout.
 *
 * Cross-session persistence: worktrees are NOT automatically removed — they
 * survive across agent / server restarts. Cleanup is a future feature (only
 * optionally on intent done / cancelled / archived).
 *
 * The worktree path is fully deterministic from (projectPath, intentId), so
 * resume scenarios can compute it without database lookups.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

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

/**
 * Convert an absolute project path to a safe filesystem segment under
 * `$TMPDIR/c3-worktrees/`, e.g. `/Users/foo/project` → `Users-foo-project`.
 */
export function projectDirName(projectPath: string): string {
  return projectPath.replace(/^\/+/, '').replace(/[/:]/g, '-')
}

/** The base directory under $TMPDIR that holds all worktrees for a project. */
export function getWorktreeBase(projectPath: string): string {
  return join(tmpdir(), 'c3-worktrees', projectDirName(projectPath))
}

/** The full path for a specific intent's worktree. Fully deterministic. */
export function getWorktreePath(projectPath: string, intentId: string): string {
  return join(getWorktreeBase(projectPath), `intent-${intentId}`)
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
 * - Creates the branch from HEAD via `git worktree add -b`; if the branch
 *   already exists (e.g. orphaned from a partially cleaned-up worktree),
 *   falls back to `git worktree add <path> <branch>`.
 *
 * Throws on git failure with a descriptive message so callers can catch and
 * communicate the error to the user (or stop the automation).
 */
export function createWorktree(
  projectPath: string,
  intentId: string,
  title: string,
): CreateWorktreeResult {
  const worktreePath = getWorktreePath(projectPath, intentId)

  // Idempotent: existing worktree → return current info.
  if (worktreeExists(worktreePath)) {
    const branchName = readBranch(worktreePath)
    if (!branchName) {
      throw new Error(
        `worktree ${worktreePath} 存在但 HEAD 处于分离状态或不可读`,
      )
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

  // Try `git worktree add -b` to create the branch from HEAD.
  const res = execGit(projectPath, [
    'worktree',
    'add',
    '-b',
    branchName,
    worktreePath,
  ])

  if (res.code === 0) {
    return { worktreePath, branchName }
  }

  // Branch already exists? Try with the existing branch instead.
  const stderr = res.stderr.toLowerCase()
  if (stderr.includes('already exists')) {
    const retry = execGit(projectPath, [
      'worktree',
      'add',
      worktreePath,
      branchName,
    ])
    if (retry.code === 0) {
      return { worktreePath, branchName }
    }
    throw new Error(
      `git worktree add 失败(已存在分支回退后仍然出错): ${retry.stderr || retry.stdout}`,
    )
  }

  throw new Error(
    `git worktree add 失败: ${res.stderr || res.stdout}`,
  )
}
