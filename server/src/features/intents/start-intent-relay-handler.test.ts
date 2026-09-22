/**
 * `startIntentRelay` — the human entry point to the PR review / fix relay.
 *
 * The queue path gates on `automate` + `status === 'reviewing'` + `needsReview`
 * + cooldown + a free concurrency slot, because nobody chose to spend the token.
 * A click IS the choice, so this handler must NOT gate on any of them: an
 * `in_progress`, automation-off intent with a manually filed PR is exactly the
 * case it exists for. The cases below pin that, plus the two things a synchronous
 * entry point owes the caller — a reason for every refusal, and a claim that
 * either happened before the handler returned or did not happen at all.
 *
 * The relay EXECUTOR is mocked: what a claimed phase does is covered by the
 * executor's own tests. This file is about the admission decision and the round
 * it hands over. The ledger is seeded through the real business write paths
 * (the claim, and the review/fix status write), so the states the criterion is
 * asked about are states the product can actually reach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import type { SessionRuntime } from '../../runs.js'

/** The executor's verdict, driven per test. */
const admission = vi.fn<(...a: unknown[]) => unknown>(() => ({
  ok: true,
  claimed: { phase: 'review', round: 0 },
}))
const runManualRelayPhase = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve())
vi.mock('./queue-relay-actions.js', () => ({
  admitRelayPhase: (...a: unknown[]) => admission(...a),
  runManualRelayPhase: (...a: unknown[]) => runManualRelayPhase(...a),
}))

import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { ensureRuntime, getRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import {
  claimIntentRelayPhase,
  getIntent,
  insertIntents,
  resetStoreForTests,
  updateIntentReviewFixStatus,
  updateStatus,
  upsertIntentPr,
} from './store.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import { startIntentRelay } from './index.js'

let dir: string
let proj: string
let workspaceName: string
let prevC3Dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-start-relay-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
  proj = resolveWorkspaceRoot(workspaceName)!
  admission.mockReturnValue({ ok: true, claimed: { phase: 'review', round: 0 } })
  runManualRelayPhase.mockResolvedValue(undefined)
})

afterEach(() => {
  removeRuntimesForWorkspace(proj)
  resetDbForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  vi.clearAllMocks()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m) } as unknown as Conn
  return { conn, sent }
}

function fakeCtx(): { ctx: KernelContext; broadcast: ReturnType<typeof vi.fn> } {
  const broadcast = vi.fn()
  return { ctx: { broadcastIntents: broadcast } as unknown as KernelContext, broadcast }
}

function errorCode(sent: ServerToClient[]): string | undefined {
  const err = sent.find((m) => m.type === 'error') as { error: { code: string } } | undefined
  return err?.error.code
}

/**
 * An intent a human would actually be looking at when they click: worktree mode,
 * an active PR, `in_progress`, automation OFF. Every one of those is deliberate —
 * the queue would refuse this intent on three of them.
 */
function seedManualIntent(): string {
  saveWorkspaceSetting(proj, { gitBranchMode: 'worktree' })
  const [r] = insertIntents(proj, [
    { title: '人工评审', shortEnTitle: 'manual', content: 'body', priority: 'P1' },
  ])
  updateStatus(r.id, 'in_progress')
  upsertIntentPr({
    intentId: r.id,
    number: '7',
    status: 'reviewing',
    forge: 'github',
    repo: 'acme/w',
    headBranch: 'intent/manual',
    baseBranch: 'main',
  })
  return r.id
}

/** Write the ledger states a real relay reaches, using the real write paths. */
const ledger = {
  reviewClaimed(id: string, pendingId = 'pending:seed'): void {
    claimIntentRelayPhase(id, {
      phase: 'review',
      pendingSessionId: pendingId,
      expectReviewStatus: null,
      expectFixStatus: null,
      expectRounds: 0,
      nextRounds: 0,
    })
  },
  fixClaimed(id: string, pendingId = 'pending:seed-fix'): void {
    claimIntentRelayPhase(id, {
      phase: 'fix',
      pendingSessionId: pendingId,
      expectReviewStatus: 'rejected',
      expectFixStatus: null,
      expectRounds: 0,
      nextRounds: 1,
    })
  },
  concluded(id: string, patch: Parameters<typeof updateIntentReviewFixStatus>[1]): void {
    updateIntentReviewFixStatus(id, patch)
  },
}

const msg = (intentId: string, phase: 'review' | 'fix' = 'review') =>
  ({ type: 'start_intent_relay', workspaceName, intentId, phase }) as const

describe('startIntentRelay — admission before anything is written', () => {
  it('refuses an unknown workspace', async () => {
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, {
      type: 'start_intent_relay',
      workspaceName: 'no-such-ws',
      intentId: 'x',
      phase: 'review',
    })
    expect(errorCode(sent)).toBe('workspace.unknown')
  })

  it('refuses an unknown intent', async () => {
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg('no-such-intent'))
    expect(errorCode(sent)).toBe('intent.notFound')
  })

  it('reads an intent of another workspace as not found, never as a cross-workspace launch', async () => {
    const other = mkdtempSync(join(tmpdir(), 'c3-start-relay-other-'))
    try {
      addWorkspace(other, 1)
      const otherProj = resolveWorkspaceRoot(pathToName(other)!)!
      const [r] = insertIntents(otherProj, [
        { title: '别的', shortEnTitle: 'other', content: '', priority: 'P1' },
      ])
      const { conn, sent } = fakeConn()
      await startIntentRelay(fakeCtx().ctx, conn, msg(r.id))
      expect(errorCode(sent)).toBe('intent.notFound')
      expect(admission).not.toHaveBeenCalled()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('refuses outside worktree mode — no worktree means no head branch to work on', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch' })
    const [r] = insertIntents(proj, [
      { title: '人工评审', shortEnTitle: 'manual', content: 'body', priority: 'P1' },
    ])
    updateStatus(r.id, 'in_progress')
    upsertIntentPr({
      intentId: r.id,
      number: '7',
      status: 'reviewing',
      forge: 'github',
      repo: 'acme/w',
    })
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(r.id))
    expect(errorCode(sent)).toBe('intent.relay.notWorktree')
    expect(admission).not.toHaveBeenCalled()
  })

  it('refuses when the intent holds no live PR', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree' })
    const [r] = insertIntents(proj, [
      { title: '没有 PR', shortEnTitle: 'no-pr', content: '', priority: 'P1' },
    ])
    updateStatus(r.id, 'in_progress')
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(r.id))
    expect(errorCode(sent)).toBe('intent.relay.noActivePr')
    expect(admission).not.toHaveBeenCalled()
  })

  it('offers the first review of an unreviewed intent', async () => {
    const id = seedManualIntent()
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(id))
    expect(admission).toHaveBeenCalledTimes(1)
    expect(errorCode(sent)).toBeUndefined()
  })

  it('refuses once the review is `approved` — the relay is over for this PR', async () => {
    const id = seedManualIntent()
    ledger.concluded(id, { reviewStatus: 'approved' })
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, { ...msg(id), phase: 'fix' })
    expect(errorCode(sent)).toBe('intent.relay.phaseNotAllowed')
    expect(admission).not.toHaveBeenCalled()
  })

  it('refuses while the phase is genuinely in flight, and says which kind of no it is', async () => {
    // A live run on the review session occupies the phase even though the ledger
    // reads `pending` — which is why "not allowed" and "already running" must be
    // distinguishable answers: one is fixed by waiting, the other is not.
    const id = seedManualIntent()
    const held = 'pending:held-review'
    ledger.reviewClaimed(id, held)
    ensureRuntime(held, proj, 'default', [], 'work')
    getRuntime(held)!.run = { abort: new AbortController(), handle: null } as SessionRuntime['run']

    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(id))
    expect(errorCode(sent)).toBe('intent.relay.phaseInFlight')
    expect(admission).not.toHaveBeenCalled()
  })

  it('re-offers a review whose `pending` session died — a stale placeholder must not lock the round', async () => {
    // The launch never bound and no live run exists. Automated mode is off, so
    // nothing else will ever recover it: the human is the only retry there is.
    const id = seedManualIntent()
    ledger.reviewClaimed(id, 'pending:died')
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(id))
    expect(errorCode(sent)).toBeUndefined()
    expect(admission).toHaveBeenCalledTimes(1)
  })
})

describe('startIntentRelay — the round handed to the executor', () => {
  it('reviews at the current round', async () => {
    const id = seedManualIntent()
    await startIntentRelay(fakeCtx().ctx, fakeConn().conn, msg(id))
    expect(admission.mock.calls[0][1]).toBe('review')
    expect(admission.mock.calls[0][2]).toBe(0)
  })

  it('takes the NEXT round for a fresh fix and RESUMES the round for a dead one', async () => {
    // Hard-coding a round here would put the claim's compare-and-set and the
    // prompt on a different sequence from the queue's, and the fix would either
    // be refused forever or spend the budget twice.
    const id = seedManualIntent()
    ledger.concluded(id, { reviewStatus: 'rejected' })
    await startIntentRelay(fakeCtx().ctx, fakeConn().conn, { ...msg(id), phase: 'fix' })
    expect(admission.mock.calls[0][1]).toBe('fix')
    expect(admission.mock.calls[0][2]).toBe(1)

    // A `pending` fix whose session died re-enters the round it already took.
    ledger.fixClaimed(id)
    vi.mocked(admission).mockClear()
    await startIntentRelay(fakeCtx().ctx, fakeConn().conn, { ...msg(id), phase: 'fix' })
    expect(admission.mock.calls[0][2]).toBe(1)
  })

  it('re-reviews after a fix backfilled `fixed`, at the round the fix took', async () => {
    const id = seedManualIntent()
    ledger.concluded(id, { reviewStatus: 'rejected' })
    ledger.fixClaimed(id, 'pending:fix-done')
    ledger.concluded(id, { fixStatus: 'fixed' })
    await startIntentRelay(fakeCtx().ctx, fakeConn().conn, msg(id))
    expect(admission.mock.calls[0][1]).toBe('review')
    expect(admission.mock.calls[0][2]).toBe(1)
  })

  it('hands the executor a working broadcast and nothing to unwind', async () => {
    const id = seedManualIntent()
    const { ctx, broadcast } = fakeCtx()
    await startIntentRelay(ctx, fakeConn().conn, msg(id))
    const env = admission.mock.calls[0][0] as {
      workspacePath: string
      hooks: { broadcastIntents: unknown }
      isDisposed(): boolean
    }
    expect(env.workspacePath).toBe(proj)
    expect(env.hooks.broadcastIntents).toBe(broadcast)
    // No controller owns a manual round, so it must never decide it was disposed.
    expect(env.isDisposed()).toBe(false)
  })

  it('does NOT gate on automation or on status — that is the whole point', async () => {
    const id = seedManualIntent()
    expect(getIntent(id)!.automate).toBe(false)
    expect(getIntent(id)!.status).toBe('in_progress')
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(id))
    expect(admission).toHaveBeenCalledTimes(1)
    expect(errorCode(sent)).toBeUndefined()
  })
})

describe('startIntentRelay — every admission refusal has a nameable reason', () => {
  const failures = [
    ['agentUnavailable', 'intent.relay.agentUnavailable'],
    ['worktreeUnavailable', 'intent.relay.worktreeUnavailable'],
    ['noActivePr', 'intent.relay.noActivePr'],
    ['projectionWriteFailed', 'intent.relay.claimFailed'],
    ['stale', 'intent.relay.phaseInFlight'],
  ] as const

  for (const [reason, code] of failures) {
    it(`maps \`${reason}\` onto \`${code}\``, async () => {
      const id = seedManualIntent()
      admission.mockReturnValue({ ok: false, failure: { reason, groupRef: '_c3_team' } })
      const { conn, sent } = fakeConn()
      await startIntentRelay(fakeCtx().ctx, conn, msg(id))
      expect(errorCode(sent)).toBe(code)
      // A refusal before the claim starts no session and costs no round.
      expect(runManualRelayPhase).not.toHaveBeenCalled()
    })
  }

  it('names the unusable agent group so the user knows what to fix', async () => {
    const id = seedManualIntent()
    admission.mockReturnValue({
      ok: false,
      failure: { reason: 'agentUnavailable', groupRef: '_c3_claude_team' },
    })
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(id))
    const err = sent.find((m) => m.type === 'error') as {
      error: { params?: Record<string, string> }
    }
    expect(err.error.params).toEqual({ group: '_c3_claude_team' })
  })
})

describe('startIntentRelay — acceptance is the absence of an error', () => {
  it('answers synchronously by starting the phase, with no response frame', async () => {
    const id = seedManualIntent()
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(id))
    expect(sent).toEqual([])
    expect(runManualRelayPhase).toHaveBeenCalledTimes(1)
  })

  it('never reports a LATE failure on a connection that was answered minutes ago', async () => {
    // The phase runs for up to half an hour behind this handler. Its failure is
    // the session's own outcome, observed from the intent and the session UI —
    // an error frame here would arrive long after the answer and read as a fresh
    // rejection of a click the user already saw succeed.
    const id = seedManualIntent()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    runManualRelayPhase.mockRejectedValue(new Error('session exploded'))
    const { conn, sent } = fakeConn()
    await startIntentRelay(fakeCtx().ctx, conn, msg(id))
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toEqual([])
    // Swallowing it would leave the placeholder held with nothing running.
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
