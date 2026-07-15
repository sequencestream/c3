/**
 * Business-logic tests for the shared read-only ledger handlers `runFind` /
 * `runView`, driven DIRECTLY (no SDK MCP wrapper). These back both surfaces that
 * expose `find_intents` / `view_intent` (the interactive intent server and the
 * spec author), so the coverage is kept once here:
 *  - `runFind` returns a slim list (no `content` leak) filtered by keyword, a
 *    friendly empty result when nothing matches, is bound to the given project
 *    (no cross-project read), and reports `isError` text when the store is down;
 *  - `runView` returns full detail for an in-project id, and treats an unknown or
 *    a cross-project id as a friendly not-found (no cross-project leak).
 *
 * The tool-set boundaries (which surface advertises which tools) are covered by the
 * transport route tests via a real MCP client; this file only exercises the logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces
// are unregistered, so resolve/pathToId would otherwise return null. This makes
// `runView`'s cross-project guard resolve predictably.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { resetDbForTests } from '../../kernel/infra/db.js'
import { runFind, runView } from './tool-defs.js'
import { insertIntents, resetStoreForTests } from './store.js'

const proj = '/abs/read-tools-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-read-tools-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('runFind — read-only ledger search', () => {
  it('returns a slim list (id/title/module/priority/status/dependsOn) filtered by keyword', () => {
    insertIntents(proj, [
      {
        title: '登录鉴权',
        shortEnTitle: 'auto',
        content: 'oauth',
        priority: 'P0',
        module: '认证',
        dependsOn: ['ext'],
      },
      { title: '导出报表', shortEnTitle: 'auto', content: 'csv', priority: 'P2' },
    ])
    const res = runFind(proj, { keyword: '鉴权' })
    expect(res.isError).toBeFalsy()
    // the text carries a JSON array; parse the slim rows out of it
    const json = res.content[0].text.slice(res.content[0].text.indexOf('['))
    const rows = JSON.parse(json) as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: expect.any(String),
      title: '登录鉴权',
      module: '认证',
      priority: 'P0',
      status: 'todo',
      dependsOn: ['ext'],
    })
    // slim shape: no `content` field leaks into the list
    expect(rows[0]).not.toHaveProperty('content')
  })

  it('reports a friendly empty result when nothing matches', () => {
    insertIntents(proj, [{ title: 'A', shortEnTitle: 'auto', content: '', priority: 'P0' }])
    const res = runFind(proj, { keyword: 'zzz' })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未找到')
  })

  it('binds to the given project (no cross-project read)', () => {
    insertIntents('/abs/proj-a', [
      { title: 'AOnly', shortEnTitle: 'auto', content: 'shared', priority: 'P0' },
    ])
    insertIntents('/abs/proj-b', [
      { title: 'BOnly', shortEnTitle: 'auto', content: 'shared', priority: 'P0' },
    ])
    const res = runFind('/abs/proj-a', { keyword: 'shared' })
    expect(res.content[0].text).toContain('AOnly')
    expect(res.content[0].text).not.toContain('BOnly')
  })

  it('reports isError text (does not throw) when the store is unavailable', () => {
    resetDbForTests()
    resetStoreForTests()
    // Point at a path under a non-directory so open/mkdir fails ⇒ db unavailable.
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    const res = runFind(proj, {})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('不可用')
  })
})

describe('runView — read-only single-item detail', () => {
  it('returns one intent full detail by id (incl. content/dependsOn)', () => {
    const [r] = insertIntents(proj, [
      {
        title: 'Detail',
        shortEnTitle: 'auto',
        content: 'long body',
        priority: 'P1',
        dependsOn: ['ext'],
      },
    ])
    const res = runView(proj, { id: r.id })
    expect(res.isError).toBeFalsy()
    const detail = JSON.parse(res.content[0].text) as Record<string, unknown>
    expect(detail.id).toBe(r.id)
    expect(detail.content).toBe('long body')
    expect(detail.dependsOn).toEqual(['ext'])
  })

  it('gives a friendly (non-error) prompt for an unknown id', () => {
    const res = runView(proj, { id: 'does-not-exist' })
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未找到')
    expect(res.content[0].text).toContain('does-not-exist')
  })

  it('refuses an id from another project (treated as not found, no leak)', () => {
    const [other] = insertIntents('/abs/proj-b', [
      { title: 'Secret', shortEnTitle: 'auto', content: 's', priority: 'P0' },
    ])
    const res = runView('/abs/proj-a', { id: other.id })
    // exists in the ledger, but not in proj-a → not found (no cross-project leak)
    expect(res.content[0].text).toContain('未找到')
    expect(res.content[0].text).not.toContain('Secret')
  })
})
