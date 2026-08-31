/**
 * `linkIntentPrHandler` — associate an externally created PR with an intent
 * target after forge lookup and HEAD SHA verification.
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
  projectPrOperationEvent,
} from '../pr-events/tool-defs.js'

vi.mock('../../git.js', async () => {
  const actual = await vi.importActual<typeof import('../../git.js')>('../../git.js')
  return {
    ...actual,
    getForgePrLinkFacts: vi.fn(),
    getHeadCommit: vi.fn(),
  }
})

import { getForgePrLinkFacts, getHeadCommit } from '../../git.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  listIntentLogs,
  resetStoreForTests,
  setBranchName,
  upsertIntentPr,
} from './store.js'
import { linkIntentPrHandler } from './index.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceName: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-link-pr-'))
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
  workspaceName = pathToName(dir)!
  proj = resolveWorkspaceRoot(workspaceName)!
  vi.mocked(getForgePrLinkFacts).mockReset()
  vi.mocked(getHeadCommit).mockReset()
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

function seedQualifying() {
  saveWorkspaceSetting(proj, { gitBranchMode: 'worktree' })
  const [r] = insertIntents(proj, [
    { title: 'Link me', shortEnTitle: 'link-me', content: 'body', priority: 'P1' },
  ])
  setBranchName(r.id, 'intent/link-me')
  return r
}

describe('linkIntentPrHandler', () => {
  it('links an existing PR when HEAD matches forge head SHA', async () => {
    const r = seedQualifying()
    vi.mocked(getHeadCommit).mockResolvedValue('abc123deadbeef')
    vi.mocked(getForgePrLinkFacts).mockResolvedValue({
      ok: true,
      number: '42',
      status: 'reviewing',
      prUrl: 'https://github.com/o/r/pull/42',
      headSha: 'abc123deadbeef',
      headBranch: 'intent/link-me',
      baseBranch: 'main',
    })
    const { ctx, broadcast, publish } = fakeCtx()
    const { conn, sent } = fakeConn()

    await linkIntentPrHandler(ctx, conn, {
      type: 'link_intent_pr',
      workspaceName,
      intentId: r.id,
      prReference: 'https://github.com/o/r/pull/42',
    })

    expect(sent).toContainEqual({
      type: 'link_intent_pr_response',
      workspaceName,
      intentId: r.id,
      prId: '42',
      prUrl: 'https://github.com/o/r/pull/42',
    })
    const after = getIntent(r.id)!
    expect(after.prs).toHaveLength(1)
    expect(after.prs[0]).toMatchObject({
      number: '42',
      url: 'https://github.com/o/r/pull/42',
      status: 'reviewing',
      forge: 'github',
      repo: 'o/r',
    })
    expect(logsOf(r.id, 'pr_created')).toMatchObject([
      { summary: '外部关联 PR #42', actor: 'erin' },
    ])
    expect(broadcast).toHaveBeenCalled()
    const prEvents = publish.mock.calls.filter((c) => c[0] === 'event')
    expect(prEvents).toHaveLength(1)
    const envelope = prEvents[0][1] as { event: GenericEvent }
    expect(projectPrOperationEvent(envelope.event)).toMatchObject({
      operation: 'create',
      result: 'success',
      association: { intentId: r.id },
    })
  })

  it('rejects when worktree HEAD does not match PR head SHA', async () => {
    const r = seedQualifying()
    vi.mocked(getHeadCommit).mockResolvedValue('aaa111')
    vi.mocked(getForgePrLinkFacts).mockResolvedValue({
      ok: true,
      number: '42',
      headSha: 'bbb222',
      prUrl: 'https://github.com/o/r/pull/42',
    })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await linkIntentPrHandler(ctx, conn, {
      type: 'link_intent_pr',
      workspaceName,
      intentId: r.id,
      prReference: '42',
    })

    expect(errorsOf(sent)).toEqual(['intent.prLinkCommitMismatch'])
    expect(getIntent(r.id)!.prs).toEqual([])
  })

  it('rejects when the PR is already owned by another intent', async () => {
    const r = seedQualifying()
    const [other] = insertIntents(proj, [
      { title: 'Other', shortEnTitle: 'other', content: '', priority: 'P1' },
    ])
    upsertIntentPr({
      intentId: other.id,
      number: '42',
      status: 'reviewing',
      forge: 'github',
      repo: 'o/r',
      url: 'https://github.com/o/r/pull/42',
    })
    vi.mocked(getHeadCommit).mockResolvedValue('abc123')
    vi.mocked(getForgePrLinkFacts).mockResolvedValue({
      ok: true,
      number: '42',
      headSha: 'abc123',
      prUrl: 'https://github.com/o/r/pull/42',
    })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await linkIntentPrHandler(ctx, conn, {
      type: 'link_intent_pr',
      workspaceName,
      intentId: r.id,
      prReference: '42',
    })

    expect(errorsOf(sent)).toEqual(['intent.prLinkPrOccupied'])
    expect(getIntent(r.id)!.prs).toEqual([])
  })

  it('rejects when forge is unavailable', async () => {
    const r = seedQualifying()
    vi.mocked(getHeadCommit).mockResolvedValue('abc123')
    vi.mocked(getForgePrLinkFacts).mockResolvedValue({
      ok: false,
      unavailable: true,
      error: 'gh CLI 未安装',
    })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await linkIntentPrHandler(ctx, conn, {
      type: 'link_intent_pr',
      workspaceName,
      intentId: r.id,
      prReference: '42',
    })

    expect(errorsOf(sent)).toEqual(['intent.prLinkForgeUnavailable'])
  })

  it('rejects when the target pair already has an active PR', async () => {
    const r = seedQualifying()
    upsertIntentPr({ intentId: r.id, number: '7', status: 'reviewing' })
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await linkIntentPrHandler(ctx, conn, {
      type: 'link_intent_pr',
      workspaceName,
      intentId: r.id,
      prReference: '42',
    })

    expect(errorsOf(sent)).toEqual(['intent.prLinkActivePrExists'])
    expect(getForgePrLinkFacts).not.toHaveBeenCalled()
  })

  it('rejects non-worktree mode via prCreateNotWorktree', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch' })
    const [r] = insertIntents(proj, [
      { title: 'CB', shortEnTitle: 'cb', content: '', priority: 'P1' },
    ])
    setBranchName(r.id, 'intent/cb')
    const { ctx } = fakeCtx()
    const { conn, sent } = fakeConn()

    await linkIntentPrHandler(ctx, conn, {
      type: 'link_intent_pr',
      workspaceName,
      intentId: r.id,
      prReference: '42',
    })

    expect(errorsOf(sent)).toEqual(['intent.prCreateNotWorktree'])
    expect(getForgePrLinkFacts).not.toHaveBeenCalled()
  })
})
