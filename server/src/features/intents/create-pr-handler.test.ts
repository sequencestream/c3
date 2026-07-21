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
      expect(commitAndPush).toHaveBeenCalledWith(worktreePath, 'feat: PR me')
      expect(createGhPr).toHaveBeenCalledWith(worktreePath, 'feat: PR me', 'body', 'intent/pr-me')

      // Response + the three PR fields written atomically on success.
      expect(sent).toContainEqual({
        type: 'create_pr_response',
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
