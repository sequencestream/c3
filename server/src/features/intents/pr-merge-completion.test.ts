import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import {
  getIntent,
  insertIntents,
  listIntentLogs,
  resetStoreForTests,
  updateIntentReviewFixStatus,
  updateStatus,
  upsertIntentPr,
} from './store.js'
import { completeIntentOnPrsMerged } from './pr-merge-completion.js'

let dir: string
let prevClaudeConfigDir: string | undefined
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-pr-merge-completion-'))
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

/** One in_progress intent, ready for PR rows to be hung on it. */
function inProgressIntent(title: string): string {
  const [intent] = insertIntents(proj, [
    { title, shortEnTitle: title.toLowerCase(), content: '', priority: 'P1' },
  ])
  updateStatus(intent.id, 'in_progress')
  return intent.id
}

/** One reviewing intent, optionally pre-graded, ready for the convergence check. */
function reviewingIntent(title: string, impactLevel?: 'L3' | 'L5'): string {
  const [intent] = insertIntents(proj, [
    {
      title,
      shortEnTitle: title.toLowerCase(),
      content: '',
      priority: 'P1',
      ...(impactLevel ? { impactLevel } : {}),
    },
  ])
  updateStatus(intent.id, 'reviewing')
  return intent.id
}

describe('completeIntentOnPrsMerged', () => {
  it('completes an in_progress intent whose only PR merged', () => {
    const id = inProgressIntent('Merged')
    upsertIntentPr({ intentId: id, number: '10', status: 'merged' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)

    const got = getIntent(id)
    expect(got?.status).toBe('done')
    expect(got?.completedAt).toBeTruthy()
    // The merge settles the review here too: the rule follows the PR aggregate,
    // not the status the intent happened to be sitting in.
    expect(got?.reviewStatus).toBe('approved')
    // The transition is audited as an automation act, not a user's.
    expect(listIntentLogs(id)).toContainEqual(
      expect.objectContaining({
        operationType: 'status_changed',
        summary: '状态变更: in_progress → done',
        actor: 'automation',
      }),
    )
  })

  it('completes when every delivery PR landed, and waits while one is still open', () => {
    const id = inProgressIntent('Multi')
    upsertIntentPr({ intentId: id, deliveryId: 'd1', number: '11', status: 'merged' })
    upsertIntentPr({ intentId: id, deliveryId: 'd2', number: '12', status: 'reviewing' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(false)
    expect(getIntent(id)?.status).toBe('in_progress')

    upsertIntentPr({ intentId: id, deliveryId: 'd2', number: '12', status: 'merged' })
    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)
    expect(getIntent(id)?.status).toBe('done')
  })

  it('treats an abandoned (closed) PR as settled, not as unfinished work', () => {
    const id = inProgressIntent('Closed')
    upsertIntentPr({ intentId: id, deliveryId: 'd1', number: '13', status: 'merged' })
    upsertIntentPr({ intentId: id, deliveryId: 'd2', number: '14', status: 'closed' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)
    expect(getIntent(id)?.status).toBe('done')
  })

  it('leaves an intent alone when a PR failed or was rejected', () => {
    const rejected = inProgressIntent('Rejected')
    upsertIntentPr({ intentId: rejected, number: '15', status: 'rejected' })
    const failed = inProgressIntent('Failed')
    upsertIntentPr({ intentId: failed, deliveryId: 'd1', number: '16', status: 'merged' })
    upsertIntentPr({ intentId: failed, deliveryId: 'd2', number: '17', status: 'failed' })

    expect(completeIntentOnPrsMerged(proj, rejected)).toBe(false)
    expect(completeIntentOnPrsMerged(proj, failed)).toBe(false)
    expect(getIntent(rejected)?.status).toBe('in_progress')
    expect(getIntent(failed)?.status).toBe('in_progress')
  })

  it('only auto-completes from in_progress, and never without a PR', () => {
    const noPr = inProgressIntent('No PR')
    expect(completeIntentOnPrsMerged(proj, noPr)).toBe(false)
    expect(getIntent(noPr)?.status).toBe('in_progress')

    const [todo] = insertIntents(proj, [
      { title: 'Todo', shortEnTitle: 'todo', content: '', priority: 'P1' },
    ])
    upsertIntentPr({ intentId: todo.id, number: '18', status: 'merged' })
    expect(completeIntentOnPrsMerged(proj, todo.id)).toBe(false)
    expect(getIntent(todo.id)?.status).toBe('todo')

    expect(completeIntentOnPrsMerged(proj, 'no-such-intent')).toBe(false)
  })
})

/** The rows this rule writes when the merge supplies the missing conclusion. */
const SETTLE_SUMMARY = 'PR 已全部合并，评审结论按合并结果落为 approved'

const settleRows = (id: string): { operationType: string; actor: string }[] =>
  listIntentLogs(id)
    .filter((log) => log.summary === SETTLE_SUMMARY)
    .map((log) => ({ operationType: log.operationType, actor: log.actor }))

describe('reviewing → done convergence', () => {
  it('merge-first: the merge supplies the conclusion, so one pass reaches done', () => {
    const id = reviewingIntent('Merge first')
    upsertIntentPr({ intentId: id, number: '20', status: 'merged' })

    // No review session ever concluded anything — the merge is reason enough, and
    // the convergence check must see the value this same pass wrote.
    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)

    const got = getIntent(id)
    expect(got?.status).toBe('done')
    expect(got?.reviewStatus).toBe('approved')
    expect(settleRows(id)).toEqual([{ operationType: 'intent_updated', actor: 'automation' }])
    // The convergence it drove is audited separately, as it always was.
    expect(listIntentLogs(id)).toContainEqual(
      expect.objectContaining({
        operationType: 'status_changed',
        summary: '状态变更: reviewing → done',
        actor: 'automation',
      }),
    )
  })

  it('a merge overrides a rejection: the landing PR is the final verdict', () => {
    const id = reviewingIntent('Rejected then merged')
    updateIntentReviewFixStatus(id, { reviewStatus: 'rejected', reviewSessionId: 'rev-1' })
    upsertIntentPr({ intentId: id, number: '23', status: 'merged' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)

    const got = getIntent(id)
    expect(got?.reviewStatus).toBe('approved')
    expect(got?.status).toBe('done')
    // Only the conclusion is rewritten — the review phase's own records survive,
    // so "it was once rejected" stays readable in the session and the logs.
    expect(got?.reviewSessionId).toBe('rev-1')
  })

  it('approve-then-merge: approval alone is not enough while any PR is still open', () => {
    const id = reviewingIntent('Approve first')
    upsertIntentPr({ intentId: id, number: '21', status: 'reviewing' })
    updateIntentReviewFixStatus(id, { reviewStatus: 'approved' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(false)
    expect(getIntent(id)?.status).toBe('reviewing')

    upsertIntentPr({ intentId: id, number: '21', status: 'merged' })
    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)
    expect(getIntent(id)?.status).toBe('done')
  })

  it('L5-direct-merge: an exempt intent converges on the merge alone, no review needed', () => {
    const id = reviewingIntent('L5 merge', 'L5')
    upsertIntentPr({ intentId: id, number: '22', status: 'merged' })

    // needsReview(L5) is false, so a merged aggregate converges without approval.
    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)

    const got = getIntent(id)
    expect(got?.status).toBe('done')
    // The exemption skips the GATE, not the ledger: every merged intent records
    // the same conclusion, which is what the overview's review row now reads.
    expect(got?.reviewStatus).toBe('approved')
    expect(settleRows(id)).toHaveLength(1)
  })

  it('writes nothing extra when the conclusion already agrees with the merge', () => {
    const id = reviewingIntent('Already approved')
    updateIntentReviewFixStatus(id, { reviewStatus: 'approved' })
    upsertIntentPr({ intentId: id, number: '24', status: 'merged' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)
    expect(getIntent(id)?.reviewStatus).toBe('approved')
    // The several paths that observe one merge must not each add a conclusion row.
    expect(settleRows(id)).toHaveLength(0)
  })
})

describe('merge-settled review stays off intents the merge does not reach', () => {
  it('does not settle the review while a PR is still open', () => {
    const id = reviewingIntent('Still open')
    upsertIntentPr({ intentId: id, number: '25', status: 'reviewing' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(false)
    expect(getIntent(id)?.reviewStatus).toBeNull()
    expect(settleRows(id)).toHaveLength(0)
  })

  it('does not settle the review of an intent that never had a run to finish', () => {
    const [todo] = insertIntents(proj, [
      { title: 'Todo', shortEnTitle: 'todo-2', content: '', priority: 'P1' },
    ])
    upsertIntentPr({ intentId: todo.id, number: '26', status: 'merged' })

    expect(completeIntentOnPrsMerged(proj, todo.id)).toBe(false)
    expect(getIntent(todo.id)?.reviewStatus).toBeNull()
    expect(settleRows(todo.id)).toHaveLength(0)
  })
})
