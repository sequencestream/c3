import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorktree,
  detectDefaultBranch,
  generateBranchName,
  getWorktreePath,
  projectDirName,
  pullCurrentBranch,
  worktreeExists,
} from './worktree.js'

// ---------------------------------------------------------------------------
// Helpers: create a minimal git repo for tests that need a real git env.
// ---------------------------------------------------------------------------

function createGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' })
  // An initial commit is required before `git worktree add` works.
  writeFileSync(join(dir, 'README.md'), '# test')
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' })
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

/**
 * Give `repoDir` a bare `origin` and push its current branch with upstream
 * tracking. Returns the bare remote path so a test can advance it independently.
 */
function attachBareRemote(repoDir: string): string {
  const bare = mkdtempSync(join(tmpdir(), 'c3-wt-remote-'))
  execFileSync('git', ['init', '--bare'], { cwd: bare, stdio: 'ignore' })
  const branch = gitOut(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: repoDir, stdio: 'ignore' })
  execFileSync('git', ['push', '-u', 'origin', branch], { cwd: repoDir, stdio: 'ignore' })
  return bare
}

/**
 * Push a fresh commit to `bare`'s `branch` from a throwaway clone, simulating
 * another contributor advancing the remote. Returns the new remote tip sha.
 */
function advanceRemote(bare: string, branch: string): string {
  const clone = mkdtempSync(join(tmpdir(), 'c3-wt-clone-'))
  execFileSync('git', ['clone', bare, clone], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'other@test'], { cwd: clone, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Other'], { cwd: clone, stdio: 'ignore' })
  writeFileSync(join(clone, 'REMOTE_ONLY.md'), 'remote')
  execFileSync('git', ['add', '-A'], { cwd: clone, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'remote commit'], { cwd: clone, stdio: 'ignore' })
  execFileSync('git', ['push', 'origin', branch], { cwd: clone, stdio: 'ignore' })
  const sha = gitOut(clone, ['rev-parse', 'HEAD'])
  rmSync(clone, { recursive: true, force: true })
  return sha
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateBranchName', () => {
  it('generates a stable branch name from id and title', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const name = generateBranchName(id, 'Fix login button')
    expect(name).toBe('intent/550e8400-fix-login-button')
  })

  it('slugifies special characters', () => {
    const id = 'abc123'
    const name = generateBranchName(id, 'Hello World! @#$% Test')
    expect(name).toMatch(/^intent\/abc123-hello-world-test$/)
  })

  it('handles empty title gracefully', () => {
    const id = 'abc123'
    const name = generateBranchName(id, '')
    expect(name).toBe('intent/abc123-')
  })

  it('truncates long titles to 48 chars', () => {
    const id = 'abc123'
    const longTitle = 'a'.repeat(200)
    const name = generateBranchName(id, longTitle)
    // Slug part should be 48 chars max
    const slug = name.replace('intent/abc123-', '')
    expect(slug.length).toBeLessThanOrEqual(48)
    expect(name).toBe(`intent/abc123-${'a'.repeat(48)}`)
  })

  it('handles title with only special characters', () => {
    const id = 'abc123'
    const name = generateBranchName(id, '!!! @@@ ###')
    expect(name).toBe('intent/abc123-')
  })

  it('handles quotes in title', () => {
    const id = 'abc123'
    const name = generateBranchName(id, "Fix 'critical' bug")
    expect(name).toMatch(/^intent\/abc123-fix-critical-bug$/)
  })
})

describe('projectDirName', () => {
  it('converts absolute path to safe directory name', () => {
    expect(projectDirName('/Users/foo/project')).toBe('Users-foo-project')
  })

  it('handles leading slash', () => {
    expect(projectDirName('/a/b/c')).toBe('a-b-c')
  })

  it('handles colons (Windows-style paths on some systems)', () => {
    expect(projectDirName('/C:/Users/foo')).toBe('C--Users-foo')
  })
})

describe('worktreeExists', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-wt-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns true for a directory with .git marker', () => {
    createGitRepo(dir)
    expect(worktreeExists(dir)).toBe(true)
  })

  it('returns false for an empty directory', () => {
    expect(worktreeExists(dir)).toBe(false)
  })

  it('returns false for a non-existent path', () => {
    expect(worktreeExists(join(dir, 'nonexistent'))).toBe(false)
  })
})

describe('createWorktree', () => {
  let repoDir: string
  // Worktrees now anchor under the c3 home (honoring C3_DIR); redirect it to a
  // throwaway dir so the test never writes into the real ~/.c3.
  let c3DirTmp: string
  let prevC3Dir: string | undefined
  const INTENT_ID = 'abc-123'

  function wtPath(): string {
    return getWorktreePath(repoDir, INTENT_ID)
  }

  /** Clean up a worktree created during the test. */
  function removeWorktree(): void {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath()], {
        cwd: repoDir,
        stdio: 'ignore',
      })
    } catch {
      // may not exist
    }
  }

  beforeEach(() => {
    prevC3Dir = process.env.C3_DIR
    c3DirTmp = mkdtempSync(join(tmpdir(), 'c3-wt-home-'))
    process.env.C3_DIR = c3DirTmp
    repoDir = mkdtempSync(join(tmpdir(), 'c3-wt-repo-'))
    createGitRepo(repoDir)
  })

  afterEach(() => {
    // Clean up worktree if it was created.
    if (worktreeExists(wtPath())) {
      removeWorktree()
    }
    // Also clean up any leftover git branch reference.
    try {
      execFileSync('git', ['branch', '-D', 'intent/abc123-test-feature'], {
        cwd: repoDir,
        stdio: 'ignore',
      })
    } catch {
      // ignore
    }
    rmSync(repoDir, { recursive: true, force: true })
    // Clean up the worktree temp directory.
    try {
      rmSync(wtPath(), { recursive: true, force: true })
    } catch {
      // ignore
    }
    rmSync(c3DirTmp, { recursive: true, force: true })
    if (prevC3Dir === undefined) delete process.env.C3_DIR
    else process.env.C3_DIR = prevC3Dir
  })

  it('creates a worktree and branch', () => {
    const result = createWorktree(repoDir, INTENT_ID, 'Test feature')

    expect(worktreeExists(result.worktreePath)).toBe(true)
    expect(result.branchName).toMatch(/^intent\/abc123-test-feature$/)
    expect(result.worktreePath).toContain('intent-abc-123')
  })

  it('is idempotent when worktree already exists', () => {
    const first = createWorktree(repoDir, INTENT_ID, 'Test feature')
    const second = createWorktree(repoDir, INTENT_ID, 'Test feature')

    expect(second.worktreePath).toBe(first.worktreePath)
    expect(second.branchName).toBe(first.branchName)
    expect(worktreeExists(second.worktreePath)).toBe(true)
  })

  it('throws on non-git project path', () => {
    const badDir = join(tmpdir(), `c3-wt-nongit-${Date.now()}`)
    try {
      expect(() => createWorktree(badDir, INTENT_ID, 'Test')).toThrow()
    } finally {
      rmSync(badDir, { recursive: true, force: true })
    }
  })

  it('re-uses existing worktree on idempotent call with different title', () => {
    const first = createWorktree(repoDir, INTENT_ID, 'First title')
    // Second call with different title — worktree already exists, so it
    // returns the original branch name (not regenerated).
    const second = createWorktree(repoDir, INTENT_ID, 'Different title')

    expect(second.branchName).toBe(first.branchName)
  })

  it('roots the new branch at the given base branch (2026-06-10)', () => {
    // Create a `base-branch` ahead of HEAD with a distinct commit, then return
    // to the original branch so HEAD and base-branch differ.
    const headBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim()
    execFileSync('git', ['checkout', '-b', 'base-branch'], { cwd: repoDir, stdio: 'ignore' })
    writeFileSync(join(repoDir, 'BASE_ONLY.md'), 'base')
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'base commit'], { cwd: repoDir, stdio: 'ignore' })
    const baseSha = execFileSync('git', ['rev-parse', 'base-branch'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim()
    execFileSync('git', ['checkout', headBranch], { cwd: repoDir, stdio: 'ignore' })

    const result = createWorktree(repoDir, INTENT_ID, 'Test feature', 'base-branch')
    const wtSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: result.worktreePath,
      encoding: 'utf-8',
    }).trim()
    // The worktree HEAD must match the base branch tip, not the original HEAD.
    expect(wtSha).toBe(baseSha)

    try {
      execFileSync('git', ['branch', '-D', 'base-branch'], { cwd: repoDir, stdio: 'ignore' })
    } catch {
      // ignore
    }
  })

  it('roots the worktree at the FETCHED remote tip, not the stale local base (2026-06-20)', () => {
    // origin is ahead of the local base branch. createWorktree must fetch and
    // root the new worktree at origin/<base>, so the agent starts on latest code.
    const branch = gitOut(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const bare = attachBareRemote(repoDir)
    const staleLocal = gitOut(repoDir, ['rev-parse', 'HEAD'])
    const remoteTip = advanceRemote(bare, branch)
    expect(remoteTip).not.toBe(staleLocal) // remote really moved ahead

    const result = createWorktree(repoDir, INTENT_ID, 'Test feature', branch)
    const wtSha = gitOut(result.worktreePath, ['rev-parse', 'HEAD'])
    expect(wtSha).toBe(remoteTip)
    // --no-track: the intent branch must NOT adopt origin/<base> as upstream, or
    // a later bare `git push` would target <base>. No upstream → rev-parse @{u}
    // exits non-zero (throws here).
    expect(() =>
      execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
        cwd: result.worktreePath,
        stdio: 'ignore',
      }),
    ).toThrow()
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('pullCurrentBranch', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'c3-pull-'))
    createGitRepo(repoDir)
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('skips (best-effort) when there is no remote', () => {
    const res = pullCurrentBranch(repoDir)
    expect(res).toEqual({ ok: true, skipped: true })
  })

  it('fast-forwards the current branch when the remote is ahead', () => {
    const branch = gitOut(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const bare = attachBareRemote(repoDir)
    const remoteTip = advanceRemote(bare, branch)

    const res = pullCurrentBranch(repoDir)
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe(false)
    expect(gitOut(repoDir, ['rev-parse', 'HEAD'])).toBe(remoteTip)
    rmSync(bare, { recursive: true, force: true })
  })

  it('hard-stops (ok=false) when the local branch has diverged from the remote', () => {
    const branch = gitOut(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const bare = attachBareRemote(repoDir)
    advanceRemote(bare, branch) // remote gains a commit
    // Local gains a DIFFERENT commit on top of the shared base → divergence.
    writeFileSync(join(repoDir, 'LOCAL_ONLY.md'), 'local')
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'local commit'], { cwd: repoDir, stdio: 'ignore' })

    const res = pullCurrentBranch(repoDir)
    expect(res.ok).toBe(false)
    expect(res.skipped).toBe(false)
    expect(res.message).toBeTruthy()
    rmSync(bare, { recursive: true, force: true })
  })
})

describe('detectDefaultBranch', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'c3-detect-'))
    createGitRepo(repoDir)
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('prefers origin/HEAD when present', () => {
    // Point origin/HEAD at a symbolic remote branch (no real remote needed).
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], {
      cwd: repoDir,
      stdio: 'ignore',
    })
    expect(detectDefaultBranch(repoDir)).toBe('trunk')
  })

  it('falls back to the current HEAD branch when no origin/HEAD', () => {
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf-8',
    }).trim()
    expect(detectDefaultBranch(repoDir)).toBe(head)
  })

  it('returns undefined for a non-git path', () => {
    const badDir = mkdtempSync(join(tmpdir(), 'c3-detect-nongit-'))
    try {
      expect(detectDefaultBranch(badDir)).toBeUndefined()
    } finally {
      rmSync(badDir, { recursive: true, force: true })
    }
  })
})
