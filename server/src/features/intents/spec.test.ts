/**
 * `approve_spec` handler — the human approval checkpoint. Verifies against the
 * real store that approving lands `spec_approved=true` + the current login
 * subject in `spec_approve_user` and broadcasts, and that approving an intent
 * with no authored spec is rejected (the defensive server guard behind the UI).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecPath,
  updateIntentDeps,
} from './store.js'
import { approveSpecHandler, buildSeedSpec, readSpecHandler } from './spec.js'
import { getSpecsBase } from './specs-root.js'
import { saveWorkspaceSetting } from '../../kernel/config/index.js'
import { writeSpecHandler } from './spec.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-approve-spec-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  // Anchor the centralized spec root under the temp dir for read_spec tests.
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(over: Partial<Conn> = {}): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: 'alice',
    authed: true,
    authToken: null,
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    ...over,
  } as Conn
  return { conn, sent }
}

describe('buildSeedSpec', () => {
  it('keeps only identity metadata and omits the stale document status label', () => {
    const content = buildSeedSpec(
      { id: 'int-1', title: 'Cached endpoint' } as NonNullable<ReturnType<typeof getIntent>>,
      '2026-06-22T00:00:00.000Z',
    )
    const frontmatter = content.split('---')[1]

    expect(frontmatter).toContain('intent_id: int-1')
    expect(frontmatter).toContain('title: Cached endpoint')
    expect(frontmatter).toContain('created: 2026-06-22T00:00:00.000Z')
    expect(frontmatter).not.toMatch(/^status:/m)
  })
})

describe('writeSpecHandler dependency context', () => {
  it('blocks an unfinished worktree dependency before scaffolding or launching', () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const [dependency, target] = insertIntents(proj, [
      { title: 'Dependency', shortEnTitle: 'dep', content: '', priority: 'P1' },
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1', dependsOn: [] },
    ])
    updateIntentDeps(target.id, [{ dependsOnId: dependency.id, depType: 'blocks' }])
    const launchRun = vi.fn()
    const { conn, sent } = fakeConn()
    writeSpecHandler({ launchRun, broadcastIntents: vi.fn() } as unknown as KernelContext, conn, {
      type: 'write_spec',
      workspaceId,
      intentId: target.id,
    })
    expect(sent).toEqual([
      {
        type: 'error',
        error: {
          code: 'intent.dependencyNotMerged',
          params: { title: dependency.title, id: dependency.id },
        },
      },
    ])
    expect(getIntent(target.id)?.specPath).toBeNull()
    expect(launchRun).not.toHaveBeenCalled()
  })

  it('continues to launch after a best-effort pull failure', () => {
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    const launchRun = vi.fn().mockResolvedValue(undefined)
    const { conn, sent } = fakeConn()
    writeSpecHandler({ launchRun, broadcastIntents: vi.fn() } as unknown as KernelContext, conn, {
      type: 'write_spec',
      workspaceId,
      intentId: target.id,
    })
    expect(launchRun).toHaveBeenCalledTimes(1)
    expect(getIntent(target.id)?.specPath).toBeTruthy()
    expect(sent).toEqual([
      { type: 'spec_launch_progress', intentId: target.id, stage: 'pulling-code' },
      { type: 'spec_launch_progress', intentId: target.id, stage: 'launching' },
    ])
  })
})

describe('approveSpecHandler', () => {
  it('approves: sets spec_approved=true + records the current subject, then broadcasts', () => {
    const [r] = insertIntents(proj, [
      { title: 'Cached endpoint', shortEnTitle: 'cache', content: '', priority: 'P1' },
    ])
    setSpecPath(r.id, '.specs/2026/06/18/2026-06-18-001-cache/spec.md')

    const broadcastIntents = vi.fn()
    const ctx = { broadcastIntents } as unknown as KernelContext
    const { conn, sent } = fakeConn({ subject: 'bob' })

    approveSpecHandler(ctx, conn, { type: 'approve_spec', workspaceId, intentId: r.id })

    const got = getIntent(r.id)
    expect(got?.specApproved).toBe(true)
    expect(got?.specApproveUser).toBe('bob')
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
    expect(sent).toEqual([])
  })

  it('rejects approving an intent whose spec was never written (no specPath)', () => {
    const [r] = insertIntents(proj, [
      { title: 'No spec yet', shortEnTitle: 'nospec', content: '', priority: 'P2' },
    ])

    const broadcastIntents = vi.fn()
    const ctx = { broadcastIntents } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    approveSpecHandler(ctx, conn, { type: 'approve_spec', workspaceId, intentId: r.id })

    expect(getIntent(r.id)?.specApproved).toBe(false)
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.specNotWritten' } }])
  })

  it('rejects an unknown intent id', () => {
    const broadcastIntents = vi.fn()
    const ctx = { broadcastIntents } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    approveSpecHandler(ctx, conn, { type: 'approve_spec', workspaceId, intentId: 'nope' })

    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
  })
})

describe('readSpecHandler (REQ-5: read the centralized spec)', () => {
  const ctx = {} as unknown as KernelContext

  it('AC-5.1: reads spec.md from the centralized root and echoes the absolute path', () => {
    const [r] = insertIntents(proj, [
      { title: 'Cached endpoint', shortEnTitle: 'cache', content: '', priority: 'P1' },
    ])
    const fileAbs = join(getSpecsBase(proj), '2026/06/20/2026-06-20-001-cache/spec.md')
    mkdirSync(dirname(fileAbs), { recursive: true })
    writeFileSync(fileAbs, '# Centralized spec', 'utf8')
    setSpecPath(r.id, fileAbs)

    const { conn, sent } = fakeConn()
    readSpecHandler(ctx, conn, { type: 'read_spec', workspaceId, intentId: r.id })

    expect(sent).toEqual([
      {
        type: 'file_read',
        workspaceId,
        file: {
          path: fileAbs,
          size: Buffer.byteLength('# Centralized spec'),
          binary: false,
          truncated: false,
          content: '# Centralized spec',
        },
      },
    ])
  })

  it('rejects when no spec has been written (no specPath)', () => {
    const [r] = insertIntents(proj, [
      { title: 'No spec', shortEnTitle: 'nospec', content: '', priority: 'P2' },
    ])
    const { conn, sent } = fakeConn()
    readSpecHandler(ctx, conn, { type: 'read_spec', workspaceId, intentId: r.id })
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.specNotWritten' } }])
  })

  it('fail-closed: rejects a spec path outside the centralized root (no legacy .specs)', () => {
    const [r] = insertIntents(proj, [
      { title: 'Legacy', shortEnTitle: 'legacy', content: '', priority: 'P2' },
    ])
    // A legacy in-workspace relative path resolves under the workspace, NOT the
    // centralized root → rejected (Out-of-Scope: no migration / no recognition).
    setSpecPath(r.id, '.specs/2026/06/20/2026-06-20-001-legacy/spec.md')
    const { conn, sent } = fakeConn()
    readSpecHandler(ctx, conn, { type: 'read_spec', workspaceId, intentId: r.id })
    expect(sent).toEqual([
      {
        type: 'error',
        error: {
          code: 'codes.readFailed',
          params: { path: '.specs/2026/06/20/2026-06-20-001-legacy/spec.md' },
        },
      },
    ])
  })
})
