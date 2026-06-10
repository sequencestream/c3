import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorktree,
  generateBranchName,
  getWorktreePath,
  projectDirName,
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
  const INTENT_ID = 'abc-123'

  function wtPath(): string {
    return getWorktreePath(repoDir, INTENT_ID)
  }

  /** Clean up a worktree created during the test. */
  function removeWorktree(): void {
    try {
      execFileSync(
        'git',
        ['worktree', 'remove', '--force', wtPath()],
        { cwd: repoDir, stdio: 'ignore' },
      )
    } catch {
      // may not exist
    }
  }

  beforeEach(() => {
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
})
