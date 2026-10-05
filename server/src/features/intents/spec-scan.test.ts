/**
 * The two session-launch scan hooks. What matters here is NOT that a function
 * got called — it is that the warning ROWS are observable afterwards, and that
 * a broken metrics write still lets the session launch succeed. A sidechannel
 * that can fail a launch is not a sidechannel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import { removeRuntimesForWorkspace } from '../../runs.js'
import { initTestGitRepo } from '../../../test/git-repo.js'
import { insertIntents, resetStoreForTests, setSpecPath } from './store.js'
import {
  launchSpecReviewSession,
  launchSpecSession,
  type SessionLaunchDeps,
  type SessionLaunchResult,
} from './session-launcher.js'
import { scanSpecForWarnings } from './spec-scan.js'
import { listSpecWarnings } from './spec-metrics-store.js'
import * as metrics from './spec-metrics-store.js'

let dir: string
let proj: string

/** A spec with a defect the analyzer definitely sees: a repeated fact. */
const DEFECTIVE_SPEC = `# 规格

## 方案

返工轮次达到上限后队列必须停止重启作者会话并转人工处理。

## 边界

返工轮次达到上限后队列必须停止重启作者会话并转人工处理。
`

function mockDeps(): SessionLaunchDeps {
  return {
    launchRun: vi.fn().mockResolvedValue(undefined) as unknown as SessionLaunchDeps['launchRun'],
    broadcastIntents: vi.fn(),
  }
}

function asSuccess(r: SessionLaunchResult): { success: true; sessionId: string } {
  expect(r.success).toBe(true)
  return r as { success: true; sessionId: string }
}

/** An intent with a real spec file on disk, as the rework/review paths expect. */
function seedAuthoredSpec(): string {
  const [intent] = insertIntents(proj, [
    { title: 'Scanned', shortEnTitle: 'scanned', content: 'body', priority: 'P2' },
  ])
  const file = join(dir, `${intent.id}.md`)
  writeFileSync(file, DEFECTIVE_SPEC, 'utf8')
  // Only `specPath` is what the launch paths read; promoting the doc to `pending`
  // would drag the approval-todo sync (another domain's tables) into this test
  // without changing what the scan hook does.
  setSpecPath(intent.id, file)
  return intent.id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-scan-'))
  initTestGitRepo(dir)
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToName(dir)!)!
})

afterEach(() => {
  removeRuntimesForWorkspace(proj)
  vi.restoreAllMocks()
  resetDbForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('scanSpecForWarnings', () => {
  it('records observable warning rows, not just a call', () => {
    const [intent] = insertIntents(proj, [
      { title: 'S', shortEnTitle: 's', content: 'b', priority: 'P2' },
    ])
    const file = join(dir, 'spec.md')
    writeFileSync(file, DEFECTIVE_SPEC, 'utf8')

    const count = scanSpecForWarnings(proj, file, intent.id)
    expect(count).toBeGreaterThan(0)
    const rows = listSpecWarnings(intent.id)
    expect(rows).toHaveLength(count)
    expect(rows.every((r) => r.severity === 'warn')).toBe(true)
  })

  it('treats an unreadable spec as zero warnings, not as a failure', () => {
    expect(scanSpecForWarnings(proj, join(dir, 'missing.md'), 'nobody')).toBe(0)
    expect(listSpecWarnings('nobody')).toEqual([])
  })
})

describe('the review session launch scans and records', () => {
  it('lands the warning rows in the metrics table', async () => {
    const id = seedAuthoredSpec()
    const deps = mockDeps()
    asSuccess(await launchSpecReviewSession(proj, id, deps))

    expect(deps.launchRun).toHaveBeenCalledTimes(1)
    expect(listSpecWarnings(id).length).toBeGreaterThan(0)
  })

  it('still launches the review when the warning write throws', async () => {
    const id = seedAuthoredSpec()
    // Make the store's write path fail the way a damaged table would.
    vi.spyOn(metrics, 'recordSpecWarnings').mockImplementation(() => {
      throw new Error('metrics table is on fire')
    })
    const deps = mockDeps()

    // The whole point of the sidechannel: a broken metrics write must not take
    // the review session with it. The launch succeeds and the run still fires.
    const r = await launchSpecReviewSession(proj, id, deps)
    expect(r.success).toBe(true)
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
  })

  it('keeps the authoring session alive when the warning write throws', async () => {
    const id = seedAuthoredSpec()
    vi.spyOn(metrics, 'recordSpecWarnings').mockImplementation(() => {
      throw new Error('metrics table is on fire')
    })
    const deps = mockDeps()
    const r = await launchSpecSession(proj, id, deps, undefined, 'test', {
      reworkReason: 'reviewer findings',
      reworkRound: 1,
    })
    expect(r.success).toBe(true)
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
  })
})

describe('the authoring session launch scans and records', () => {
  it('lands the warning rows when re-opening an authored spec', async () => {
    const id = seedAuthoredSpec()
    const deps = mockDeps()
    asSuccess(
      await launchSpecSession(proj, id, deps, undefined, 'test', {
        reworkReason: 'reviewer findings',
        reworkRound: 1,
      }),
    )

    expect(deps.launchRun).toHaveBeenCalledTimes(1)
    expect(listSpecWarnings(id).length).toBeGreaterThan(0)
  })

  it('leaves a first-time launch unmeasured: a seed is not an authored spec', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Fresh', shortEnTitle: 'fresh', content: 'b', priority: 'P2' },
    ])
    const deps = mockDeps()
    asSuccess(await launchSpecSession(proj, intent.id, deps))
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
    expect(listSpecWarnings(intent.id)).toEqual([])
  })
})
