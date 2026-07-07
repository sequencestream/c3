/**
 * `update_spec_content` handler — the human inline spec-source edit. Verifies
 * against the real store + real files under the centralized specs root:
 *  - happy path (todo, not started, no live spec session): overwrites the file,
 *    logs `spec_updated`, broadcasts, and sends an `intent_logs_list` refresh.
 *  - approved spec: overwrite also revokes approval (`spec_approved=false`,
 *    `spec_approve_user=null`) with a `spec_unapproved` log + a `spec_updated` log.
 *  - three gates re-checked server-side: no specPath, non-todo / started, live spec
 *    session — each rejected with the intent left untouched (no file write, no log).
 *  - path fail-closed: a specPath resolving outside the centralized root is rejected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  listIntentLogs,
  resetStoreForTests,
  setLastWorkSession,
  setSpecApproved,
  setSpecPath,
  setSpecSessionId,
  updateStatus,
} from './store.js'
import { updateSpecContentHandler } from './spec.js'
import { getSpecsBase } from './specs-root.js'
import { ensureRuntime, getRuntime, removeRuntime } from '../../runs.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-edit-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  // Anchor the centralized spec root under the temp dir so the write lands in it.
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
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

function fakeCtx(): { ctx: KernelContext; broadcastIntents: ReturnType<typeof vi.fn> } {
  const broadcastIntents = vi.fn()
  return { ctx: { broadcastIntents } as unknown as KernelContext, broadcastIntents }
}

function logsOf(intentId: string, op?: string) {
  const logs = listIntentLogs(intentId)
  return op ? logs.filter((l) => l.operationType === op) : logs
}

/** Seed a spec file under the centralized root and backfill the intent's spec_path. */
function seedSpec(intentId: string, initial: string): string {
  const fileAbs = join(getSpecsBase(proj), '2026/07/07/2026-07-07-001-spec/spec.md')
  mkdirSync(dirname(fileAbs), { recursive: true })
  writeFileSync(fileAbs, initial, 'utf8')
  setSpecPath(intentId, fileAbs)
  return fileAbs
}

describe('update_spec_content — happy path', () => {
  it('todo + not started + no live spec session: overwrites, logs spec_updated, broadcasts, refreshes logs', () => {
    const [r] = insertIntents(proj, [
      { title: 'Editable', shortEnTitle: 'edit', content: '', priority: 'P1' },
    ])
    const fileAbs = seedSpec(r.id, '# old spec')
    const before = getIntent(r.id)!
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn({ subject: 'bob' })

    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: '# new spec body',
    })

    expect(readFileSync(fileAbs, 'utf8')).toBe('# new spec body')
    const after = getIntent(r.id)!
    // updated_at bumped by setSpecApproved(false) so the client has a broadcast signal.
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
    expect(after.specApproved).toBe(false)
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
    expect(logsOf(r.id, 'spec_updated')).toMatchObject([
      { summary: '直接编辑 spec 内容', actor: 'bob' },
    ])
    // Unapproved before → no spec_unapproved row.
    expect(logsOf(r.id, 'spec_unapproved')).toHaveLength(0)
    // An already-open changelog tab gets a same-frame refresh.
    const frame = sent.find((m) => m.type === 'intent_logs_list')
    expect(frame).toMatchObject({ intentId: r.id })
  })

  it('approved spec: overwrite revokes approval + logs spec_unapproved and spec_updated', () => {
    const [r] = insertIntents(proj, [
      { title: 'Approved', shortEnTitle: 'appr', content: '', priority: 'P1' },
    ])
    const fileAbs = seedSpec(r.id, '# approved spec')
    setSpecApproved(r.id, true, 'carol')
    expect(getIntent(r.id)!.specApproved).toBe(true)

    const { ctx } = fakeCtx()
    const { conn } = fakeConn({ subject: 'bob' })
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: '# revised spec',
    })

    expect(readFileSync(fileAbs, 'utf8')).toBe('# revised spec')
    const after = getIntent(r.id)!
    expect(after.specApproved).toBe(false)
    expect(after.specApproveUser).toBeNull()
    expect(logsOf(r.id, 'spec_unapproved')).toMatchObject([
      { summary: '直接编辑 spec 后撤销审批', actor: 'bob' },
    ])
    expect(logsOf(r.id, 'spec_updated')).toHaveLength(1)
  })

  it("defaults the log actor to 'system' when the connection has no subject", () => {
    const [r] = insertIntents(proj, [
      { title: 'NoSubject', shortEnTitle: 'ns', content: '', priority: 'P1' },
    ])
    seedSpec(r.id, '# x')
    const { ctx } = fakeCtx()
    const { conn } = fakeConn({ subject: null })
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: '# y',
    })
    expect(logsOf(r.id, 'spec_updated')[0].actor).toBe('system')
  })
})

describe('update_spec_content — gates (server re-checks, intent untouched)', () => {
  it('rejects when no spec has been written (no specPath)', () => {
    const [r] = insertIntents(proj, [
      { title: 'NoSpec', shortEnTitle: 'nospec', content: '', priority: 'P2' },
    ])
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: 'x',
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.specNotWritten' } }])
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(logsOf(r.id, 'spec_updated')).toHaveLength(0)
  })

  it('rejects a non-todo status and leaves the file + approval + logs untouched', () => {
    const [r] = insertIntents(proj, [
      { title: 'Started', shortEnTitle: 'started', content: '', priority: 'P1' },
    ])
    const fileAbs = seedSpec(r.id, '# keep')
    updateStatus(r.id, 'in_progress')
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: '# should not land',
    })
    expect(readFileSync(fileAbs, 'utf8')).toBe('# keep')
    expect(sent).toEqual([
      {
        type: 'error',
        error: { code: 'intent.specEditForbidden', params: { status: 'in_progress' } },
      },
    ])
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(logsOf(r.id, 'spec_updated')).toHaveLength(0)
  })

  it('rejects when development has started (lastWorkSessionId set) even while status is todo', () => {
    const [r] = insertIntents(proj, [
      { title: 'HasWork', shortEnTitle: 'haswork', content: '', priority: 'P1' },
    ])
    const fileAbs = seedSpec(r.id, '# keep')
    setLastWorkSession(r.id, 'work-1')
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: '# should not land',
    })
    expect(readFileSync(fileAbs, 'utf8')).toBe('# keep')
    expect(sent).toEqual([
      { type: 'error', error: { code: 'intent.specEditForbidden', params: { status: 'todo' } } },
    ])
  })

  it('rejects when the spec session is running (isRunning)', () => {
    const [r] = insertIntents(proj, [
      { title: 'LiveSpec', shortEnTitle: 'live', content: '', priority: 'P1' },
    ])
    const fileAbs = seedSpec(r.id, '# keep')
    // Link a spec session and mark its runtime as mid-run so isRunning() → true.
    const specSessionId = 'spec-live-1'
    setSpecSessionId(r.id, specSessionId)
    const rt = ensureRuntime(specSessionId, proj, 'default' as never, [], 'spec')
    rt.run = {} as never

    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: '# should not land',
    })
    expect(readFileSync(fileAbs, 'utf8')).toBe('# keep')
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.specSessionRunning' } }])
    expect(broadcastIntents).not.toHaveBeenCalled()
    // A dropped (idle) runtime is NOT running → editable again.
    getRuntime(specSessionId)!.run = null
    removeRuntime(specSessionId)
  })

  it('fail-closed: rejects a spec path outside the centralized root (legacy .specs)', () => {
    const [r] = insertIntents(proj, [
      { title: 'Legacy', shortEnTitle: 'legacy', content: '', priority: 'P2' },
    ])
    // A legacy in-workspace relative path resolves under the workspace, NOT the
    // centralized root → rejected before any write.
    setSpecPath(r.id, '.specs/2026/07/07/2026-07-07-001-legacy/spec.md')
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: r.id,
      content: '# nope',
    })
    expect(sent).toEqual([
      {
        type: 'error',
        error: {
          code: 'codes.invalidPath',
          params: { path: '.specs/2026/07/07/2026-07-07-001-legacy/spec.md' },
        },
      },
    ])
    expect(broadcastIntents).not.toHaveBeenCalled()
  })

  it('rejects an unknown intent id', () => {
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()
    updateSpecContentHandler(ctx, conn, {
      type: 'update_spec_content',
      workspaceId,
      intentId: 'nope',
      content: 'x',
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
  })
})
