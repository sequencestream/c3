/**
 * The canonical-path ⇄ registered-workspace bridge. The property under test is
 * that equivalence is decided in canonical space while the value handed back is
 * the REGISTRY spelling — mixing the two would make a symlinked workspace read
 * as empty (the stores partition by the registry path).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalPathToWorkspaceId,
  listRegisteredWorkspaceCanonicalPaths,
  resolveRegisteredWorkspacePath,
  workspaceIdToCanonicalPath,
} from './workspace-scope.js'
import { canonicalizeWorkspacePath } from '../../kernel/config/mcp-api-keys.js'
import { addWorkspace, pathToId, removeWorkspace, resetStateCacheForTests } from '../../state.js'

let home: string
let prevHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-ws-scope-'))
  prevHome = process.env.HOME
  process.env.HOME = home
  resetStateCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetStateCacheForTests()
  rmSync(home, { recursive: true, force: true })
})

function register(name: string): string {
  const p = join(home, name)
  mkdirSync(p, { recursive: true })
  addWorkspace(p, Date.now())
  return p
}

describe('resolveRegisteredWorkspacePath', () => {
  it('returns the registry path for the workspace itself', () => {
    const p = register('alpha')
    expect(resolveRegisteredWorkspacePath(canonicalizeWorkspacePath(p)!)).toBe(p)
  })

  it('matches an equivalent spelling — trailing separator, dot segments', () => {
    const p = register('alpha')
    expect(resolveRegisteredWorkspacePath(`${p}/`)).toBe(p)
    expect(resolveRegisteredWorkspacePath(`${p}/sub/..`)).toBe(p)
  })

  it('matches through a symlink and still answers with the registry path', () => {
    const p = register('alpha')
    const link = join(home, 'alpha-link')
    symlinkSync(p, link)
    // A grant made through the link canonicalizes onto the same directory…
    expect(canonicalizeWorkspacePath(link)).toBe(canonicalizeWorkspacePath(p))
    // …and resolution hands back the path the stores are partitioned by.
    expect(resolveRegisteredWorkspacePath(link)).toBe(p)
  })

  it('refuses a path that is not a registered workspace', () => {
    register('alpha')
    expect(resolveRegisteredWorkspacePath(join(home, 'not-registered'))).toBeNull()
  })

  it('refuses a registered workspace whose directory is gone', () => {
    const p = register('alpha')
    rmSync(p, { recursive: true, force: true })
    expect(resolveRegisteredWorkspacePath(p)).toBeNull()
  })

  it('refuses a relative path outright', () => {
    register('alpha')
    expect(resolveRegisteredWorkspacePath('alpha')).toBeNull()
  })
})

describe('id ⇄ canonical path', () => {
  it('round-trips a registered workspace', () => {
    const p = register('alpha')
    const id = pathToId(p)!
    expect(workspaceIdToCanonicalPath(id)).toBe(canonicalizeWorkspacePath(p))
    expect(canonicalPathToWorkspaceId(canonicalizeWorkspacePath(p)!)).toBe(id)
  })

  it('answers null for a forged or removed id', () => {
    const p = register('alpha')
    const id = pathToId(p)!
    removeWorkspace(p)
    expect(workspaceIdToCanonicalPath(id)).toBeNull()
    expect(workspaceIdToCanonicalPath('made-up')).toBeNull()
  })

  it('answers null for a path no registered workspace covers — a stale grant', () => {
    register('alpha')
    expect(canonicalPathToWorkspaceId(join(home, 'beta'))).toBeNull()
  })

  it('lists every registered workspace once, canonically', () => {
    const a = register('alpha')
    const b = register('beta')
    expect(listRegisteredWorkspaceCanonicalPaths().sort()).toEqual(
      [canonicalizeWorkspacePath(a)!, canonicalizeWorkspacePath(b)!].sort(),
    )
  })
})
