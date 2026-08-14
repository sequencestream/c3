import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../git.js', () => ({
  getForgePrStatus: vi.fn(),
}))

vi.mock('../../kernel/config/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../kernel/config/index.js')>(
    '../../kernel/config/index.js',
  )
  return {
    ...actual,
    getForgeOverride: vi.fn(() => 'github'),
  }
})

import { getForgePrStatus } from '../../git.js'
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
  resetStoreForTests,
  setBranchName,
  updateStatus,
  upsertIntentPr,
} from './store.js'
import { depsWithUnconfirmedPr, syncIntentPrStatus } from './pr-status-sync.js'

let dir: string
let prevClaudeConfigDir: string | undefined
let workspaceName: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-pr-sync-'))
  prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
  proj = resolveWorkspaceRoot(workspaceName)!
  vi.mocked(getForgePrStatus).mockReset()
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

describe('syncIntentPrStatus', () => {
  it('writes merged status only after the forge confirms it', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Done', shortEnTitle: 'done', content: '', priority: 'P1' },
    ])
    updateStatus(intent.id, 'done')
    setBranchName(intent.id, 'intent/done')
    upsertIntentPr({
      intentId: intent.id,
      number: '42',
      status: 'reviewing',
      url: 'https://example/pr/42',
    })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'merged' })
    const broadcastIntents = vi.fn()

    await expect(
      syncIntentPrStatus({ workspacePath: proj, intentId: intent.id, broadcastIntents }),
    ).resolves.toMatchObject({ ok: true, changed: true, prStatus: 'merged' })

    const got = getIntent(intent.id)
    expect(got?.status).toBe('done')
    expect(got?.prs).toHaveLength(1)
    expect(got?.prs[0]).toMatchObject({
      number: '42',
      url: 'https://example/pr/42',
      status: 'merged',
    })
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
  })

  it('can persist closed without unblocking as merged', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Done', shortEnTitle: 'done', content: '', priority: 'P1' },
    ])
    updateStatus(intent.id, 'done')
    upsertIntentPr({ intentId: intent.id, number: '43', status: 'reviewing' })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'closed' })

    await syncIntentPrStatus({ workspacePath: proj, intentId: intent.id })

    expect(getIntent(intent.id)?.prs[0].status).toBe('closed')
  })

  it('does not write when the intent has no reviewing PR or the forge query fails', async () => {
    const [noPr, failed] = insertIntents(proj, [
      { title: 'No PR', shortEnTitle: 'no-pr', content: '', priority: 'P1' },
      { title: 'Failed', shortEnTitle: 'failed', content: '', priority: 'P1' },
    ])
    updateStatus(noPr.id, 'done')
    updateStatus(failed.id, 'done')
    upsertIntentPr({ intentId: failed.id, number: '44', status: 'reviewing' })
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: false, error: 'not found' })

    await expect(
      syncIntentPrStatus({ workspacePath: proj, intentId: noPr.id }),
    ).resolves.toMatchObject({ ok: false, changed: false })
    await expect(
      syncIntentPrStatus({ workspacePath: proj, intentId: failed.id }),
      // The failure names the PR it belongs to — with several rows in flight, a
      // bare message could not say which one the forge refused.
    ).resolves.toMatchObject({ ok: false, changed: false, error: '#44: not found' })

    expect(getIntent(noPr.id)?.prs).toEqual([])
    expect(getIntent(failed.id)?.prs[0].status).toBe('reviewing')
  })

  // The gate is the PR row, not the intent: an intent that is still `todo` or
  // back in `in_progress` must not lose the ability to learn its PR merged.
  it.each(['todo', 'in_progress', 'done'] as const)(
    'syncs a reviewing PR whatever the intent status is (%s)',
    async (status) => {
      const [intent] = insertIntents(proj, [
        { title: `S-${status}`, shortEnTitle: 's', content: '', priority: 'P1' },
      ])
      if (status !== 'todo') updateStatus(intent.id, 'in_progress')
      if (status === 'done') updateStatus(intent.id, 'done')
      upsertIntentPr({ intentId: intent.id, number: '77', status: 'reviewing' })
      vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'merged' })

      await expect(
        syncIntentPrStatus({ workspacePath: proj, intentId: intent.id }),
      ).resolves.toMatchObject({ ok: true, changed: true, prStatus: 'merged' })
      expect(getIntent(intent.id)?.prs[0].status).toBe('merged')
    },
  )
})

describe('depsWithUnconfirmedPr', () => {
  it('selects a dependency with a reviewing PR regardless of its own status', () => {
    const [dep] = insertIntents(proj, [
      { title: 'Still in progress', shortEnTitle: 'wip', content: '', priority: 'P1' },
    ])
    updateStatus(dep.id, 'in_progress')
    upsertIntentPr({ intentId: dep.id, number: '5', status: 'reviewing' })

    expect(depsWithUnconfirmedPr([dep.id], [getIntent(dep.id)!]).map((i) => i.id)).toEqual([dep.id])
  })

  it('selects done dependencies with PRs whose merge is not confirmed', () => {
    const [merged, reviewing, noPr] = insertIntents(proj, [
      { title: 'Merged', shortEnTitle: 'merged', content: '', priority: 'P1' },
      { title: 'Reviewing', shortEnTitle: 'reviewing', content: '', priority: 'P1' },
      { title: 'No PR', shortEnTitle: 'no-pr', content: '', priority: 'P1' },
    ])
    updateStatus(merged.id, 'done')
    updateStatus(reviewing.id, 'done')
    updateStatus(noPr.id, 'done')
    upsertIntentPr({ intentId: merged.id, number: '1', status: 'merged' })
    upsertIntentPr({ intentId: reviewing.id, number: '2', status: 'reviewing' })

    expect(
      depsWithUnconfirmedPr(
        [merged.id, reviewing.id, noPr.id],
        [getIntent(merged.id)!, getIntent(reviewing.id)!, getIntent(noPr.id)!],
      ).map((intent) => intent.id),
    ).toEqual([reviewing.id])
  })
})
