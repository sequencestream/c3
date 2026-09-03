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

describe('completeIntentOnPrsMerged', () => {
  it('completes an in_progress intent whose only PR merged', () => {
    const id = inProgressIntent('Merged')
    upsertIntentPr({ intentId: id, number: '10', status: 'merged' })

    expect(completeIntentOnPrsMerged(proj, id)).toBe(true)

    const got = getIntent(id)
    expect(got?.status).toBe('done')
    expect(got?.completedAt).toBeTruthy()
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
