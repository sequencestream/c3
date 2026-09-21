/**
 * The queue's automatic-merge path and the review conclusion it inherits.
 *
 * Driven through the RECOVERY branch (`action.recover`), which is the whole merge
 * path minus the forge commands: it re-reads the ledger, runs the same
 * `syncIntentPrStatus` → `completeIntentOnPrsMerged` pair, and only then writes
 * its decision row. That makes it the cheap way to pin the property this
 * family's convergence has to keep — the path calls the convergence check TWICE
 * (the sync runs it, then the action runs it again), so a settle that was not
 * idempotent would write a second `approved` row on every auto-merge.
 *
 * The approval is seeded because the queue cannot reach this branch without one:
 * `mergeDenial` refuses the merge outright when the review is not `approved`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueueAction } from '../../kernel/queue/index.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import type { QueueActionContext } from './queue-action-context.js'
import {
  getIntent,
  insertIntents,
  listIntentLogs,
  resetStoreForTests,
  updateIntentReviewFixStatus,
  updateStatus,
  upsertIntentPr,
} from './store.js'
import { runMergePhase } from './queue-merge-actions.js'

let dir: string
let prevClaudeConfigDir: string | undefined
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-queue-merge-'))
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToName(dir)!)!
})

afterEach(() => {
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/**
 * The narrow window this branch touches. The full {@link QueueActionContext} is
 * deliberately wider (state projection, completion marking, abort) — none of
 * which an already-landed merge reads — so the rest is stubbed and cast rather
 * than faked, to keep it obvious that this test claims nothing about them.
 */
function ctxStub(): QueueActionContext {
  return {
    workspacePath: proj,
    hooks: {
      broadcastIntents: vi.fn(),
      broadcastQueueDetail: vi.fn(),
    },
    tickId: () => 'tick-1',
    requestPass: vi.fn(),
  } as unknown as QueueActionContext
}

const SETTLE_SUMMARY = 'PR 已全部合并，评审结论按合并结果落为 approved'

const settleRows = (id: string): string[] =>
  listIntentLogs(id)
    .filter((log) => log.summary === SETTLE_SUMMARY)
    .map((log) => `${log.operationType}/${log.actor}`)

describe('runMergePhase — an already-approved intent', () => {
  it('settles on the merge without writing a second review conclusion', async () => {
    const [intent] = insertIntents(proj, [
      {
        title: 'Auto merged',
        shortEnTitle: 'auto-merged',
        content: '',
        priority: 'P1',
        impactLevel: 'L3',
      },
    ])
    updateStatus(intent.id, 'reviewing')
    updateIntentReviewFixStatus(intent.id, { reviewStatus: 'approved' })
    upsertIntentPr({ intentId: intent.id, number: '70', status: 'merged' })

    const ctx = ctxStub()
    const action: Extract<QueueAction, { kind: 'merge_prs' }> = {
      kind: 'merge_prs',
      intentId: intent.id,
      origin: 'queue',
      recover: true,
    }
    await runMergePhase(ctx, action, getIntent(intent.id)!)

    const got = getIntent(intent.id)
    expect(got?.status).toBe('done')
    expect(got?.reviewStatus).toBe('approved')
    // The sync settles, then the action's own convergence call runs again over
    // the same merged aggregate. Exactly one conclusion row, not two.
    expect(settleRows(intent.id)).toEqual([])
  })
})
