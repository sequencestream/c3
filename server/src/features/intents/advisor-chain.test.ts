/**
 * The advisor chain-depth gate. Over the limit: no agent, no tool, and a
 * `queue_decision_log` row that says why in a stable code.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { insertIntents, resetStoreForTests } from './store.js'
import { listQueueDecisionsForIntent, resetQueueStoreForTests } from './queue-store.js'
import { checkAdvisorChainDepth } from './advisor-chain.js'
import { ADVISOR_MAX_CHAIN_DEPTH } from './advisor-validate.js'
import { QUEUE_RUN_ORIGIN } from '../../kernel/queue/types.js'

let dir: string
let proj: string
let intentId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-advisor-chain-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetQueueStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToId(dir)!)!
  const [intent] = insertIntents(proj, [
    { title: '链深度', shortEnTitle: 'chain', content: '', priority: 'P1' },
  ])
  intentId = intent.id
})

afterEach(() => {
  resetDbForTests()
  resetQueueStoreForTests()
  resetStateCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

function check(chainDepth: number): ReturnType<typeof checkAdvisorChainDepth> {
  return checkAdvisorChainDepth({
    workspacePath: proj,
    intentId,
    chainDepth,
    origin: QUEUE_RUN_ORIGIN,
    now: () => 1_700_000_000_000,
  })
}

describe('checkAdvisorChainDepth', () => {
  it('allows a first consultation and logs nothing', () => {
    expect(check(0)).toEqual({ allowed: true })
    expect(listQueueDecisionsForIntent(intentId)).toHaveLength(0)
  })

  it('allows exactly at the limit', () => {
    expect(check(ADVISOR_MAX_CHAIN_DEPTH).allowed).toBe(true)
    expect(listQueueDecisionsForIntent(intentId)).toHaveLength(0)
  })

  it('refuses past the limit and records a stable reason code', () => {
    const r = check(ADVISOR_MAX_CHAIN_DEPTH + 1)
    expect(r.allowed).toBe(false)
    expect(r).toMatchObject({ reason: 'blocked_chain_depth' })

    const rows = listQueueDecisionsForIntent(intentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      intentId,
      action: 'block',
      blockedGate: 'blocked_chain_depth',
      attemptCount: ADVISOR_MAX_CHAIN_DEPTH + 1,
    })
    // The audit row explains the refusal without carrying a prompt or transcript.
    expect(rows[0]!.rejectReason).toContain(String(ADVISOR_MAX_CHAIN_DEPTH))
  })
})
