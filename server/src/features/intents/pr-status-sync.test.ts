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
  pathToId,
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
  setPrInfo,
  updateStatus,
} from './store.js'
import { depsWithUnconfirmedPr, syncIntentPrStatus } from './pr-status-sync.js'

let dir: string
let prevClaudeConfigDir: string | undefined
let workspaceId: string
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
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
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
    setPrInfo(intent.id, '42', 'reviewing', 'https://example/pr/42')
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'merged' })
    const broadcastIntents = vi.fn()

    await expect(
      syncIntentPrStatus({ workspacePath: proj, intentId: intent.id, broadcastIntents }),
    ).resolves.toMatchObject({ ok: true, changed: true, prStatus: 'merged' })

    const got = getIntent(intent.id)
    expect(got?.status).toBe('done')
    expect(got?.prId).toBe('42')
    expect(got?.prUrl).toBe('https://example/pr/42')
    expect(got?.prStatus).toBe('merged')
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
  })

  it('can persist closed without unblocking as merged', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Done', shortEnTitle: 'done', content: '', priority: 'P1' },
    ])
    updateStatus(intent.id, 'done')
    setPrInfo(intent.id, '43', 'reviewing')
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: true, status: 'closed' })

    await syncIntentPrStatus({ workspacePath: proj, intentId: intent.id })

    expect(getIntent(intent.id)?.prStatus).toBe('closed')
  })

  it('does not write when the intent has no reviewing PR or the forge query fails', async () => {
    const [noPr, failed] = insertIntents(proj, [
      { title: 'No PR', shortEnTitle: 'no-pr', content: '', priority: 'P1' },
      { title: 'Failed', shortEnTitle: 'failed', content: '', priority: 'P1' },
    ])
    updateStatus(noPr.id, 'done')
    updateStatus(failed.id, 'done')
    setPrInfo(failed.id, '44', 'reviewing')
    vi.mocked(getForgePrStatus).mockResolvedValue({ ok: false, error: 'not found' })

    await expect(
      syncIntentPrStatus({ workspacePath: proj, intentId: noPr.id }),
    ).resolves.toMatchObject({ ok: false, changed: false })
    await expect(
      syncIntentPrStatus({ workspacePath: proj, intentId: failed.id }),
    ).resolves.toMatchObject({ ok: false, changed: false, error: 'not found' })

    expect(getIntent(noPr.id)?.prStatus).toBeNull()
    expect(getIntent(failed.id)?.prStatus).toBe('reviewing')
  })
})

describe('depsWithUnconfirmedPr', () => {
  it('selects done dependencies with PRs whose merge is not confirmed', () => {
    const [merged, reviewing, noPr] = insertIntents(proj, [
      { title: 'Merged', shortEnTitle: 'merged', content: '', priority: 'P1' },
      { title: 'Reviewing', shortEnTitle: 'reviewing', content: '', priority: 'P1' },
      { title: 'No PR', shortEnTitle: 'no-pr', content: '', priority: 'P1' },
    ])
    updateStatus(merged.id, 'done')
    updateStatus(reviewing.id, 'done')
    updateStatus(noPr.id, 'done')
    setPrInfo(merged.id, '1', 'merged')
    setPrInfo(reviewing.id, '2', 'reviewing')

    expect(
      depsWithUnconfirmedPr(
        [merged.id, reviewing.id, noPr.id],
        [getIntent(merged.id)!, getIntent(reviewing.id)!, getIntent(noPr.id)!],
      ).map((intent) => intent.id),
    ).toEqual([reviewing.id])
  })
})
