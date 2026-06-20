/**
 * Unit tests for the centralized SDD spec root resolution:
 * - REQ-1: fixed, deterministic `<c3-home>/specs/<project-path-segment>` —
 *   same path → same root (idempotent); different paths → different roots; the
 *   result does NOT depend on cwd or any user config.
 * - REQ-2: the root is keyed on the OWNING workspace path, so every worktree of
 *   one project (a different effective cwd) resolves to the SAME spec set.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { getSpecsBase, resolveSpecFileAbs } from './specs-root.js'

describe('getSpecsBase (REQ-1: fixed, deterministic centralized root)', () => {
  let prevC3Dir: string | undefined

  beforeEach(() => {
    prevC3Dir = process.env.C3_DIR
    process.env.C3_DIR = '/home/u/.c3'
  })
  afterEach(() => {
    if (prevC3Dir === undefined) delete process.env.C3_DIR
    else process.env.C3_DIR = prevC3Dir
  })

  it('AC-1.1: resolves to a deterministic subdir under <c3-home>/specs and is idempotent', () => {
    const a = getSpecsBase('/Users/foo/project')
    const b = getSpecsBase('/Users/foo/project')
    expect(a).toBe('/home/u/.c3/specs/Users-foo-project')
    expect(a).toBe(b)
  })

  it('AC-1.2: different workspace paths resolve to different spec roots', () => {
    expect(getSpecsBase('/Users/foo/project-a')).not.toBe(getSpecsBase('/Users/foo/project-b'))
  })

  it('AC-1.3: resolution ignores the current working directory', () => {
    const before = process.cwd()
    const expected = getSpecsBase('/Users/foo/project')
    // Changing cwd must not change the resolved root (it is path-derived only).
    process.chdir('/tmp')
    try {
      expect(getSpecsBase('/Users/foo/project')).toBe(expected)
    } finally {
      process.chdir(before)
    }
  })

  it('uses the same project-path encoding as worktrees (project isolation)', () => {
    // Mirrors `projectDirName`: leading slash stripped, `/` and `:` → `-`.
    expect(getSpecsBase('/a/b/c')).toBe('/home/u/.c3/specs/a-b-c')
  })
})

describe('getSpecsBase (REQ-2: same spec set across worktrees of one project)', () => {
  let prevC3Dir: string | undefined
  beforeEach(() => {
    prevC3Dir = process.env.C3_DIR
    process.env.C3_DIR = '/home/u/.c3'
  })
  afterEach(() => {
    if (prevC3Dir === undefined) delete process.env.C3_DIR
    else process.env.C3_DIR = prevC3Dir
  })

  it('AC-2.1: resolving from the OWNING workspace path is identical regardless of worktree cwd', () => {
    // The owning workspace path is the registry-resolved key passed by every
    // handler; the intent's worktree (a different physical dir) is never the key.
    const owner = '/Users/foo/project'
    const worktree = '/home/u/.c3/worktrees/Users-foo-project/intent-abc'
    // The handler always passes `owner`, so the spec root is the same whether the
    // dev session physically runs in `owner` or in `worktree`.
    expect(getSpecsBase(owner)).toBe(getSpecsBase(owner))
    // And it is NOT keyed on the worktree path (which would split the spec set).
    expect(getSpecsBase(owner)).not.toBe(getSpecsBase(worktree))
  })

  it('AC-2.2: an absolute centralized spec path resolves identically from any worktree', () => {
    const owner = '/Users/foo/project'
    const specAbs = join(getSpecsBase(owner), '2026/06/20/2026-06-20-001-x/spec.md')
    // resolveSpecFileAbs of an absolute path is the same value no matter the
    // workspace argument — so a spec written in one worktree is found from another.
    expect(resolveSpecFileAbs('/any/worktree', specAbs)).toBe(specAbs)
    expect(resolveSpecFileAbs(owner, specAbs)).toBe(specAbs)
  })
})

describe('resolveSpecFileAbs', () => {
  it('returns an absolute spec path unchanged', () => {
    expect(resolveSpecFileAbs('/proj', '/abs/specs/spec.md')).toBe('/abs/specs/spec.md')
  })
  it('joins a relative path against the workspace (legacy/robustness only)', () => {
    expect(resolveSpecFileAbs('/proj', '.specs/x/spec.md')).toBe('/proj/.specs/x/spec.md')
  })
})
