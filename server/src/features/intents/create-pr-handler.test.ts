/**
 * `createPrHandler` gate — manual PR creation drops the `done` requirement and
 * instead demands worktree mode + a branch + committable changes. Covers the
 * success path (commit/push in the intent worktree, then create the PR, write the
 * three PR fields, broadcast, log `pr_created`, publish one 'event' (pr:operation)
 * create/success event) and every rejection branch (existing PR, current-branch,
 * blank branch, no changes, commit/push failure, PR-create failure) — asserting
 * each short-circuits with no PR fields, no success log, and no success event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { GenericEvent } from '@ccc/shared'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import {
  PR_EVENT_TYPES,
  PR_LEGACY_EVENT_TYPE,
  normalizePrGenericEvent,
} from '../pr-events/tool-defs.js'

vi.mock('../../git.js', async () => {
  const actual = await vi.importActual<typeof import('../../git.js')>('../../git.js')
  return {
    ...actual,
    createGhPr: vi.fn(),
    commitAndPush: vi.fn(),
    hasDiffAgainstMain: vi.fn(),
  }
})

import { commitAndPush, createGhPr, hasDiffAgainstMain } from '../../git.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
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
  setBranchName,
  setPrInfo,
  updateStatus,
} from './store.js'
import { createPrHandler } from './index.js'
import { getWorktreePath } from './worktree.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-create-pr-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
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
  vi.mocked(createGhPr).mockReset()
  vi.mocked(commitAndPush).mockReset()
  vi.mocked(hasDiffAgainstMain).mockReset()
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
    subject: 'erin',
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

function fakeCtx(): {
  ctx: KernelContext
  broadcast: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
} {
  const broadcast = vi.fn()
  const publish = vi.fn()
  const registry = new EventNormalizerRegistry()
  for (const t of PR_EVENT_TYPES) registry.register(t, normalizePrGenericEvent)
  registry.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)
  const ctx = {
    broadcastIntents: broadcast,
    eventBus: { publish },
    normalizeEvent: (core: GenericEvent) => registry.normalize(core),
  } as unknown as KernelContext
  return { ctx, broadcast, publish }
}

/** The connection-directed stage frames, in the order they were pushed. */
function stagesOf(sent: ServerToClient[]): string[] {
  return sent
    .filter((m) => m.type === 'create_pr_progress')
    .map((m) => (m as { stage: string }).stage)
}

function errorsOf(sent: ServerToClient[]): string[] {
  return sent
    .filter((m) => m.type === 'error')
    .map((m) => (m as { error: { code: string } }).error.code)
}

function logsOf(intentId: string, op: string) {
  return listIntentLogs(intentId).filter((l) => l.operationType === op)
}

/** Seed a qualifying intent: worktree mode + a branch. Changes are mocked per test. */
function seedQualifying(status: 'todo' | 'in_progress' = 'todo') {
  saveWorkspaceSetting(proj, { gitBranchMode: 'worktree' })
  const [r] = insertIntents(proj, [
    { title: 'PR me', shortEnTitle: 'pr-me', content: 'body', priority: 'P1' },
  ])
  if (status !== 'todo') updateStatus(r.id, status)
  setBranchName(r.id, 'intent/pr-me')
  return r
}

describe('createPrHandler — worktree gate success paths', () => {
  for (const status of ['todo', 'in_progress'] as const) {
    it(`commits in the intent worktree then creates a PR for a ${status} intent`, async () => {
      const r = seedQualifying(status)
      vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
      vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
      vi.mocked(createGhPr).mockResolvedValue({ ok: true, prId: '42', prUrl: 'https://x/pr/42' })
      const { ctx, broadcast, publish } = fakeCtx()
      const { conn, sent } = fakeConn()

      await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

      const worktreePath = getWorktreePath(proj, r.id)
      // Ordered: check changes → commit/push in the worktree → create the PR there.
      expect(hasDiffAgainstMain).toHaveBeenCalledWith(worktreePath)
      // The third argument is the progress reporter (see the staged-progress suite).
      expect(commitAndPush).toHaveBeenCalledWith(worktreePath, 'feat: PR me', expect.any(Function))
      expect(createGhPr).toHaveBeenCalledWith(worktreePath, 'feat: PR me', 'body', 'intent/pr-me')

      // Response + the three PR fields written atomically on success.
      expect(sent).toContainEqual({
        type: 'create_pr_response',
        intentId: r.id,
        prId: '42',
        prUrl: 'https://x/pr/42',
      })
      const after = getIntent(r.id)!
      expect(after.prId).toBe('42')
      expect(after.prUrl).toBe('https://x/pr/42')
      expect(after.prStatus).toBe('reviewing')
      // Status is untouched — PR creation never flips the intent to done.
      expect(after.status).toBe(status)

      expect(logsOf(r.id, 'pr_created')).toMatchObject([{ summary: '创建 PR #42', actor: 'erin' }])
      expect(broadcast).toHaveBeenCalled()
      const prEvents = publish.mock.calls.filter((c) => c[0] === 'event')
      expect(prEvents).toHaveLength(1)
    })
  }
})

describe('createPrHandler — rejection branches short-circuit without side effects', () => {
  function expectNoSuccessSideEffects(intentId: string, publish: ReturnType<typeof vi.fn>) {
    const after = getIntent(intentId)!
    expect(after.prId).toBeNull()
    expect(after.prStatus).toBeNull()
    expect(logsOf(intentId, 'pr_created')).toHaveLength(0)
    expect(publish.mock.calls.filter((c) => c[0] === 'event')).toHaveLength(0)
  }

  it('rejects an intent that already has a PR without touching Git', async () => {
    const r = seedQualifying()
    setPrInfo(r.id, '7', 'reviewing')
    const { ctx, publish } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(errorsOf(sent)).toEqual(['intent.prCreateFailed'])
    expect(hasDiffAgainstMain).not.toHaveBeenCalled()
    expect(commitAndPush).not.toHaveBeenCalled()
    expect(createGhPr).not.toHaveBeenCalled()
    // The pre-existing PR fields are left intact; no new create log or event.
    expect(logsOf(r.id, 'pr_created')).toHaveLength(0)
    expect(publish.mock.calls.filter((c) => c[0] === 'event')).toHaveLength(0)
  })

  it('rejects current-branch mode with prCreateNotWorktree', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch' })
    const [r] = insertIntents(proj, [
      { title: 'CB', shortEnTitle: 'cb', content: '', priority: 'P1' },
    ])
    setBranchName(r.id, 'intent/cb')
    const { ctx, publish } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(errorsOf(sent)).toEqual(['intent.prCreateNotWorktree'])
    expect(hasDiffAgainstMain).not.toHaveBeenCalled()
    expect(commitAndPush).not.toHaveBeenCalled()
    expect(createGhPr).not.toHaveBeenCalled()
    expectNoSuccessSideEffects(r.id, publish)
  })

  it('rejects a blank/missing branch with prCreateNoBranch', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree' })
    const [r] = insertIntents(proj, [
      { title: 'NB', shortEnTitle: 'nb', content: '', priority: 'P1' },
    ])
    setBranchName(r.id, '   ')
    const { ctx, publish } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(errorsOf(sent)).toEqual(['intent.prCreateNoBranch'])
    expect(hasDiffAgainstMain).not.toHaveBeenCalled()
    expect(commitAndPush).not.toHaveBeenCalled()
    expectNoSuccessSideEffects(r.id, publish)
  })

  it('rejects a clean worktree with prCreateNoChanges', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(false)
    const { ctx, publish } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(errorsOf(sent)).toEqual(['intent.prCreateNoChanges'])
    expect(commitAndPush).not.toHaveBeenCalled()
    expect(createGhPr).not.toHaveBeenCalled()
    expectNoSuccessSideEffects(r.id, publish)
  })

  it('surfaces a commit/push failure as prCreateFailed and never creates the PR', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    vi.mocked(commitAndPush).mockResolvedValue({
      ok: false,
      committed: true,
      error: 'push rejected',
      failure: 'other',
    })
    const { ctx, publish } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(errorsOf(sent)).toEqual(['intent.prCreateFailed'])
    expect(createGhPr).not.toHaveBeenCalled()
    expectNoSuccessSideEffects(r.id, publish)
  })

  it('surfaces a PR-create failure as prCreateFailed with no PR fields or event', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(createGhPr).mockResolvedValue({ ok: false, error: 'gh failed' })
    const { ctx, publish } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(errorsOf(sent)).toEqual(['intent.prCreateFailed'])
    expectNoSuccessSideEffects(r.id, publish)
  })
})

/**
 * Staged progress — the connection-directed `create_pr_progress` frames that drive
 * the client overlay. The contract is order + reach: stages advance one-way, a
 * gate that rejects before the diff check reports nothing, and a failure never
 * reports a stage the run did not get to.
 */
describe('createPrHandler — staged progress frames', () => {
  /** Mock a commit/push that reports its two boundaries like the real one does. */
  function mockCommitAndPush(result: Awaited<ReturnType<typeof commitAndPush>>, upTo: 1 | 2 = 2) {
    vi.mocked(commitAndPush).mockImplementation(async (_path, _msg, onPhase) => {
      onPhase?.('committing')
      if (upTo === 2) onPhase?.('pushing')
      return result
    })
  }

  it('pushes the four stages in execution order, all before the success response', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    mockCommitAndPush({ ok: true, committed: true })
    vi.mocked(createGhPr).mockResolvedValue({ ok: true, prId: '42', prUrl: 'https://x/pr/42' })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(stagesOf(sent)).toEqual(['analyzing-changes', 'committing', 'pushing', 'creating-pr'])
    // Every frame carries the requested intent, and the response is the terminal.
    expect(
      sent
        .filter((m) => m.type === 'create_pr_progress')
        .map((m) => (m as { intentId: string }).intentId),
    ).toEqual([r.id, r.id, r.id, r.id])
    expect(sent[sent.length - 1].type).toBe('create_pr_response')
  })

  it('de-duplicates a multi-repo workspace back into one one-way pass', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    // Two affected sub-repos → the real commitAndPush reports each boundary twice.
    vi.mocked(commitAndPush).mockImplementation(async (_path, _msg, onPhase) => {
      onPhase?.('committing')
      onPhase?.('pushing')
      onPhase?.('committing')
      onPhase?.('pushing')
      return { ok: true, committed: true }
    })
    vi.mocked(createGhPr).mockResolvedValue({ ok: true, prId: '42' })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(stagesOf(sent)).toEqual(['analyzing-changes', 'committing', 'pushing', 'creating-pr'])
  })

  it('sends no stage when a gate ahead of the diff check rejects', async () => {
    // Already has a PR — the idempotent guard, no Git work at all.
    const withPr = seedQualifying()
    setPrInfo(withPr.id, '7', 'reviewing')
    // Not worktree mode / blank branch, each on its own intent + connection.
    const { ctx } = fakeCtx()
    const a = fakeConn()
    await createPrHandler(ctx, a.conn, { type: 'create_pr', workspaceId, intentId: withPr.id })
    expect(stagesOf(a.sent)).toEqual([])

    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch' })
    const [cb] = insertIntents(proj, [
      { title: 'CB', shortEnTitle: 'cb', content: '', priority: 'P1' },
    ])
    setBranchName(cb.id, 'intent/cb')
    const b = fakeConn()
    await createPrHandler(ctx, b.conn, { type: 'create_pr', workspaceId, intentId: cb.id })
    expect(stagesOf(b.sent)).toEqual([])

    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree' })
    const [nb] = insertIntents(proj, [
      { title: 'NB', shortEnTitle: 'nb', content: '', priority: 'P1' },
    ])
    setBranchName(nb.id, '   ')
    const c = fakeConn()
    await createPrHandler(ctx, c.conn, { type: 'create_pr', workspaceId, intentId: nb.id })
    expect(stagesOf(c.sent)).toEqual([])
  })

  it('stops at the analysis stage when the worktree has no changes', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(false)
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(stagesOf(sent)).toEqual(['analyzing-changes'])
    expect(errorsOf(sent)).toEqual(['intent.prCreateNoChanges'])
  })

  it('stops at the commit stage when the commit fails', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    mockCommitAndPush(
      { ok: false, committed: false, error: 'hook failed', failure: 'commit-hook' },
      1,
    )
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(stagesOf(sent)).toEqual(['analyzing-changes', 'committing'])
    expect(errorsOf(sent)).toEqual(['intent.prCreateFailed'])
  })

  it('stops at the push stage when the push fails after a local commit', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    mockCommitAndPush({ ok: false, committed: true, error: 'push rejected', failure: 'other' })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(stagesOf(sent)).toEqual(['analyzing-changes', 'committing', 'pushing'])
    expect(createGhPr).not.toHaveBeenCalled()
    expect(errorsOf(sent)).toEqual(['intent.prCreateFailed'])
  })

  it('reports the PR-create stage it reached even when the forge call fails', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    mockCommitAndPush({ ok: true, committed: true })
    vi.mocked(createGhPr).mockResolvedValue({ ok: false, error: 'gh failed' })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(stagesOf(sent)).toEqual(['analyzing-changes', 'committing', 'pushing', 'creating-pr'])
    expect(errorsOf(sent)).toEqual(['intent.prCreateFailed'])
    expect(sent.some((m) => m.type === 'create_pr_response')).toBe(false)
  })
})

/**
 * Run correlation — the client's `requestId` must come back on every frame this
 * run emits. Without it a client cannot tell its own terminal from an unrelated
 * error on the same connection, nor a retry's reply from the run it replaced.
 */
describe('createPrHandler — request correlation', () => {
  /** Every frame's echoed token (undefined when the frame carries none). */
  function tokensOf(sent: ServerToClient[]): (string | undefined)[] {
    return sent.map((m) => (m as { requestId?: string }).requestId)
  }

  it('echoes the token on every progress frame and on the success response', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    vi.mocked(commitAndPush).mockImplementation(async (_path, _msg, onPhase) => {
      onPhase?.('committing')
      onPhase?.('pushing')
      return { ok: true, committed: true }
    })
    vi.mocked(createGhPr).mockResolvedValue({ ok: true, prId: '42' })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, {
      type: 'create_pr',
      workspaceId,
      intentId: r.id,
      requestId: 'req-1',
    })

    expect(tokensOf(sent)).toEqual(Array(sent.length).fill('req-1'))
    expect(sent[sent.length - 1]).toMatchObject({
      type: 'create_pr_response',
      intentId: r.id,
      requestId: 'req-1',
    })
  })

  it('echoes the token on the failure error, gate rejections included', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(false)
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, {
      type: 'create_pr',
      workspaceId,
      intentId: r.id,
      requestId: 'req-2',
    })

    expect(sent).toContainEqual({
      type: 'error',
      error: { code: 'intent.prCreateNoChanges' },
      requestId: 'req-2',
    })

    // Same for the earliest gate, which rejects before any workspace resolution.
    const unknown = fakeConn()
    await createPrHandler(ctx, unknown.conn, {
      type: 'create_pr',
      workspaceId: 'no-such-workspace',
      intentId: r.id,
      requestId: 'req-3',
    })
    expect(unknown.sent).toContainEqual({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: 'no-such-workspace' } },
      requestId: 'req-3',
    })
  })

  it('omits the field entirely for a client that sent no token', async () => {
    const r = seedQualifying()
    vi.mocked(hasDiffAgainstMain).mockResolvedValue(true)
    vi.mocked(commitAndPush).mockResolvedValue({ ok: true, committed: true })
    vi.mocked(createGhPr).mockResolvedValue({ ok: true, prId: '42' })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await createPrHandler(ctx, conn, { type: 'create_pr', workspaceId, intentId: r.id })

    expect(sent.every((m) => !('requestId' in m))).toBe(true)
  })
})
