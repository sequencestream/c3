/**
 * Business-logic tests for the framing-free PR review / fix sync tool cores
 * `runSyncIntentReviewStatus` / `runSyncIntentFixStatus`, driven DIRECTLY (no MCP
 * wrapper). These write ONLY a terminal conclusion + the session that produced it:
 *  - a success echoes the stored intentId + session id + status as JSON;
 *  - the terminal-only enum is re-validated at the core even without the transport
 *    zod gate, so `pending` never reaches the store;
 *  - an unknown or a cross-workspace id reads as a not-found error (no leak);
 *  - neither tool writes the other phase, increments the round counter, or touches
 *    WorkNotes;
 *  - a store failure surfaces as an `isError` text rather than a receipt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces are
// unregistered, so resolve/pathToName/workspaceNameFor would otherwise return null.
// This makes `findOwnedIntent`'s cross-workspace guard resolve predictably.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))
import { resetDbForTests } from '../../kernel/infra/db.js'
import { recordQueueReviewClaim } from './merge-authority.js'
import { getQueueIntentMetaById, resetQueueStoreForTests } from './queue-store.js'
import {
  claimIntentRelayPhase,
  getIntent,
  insertIntents,
  resetStoreForTests,
  updateIntentReviewFixStatus,
} from './store.js'
import {
  runSyncIntentFixStatus,
  runSyncIntentReviewStatus,
  type ReviewFixToolResult,
  type SyncIntentFixStatusArgs,
  type SyncIntentReviewStatusArgs,
  type TrustedRelayCaller,
} from './review-fix-tool-defs.js'

const proj = '/abs/review-fix-tools-proj'
const otherProj = '/abs/review-fix-tools-other'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-review-fix-tools-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetQueueStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  resetQueueStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function seedIntent(workspace = proj): string {
  const [intent] = insertIntents(workspace, [
    { title: '目标意图', shortEnTitle: 'auto', content: '正文', priority: 'P1' },
  ])
  return intent.id
}

/** Success result: assert !isError and return the parsed JSON. */
function payload(r: ReviewFixToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy()
  return JSON.parse(r.content[0].text) as Record<string, unknown>
}

function errorText(r: ReviewFixToolResult): string {
  expect(r.isError).toBe(true)
  return r.content[0].text
}

describe('sync_intent_review_status core', () => {
  it('writes an approved terminal and echoes the stored fields', () => {
    const id = seedIntent()
    const out = payload(
      runSyncIntentReviewStatus(proj, {
        intentId: id,
        reviewSessionId: 'rev-1',
        reviewStatus: 'approved',
      }),
    )
    expect(out).toEqual({ intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'approved' })
    expect(getIntent(id)!.reviewStatus).toBe('approved')
    expect(getIntent(id)!.reviewSessionId).toBe('rev-1')
  })

  it('writes a rejected terminal', () => {
    const id = seedIntent()
    const out = payload(
      runSyncIntentReviewStatus(proj, {
        intentId: id,
        reviewSessionId: 'rev-2',
        reviewStatus: 'rejected',
      }),
    )
    expect(out).toEqual({ intentId: id, reviewSessionId: 'rev-2', reviewStatus: 'rejected' })
    expect(getIntent(id)!.reviewStatus).toBe('rejected')
  })

  it('re-validates the terminal-only enum even without the transport layer', () => {
    const id = seedIntent()
    const args = {
      intentId: id,
      reviewSessionId: 'rev-1',
      reviewStatus: 'pending',
    } as unknown as SyncIntentReviewStatusArgs
    const text = errorText(runSyncIntentReviewStatus(proj, args))
    expect(text).toContain('approved')
    expect(getIntent(id)!.reviewStatus).toBeNull()
  })

  it('does not touch the fix phase, the round counter, or WorkNotes', () => {
    const id = seedIntent()
    runSyncIntentReviewStatus(proj, {
      intentId: id,
      reviewSessionId: 'rev-1',
      reviewStatus: 'rejected',
    })
    const after = getIntent(id)!
    expect(after.fixSessionId).toBeNull()
    expect(after.fixStatus).toBeNull()
    expect(after.reviewFixRounds).toBe(0) // a rejected review does NOT increment rounds here
  })

  it('reads an unknown id as a not-found error', () => {
    const text = errorText(
      runSyncIntentReviewStatus(proj, {
        intentId: 'nope',
        reviewSessionId: 'rev-1',
        reviewStatus: 'approved',
      }),
    )
    expect(text).toContain('未找到')
    expect(text).toContain('nope')
  })

  it('refuses an id from another workspace (not found, no leak)', () => {
    const other = seedIntent(otherProj)
    const text = errorText(
      runSyncIntentReviewStatus(proj, {
        intentId: other,
        reviewSessionId: 'rev-1',
        reviewStatus: 'approved',
      }),
    )
    expect(text).toContain('未找到')
    expect(text).not.toContain('目标意图')
  })

  it('broadcasts exactly once on success and never on failure', () => {
    const id = seedIntent()
    const onBroadcast = vi.fn()
    runSyncIntentReviewStatus(
      proj,
      { intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'approved' },
      onBroadcast,
    )
    expect(onBroadcast).toHaveBeenCalledTimes(1)
    expect(onBroadcast).toHaveBeenCalledWith(proj)

    onBroadcast.mockClear()
    runSyncIntentReviewStatus(
      proj,
      { intentId: 'nope', reviewSessionId: 'rev-1', reviewStatus: 'approved' },
      onBroadcast,
    )
    expect(onBroadcast).not.toHaveBeenCalled()
  })
})

describe('sync_intent_fix_status core', () => {
  it('writes a fixed terminal and echoes the stored fields', () => {
    const id = seedIntent()
    const out = payload(
      runSyncIntentFixStatus(proj, { intentId: id, fixSessionId: 'fix-1', fixStatus: 'fixed' }),
    )
    expect(out).toEqual({ intentId: id, fixSessionId: 'fix-1', fixStatus: 'fixed' })
    expect(getIntent(id)!.fixStatus).toBe('fixed')
    expect(getIntent(id)!.fixSessionId).toBe('fix-1')
  })

  it('re-validates the single-terminal enum even without the transport layer', () => {
    const id = seedIntent()
    const args = {
      intentId: id,
      fixSessionId: 'fix-1',
      fixStatus: 'pending',
    } as unknown as SyncIntentFixStatusArgs
    const text = errorText(runSyncIntentFixStatus(proj, args))
    expect(text).toContain('fixed')
    expect(getIntent(id)!.fixStatus).toBeNull()
  })

  it('does not touch the review phase, the round counter, or WorkNotes', () => {
    const id = seedIntent()
    runSyncIntentReviewStatus(proj, {
      intentId: id,
      reviewSessionId: 'rev-1',
      reviewStatus: 'rejected',
    })
    runSyncIntentFixStatus(proj, { intentId: id, fixSessionId: 'fix-1', fixStatus: 'fixed' })

    const after = getIntent(id)!
    expect(after.reviewSessionId).toBe('rev-1') // review phase untouched
    expect(after.reviewStatus).toBe('rejected') // fixed does NOT imply approved
    expect(after.reviewFixRounds).toBe(0)
  })

  it('reads an unknown id as a not-found error', () => {
    const text = errorText(
      runSyncIntentFixStatus(proj, { intentId: 'nope', fixSessionId: 'fix-1', fixStatus: 'fixed' }),
    )
    expect(text).toContain('未找到')
    expect(text).toContain('nope')
  })

  it('broadcasts exactly once on success and never on failure', () => {
    const id = seedIntent()
    const onBroadcast = vi.fn()
    runSyncIntentFixStatus(
      proj,
      { intentId: id, fixSessionId: 'fix-1', fixStatus: 'fixed' },
      onBroadcast,
    )
    expect(onBroadcast).toHaveBeenCalledTimes(1)
    expect(onBroadcast).toHaveBeenCalledWith(proj)

    onBroadcast.mockClear()
    runSyncIntentFixStatus(
      proj,
      { intentId: 'nope', fixSessionId: 'fix-1', fixStatus: 'fixed' },
      onBroadcast,
    )
    expect(onBroadcast).not.toHaveBeenCalled()
  })
})

describe('store failure surfaces as an error (not a receipt)', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    resetDbForTests()
    resetStoreForTests()
  })

  it('both sync tools report isError with a store-unavailable reason', () => {
    expect(
      errorText(
        runSyncIntentReviewStatus(proj, {
          intentId: 'x',
          reviewSessionId: 'rev-1',
          reviewStatus: 'approved',
        }),
      ),
    ).toContain('不可用')
    expect(
      errorText(
        runSyncIntentFixStatus(proj, { intentId: 'x', fixSessionId: 'fix-1', fixStatus: 'fixed' }),
      ),
    ).toContain('不可用')
  })
})

describe('a phase the queue holds only accepts its own session (stale backfill)', () => {
  it('refuses a review conclusion from a session that no longer holds the phase', () => {
    const id = seedIntent()
    claimIntentRelayPhase(id, {
      phase: 'review',
      expectReviewStatus: null,
      expectFixStatus: null,
      expectRounds: 0,
      nextRounds: 0,
      pendingSessionId: 'pending:round-3',
    })
    const refused = errorText(
      runSyncIntentReviewStatus(proj, {
        intentId: id,
        reviewSessionId: 'pending:round-2',
        reviewStatus: 'approved',
      }),
    )
    expect(refused).toContain('不再持有')
    expect(getIntent(id)!.reviewStatus).toBe('pending')
  })

  it('accepts the holding session, and repeating the same terminal stays idempotent', () => {
    const id = seedIntent()
    claimIntentRelayPhase(id, {
      phase: 'review',
      expectReviewStatus: null,
      expectFixStatus: null,
      expectRounds: 0,
      nextRounds: 0,
      pendingSessionId: 'pending:rev-1',
    })
    const args: SyncIntentReviewStatusArgs = {
      intentId: id,
      reviewSessionId: 'pending:rev-1',
      reviewStatus: 'rejected',
    }
    expect(payload(runSyncIntentReviewStatus(proj, args)).reviewStatus).toBe('rejected')
    expect(payload(runSyncIntentReviewStatus(proj, args)).reviewStatus).toBe('rejected')
    expect(getIntent(id)!.reviewFixRounds).toBe(0)
  })

  it('refuses a fix conclusion from an expired round’s session', () => {
    const id = seedIntent()
    updateIntentReviewFixStatus(id, { reviewStatus: 'rejected', reviewSessionId: 'rev-1' })
    claimIntentRelayPhase(id, {
      phase: 'fix',
      expectReviewStatus: 'rejected',
      expectFixStatus: null,
      expectRounds: 0,
      nextRounds: 1,
      pendingSessionId: 'pending:fix-2',
    })
    const refused = errorText(
      runSyncIntentFixStatus(proj, {
        intentId: id,
        fixSessionId: 'pending:fix-1',
        fixStatus: 'fixed',
      }),
    )
    expect(refused).toContain('不再持有')
    expect(getIntent(id)!.fixStatus).toBe('pending')
  })

  it('leaves an intent nobody is driving open to a plain manual backfill', () => {
    const id = seedIntent()
    const args: SyncIntentFixStatusArgs = {
      intentId: id,
      fixSessionId: 'human-session',
      fixStatus: 'fixed',
    }
    expect(payload(runSyncIntentFixStatus(proj, args)).fixStatus).toBe('fixed')
  })
})

describe('merge authority — only the server-attributed queue review grants it', () => {
  const pinned = {
    forge: 'github' as const,
    repo: 'acme/app',
    number: '42',
    headBranch: 'intent/a',
    baseBranch: 'main',
    headSha: 'abc1234',
  }

  beforeEach(() => resetQueueStoreForTests())

  it('a trusted review run concluding approved turns the claim into a credential', () => {
    const id = seedIntent()
    recordQueueReviewClaim({ workspacePath: proj, intentId: id, sessionId: 'rev-1', prs: [pinned] })

    const trusted: TrustedRelayCaller = { intentId: id, phase: 'review', sessionId: 'rev-1' }
    payload(
      runSyncIntentReviewStatus(
        proj,
        { intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'approved' },
        undefined,
        trusted,
      ),
    )

    const meta = getQueueIntentMetaById(id)
    expect(meta.mergeGrant?.reviewSessionId).toBe('rev-1')
    expect(meta.mergePhase).toBe('pending')
  })

  it('a manual backfill that merely names the queue session writes the conclusion but grants nothing', () => {
    const id = seedIntent()
    recordQueueReviewClaim({ workspacePath: proj, intentId: id, sessionId: 'rev-1', prs: [pinned] })

    payload(
      runSyncIntentReviewStatus(
        proj,
        { intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'approved' },
        undefined,
        null,
      ),
    )

    expect(getIntent(id)!.reviewStatus).toBe('approved')
    expect(getQueueIntentMetaById(id).mergeGrant).toBeNull()
  })

  it('a trusted run for a different intent grants nothing', () => {
    const id = seedIntent()
    recordQueueReviewClaim({ workspacePath: proj, intentId: id, sessionId: 'rev-1', prs: [pinned] })

    const trusted: TrustedRelayCaller = {
      intentId: 'other-intent',
      phase: 'review',
      sessionId: 'rev-1',
    }
    payload(
      runSyncIntentReviewStatus(
        proj,
        { intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'approved' },
        undefined,
        trusted,
      ),
    )

    expect(getQueueIntentMetaById(id).mergeGrant).toBeNull()
  })

  it('a trusted run of the WRONG phase grants nothing', () => {
    const id = seedIntent()
    recordQueueReviewClaim({ workspacePath: proj, intentId: id, sessionId: 'rev-1', prs: [pinned] })

    const trusted: TrustedRelayCaller = { intentId: id, phase: 'fix', sessionId: 'rev-1' }
    payload(
      runSyncIntentReviewStatus(
        proj,
        { intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'approved' },
        undefined,
        trusted,
      ),
    )

    expect(getQueueIntentMetaById(id).mergeGrant).toBeNull()
  })

  it('a rejected conclusion drops a credential the same round had earned', () => {
    const id = seedIntent()
    recordQueueReviewClaim({ workspacePath: proj, intentId: id, sessionId: 'rev-1', prs: [pinned] })
    runSyncIntentReviewStatus(
      proj,
      { intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'approved' },
      undefined,
      { intentId: id, phase: 'review', sessionId: 'rev-1' },
    )
    expect(getQueueIntentMetaById(id).mergeGrant).not.toBeNull()

    runSyncIntentReviewStatus(
      proj,
      { intentId: id, reviewSessionId: 'rev-1', reviewStatus: 'rejected' },
      undefined,
      { intentId: id, phase: 'review', sessionId: 'rev-1' },
    )
    expect(getQueueIntentMetaById(id).mergeGrant).toBeNull()
  })
})
