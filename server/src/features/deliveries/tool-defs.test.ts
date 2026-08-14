/**
 * The two READ-ONLY delivery tool cores, driven directly (no MCP framing).
 * They back both surfaces that expose `find_deliveries` / `view_delivery` (the
 * automation c3 tool set and the external `/mcp/<api-key>` catalog), so the
 * coverage is kept once here: filtering, the workspace binding that refuses a
 * cross-project read, and the read-only projection's field set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Identity id↔path mapping: synthetic test workspaces are unregistered, so the
// in-project guard would otherwise never resolve.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))
import { resetDbForTests } from '../../kernel/infra/db.js'
import { runFindDeliveries, runViewDelivery } from './tool-defs.js'
import {
  createDelivery,
  resetStoreForTests,
  setDeliveryBranch,
  setDeliveryStatus,
  upsertDeliveryPr,
} from './store.js'

let dir: string
let proj: string
let other: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-delivery-tools-'))
  proj = dir
  other = join(dir, 'other-project')
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  resetStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function seed(workspacePath: string, title: string, description = ''): string {
  return createDelivery({
    workspacePath,
    title,
    description,
    startDate: null,
    endDate: null,
    baseBranch: 'main',
  }).delivery.id
}

/** The JSON payload a tool result carries (the cores always emit one text block). */
function payload(text: string): unknown {
  return JSON.parse(text.slice(text.indexOf('\n') + 1))
}

describe('runFindDeliveries', () => {
  it('returns the slim projection for every delivery of the project', () => {
    const id = seed(proj, 'Sprint 3', '三月交付')
    const res = runFindDeliveries(proj, {})
    expect(res.isError).toBeUndefined()
    expect(payload(res.content[0].text)).toEqual([
      {
        id,
        title: 'Sprint 3',
        status: 'planned',
        baseBranch: 'main',
        branchName: null,
        branchReady: false,
        integration: { merged: 0, total: 0 },
      },
    ])
  })

  it('filters by keyword across title and description, case-insensitively', () => {
    seed(proj, 'Sprint 3', '含 CACHE 相关改造')
    seed(proj, 'Cache rewrite')
    seed(proj, 'Unrelated')
    const titles = (args: { keyword?: string }): string[] =>
      (payload(runFindDeliveries(proj, args).content[0].text) as { title: string }[]).map(
        (d) => d.title,
      )
    expect(titles({ keyword: 'cache' }).sort()).toEqual(['Cache rewrite', 'Sprint 3'])
  })

  it('filters by status', () => {
    const done = seed(proj, 'Shipped')
    seed(proj, 'Fresh')
    setDeliveryStatus(done, 'cancelled')
    const res = runFindDeliveries(proj, { status: 'cancelled' })
    expect(payload(res.content[0].text)).toMatchObject([{ id: done, status: 'cancelled' }])
  })

  it('reads only THIS project — another workspace’s deliveries stay invisible', () => {
    seed(other, 'Other sprint')
    expect(runFindDeliveries(proj, {}).content[0].text).toBe('未找到匹配的交付。')
  })
})

describe('runViewDelivery', () => {
  it('returns the delivery plus its associated intents and latest delivery PR', () => {
    const id = seed(proj, 'Sprint 3', '三月交付')
    setDeliveryBranch(id, 'delivery/sprint-3', true)
    upsertDeliveryPr({
      deliveryId: id,
      forge: 'github',
      repo: 'o/r',
      number: '42',
      url: 'https://github.com/o/r/pull/42',
      headBranch: 'delivery/sprint-3',
      baseBranch: 'main',
      baseSha: 'b1',
      headSha: 'h1',
      status: 'reviewing',
    })

    const detail = JSON.parse(runViewDelivery(proj, { id }).content[0].text) as Record<
      string,
      unknown
    >
    expect(detail).toMatchObject({
      id,
      title: 'Sprint 3',
      description: '三月交付',
      status: 'planned',
      baseBranch: 'main',
      branchName: 'delivery/sprint-3',
      branchReady: true,
      integration: { merged: 0, total: 0 },
      associatedIntents: [],
      deliveryPr: { number: '42', status: 'reviewing', baseBranch: 'main' },
    })
  })

  it('treats an unknown id as a friendly not-found', () => {
    const res = runViewDelivery(proj, { id: 'nope' })
    expect(res.content[0].text).toContain('未找到')
    expect(res.isError).toBeUndefined()
  })

  it('refuses a cross-project id the same way — no leak of another workspace', () => {
    const foreign = seed(other, 'Other sprint')
    expect(runViewDelivery(proj, { id: foreign }).content[0].text).toContain('未找到')
  })
})
