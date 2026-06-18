/**
 * Dev-launch prompt construction + the SDD forced gate.
 *
 * `buildDevPrompt` has three branches: devSkill prefix, SDD work-session
 * instruct prefix (no devSkill), and the historic bare shape (SDD off). The
 * SDD-off branch must stay byte-for-byte identical to the pre-SDD prompt
 * (regression). The handler test covers the server-side gate: with SDD on and
 * the spec not yet approved, `start_development` is rejected and no run launches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { loadWorkspaceSetting, saveWorkspaceSetting } from '../../kernel/config/index.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecApproved,
  setSpecPath,
} from './store.js'
import { buildDevPrompt, buildDevSpecNote, SDD_WORK_SESSION_INSTRUCT } from './dev-prompt.js'
import { startDevelopment } from './index.js'

describe('buildDevPrompt', () => {
  const base = { title: 'Cache the endpoint', content: 'Add an LRU cache.', dependsOn: [] }

  it('SDD off, no devSkill: byte-for-byte the historic bare shape (regression)', () => {
    const p = buildDevPrompt({ ...base, devSkill: '', sddEnabled: false, specPath: null })
    expect(p).toBe('Cache the endpoint\n\nAdd an LRU cache.')
  })

  it('SDD off, no devSkill, with deps: appends the 依赖需求 note only (regression)', () => {
    const p = buildDevPrompt({
      ...base,
      dependsOn: ['a', 'b'],
      devSkill: '',
      sddEnabled: false,
      specPath: null,
    })
    expect(p).toBe('Cache the endpoint\n\nAdd an LRU cache.\n\n依赖需求:a, b')
  })

  it('devSkill configured: skill prefix, no SDD instruct stacked', () => {
    const p = buildDevPrompt({
      ...base,
      devSkill: '/dev',
      sddEnabled: true,
      specPath: '.specs/s.md',
    })
    expect(p.startsWith('/dev Cache the endpoint\n\n')).toBe(true)
    expect(p).not.toContain(SDD_WORK_SESSION_INSTRUCT)
    // SDD on ⇒ the spec-path note is still appended even when devSkill wins.
    expect(p.endsWith(`\n\n${buildDevSpecNote('.specs/s.md')}`)).toBe(true)
  })

  it('no devSkill, SDD on: instruct prefix + spec-path note', () => {
    const p = buildDevPrompt({
      ...base,
      devSkill: '',
      sddEnabled: true,
      specPath: '.specs/2026/06/18/2026-06-18-001-cache/spec.md',
    })
    expect(p.startsWith(`${SDD_WORK_SESSION_INSTRUCT}\n\n`)).toBe(true)
    expect(p).toContain('Cache the endpoint\n\nAdd an LRU cache.')
    expect(p).toContain('.specs/2026/06/18/2026-06-18-001-cache/spec.md')
    expect(p.endsWith(buildDevSpecNote('.specs/2026/06/18/2026-06-18-001-cache/spec.md'))).toBe(
      true,
    )
  })

  it('SDD on but specPath null: instruct prefix, no spec-path note', () => {
    const p = buildDevPrompt({ ...base, devSkill: '', sddEnabled: true, specPath: null })
    expect(p.startsWith(`${SDD_WORK_SESSION_INSTRUCT}\n\n`)).toBe(true)
    expect(p.endsWith('Add an LRU cache.')).toBe(true)
  })
})

describe('start_development SDD forced gate', () => {
  let dir: string
  let workspaceId: string
  let proj: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-dev-gate-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.C3_DB_PATH = join(dir, 'c3.db')
    resetDbForTests()
    resetStoreForTests()
    resetStateCacheForTests()
    addWorkspace(dir, 1)
    workspaceId = pathToId(dir)!
    proj = resolveWorkspaceRoot(workspaceId)!
    saveWorkspaceSetting(proj, { ...loadWorkspaceSetting(proj), sddEnabled: true })
  })

  afterEach(() => {
    resetDbForTests()
    resetStateCacheForTests()
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.C3_DB_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
    const sent: ServerToClient[] = []
    const conn = {
      send: (m: ServerToClient) => sent.push(m),
      subject: 'alice',
      authed: true,
      authToken: null,
      viewing: null,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
    } as unknown as Conn
    return { conn, sent }
  }

  it('SDD on + spec not approved ⇒ rejects with specNotApproved and never launches', async () => {
    const [r] = insertIntents(proj, [
      { title: 'No approval', shortEnTitle: 'noappr', content: '', priority: 'P1' },
    ])
    setSpecPath(r.id, '.specs/2026/06/18/2026-06-18-001-noappr/spec.md')

    const launchRun = vi.fn()
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await startDevelopment(ctx, conn, { type: 'start_development', workspaceId, intentId: r.id })

    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.specNotApproved' } }])
    expect(launchRun).not.toHaveBeenCalled()
    expect(getIntent(r.id)?.status).toBe('todo')
  })

  it('SDD on + spec approved ⇒ passes the gate (launches a run)', async () => {
    const [r] = insertIntents(proj, [
      { title: 'Approved', shortEnTitle: 'appr', content: '', priority: 'P1' },
    ])
    setSpecPath(r.id, '.specs/2026/06/18/2026-06-18-001-appr/spec.md')
    setSpecApproved(r.id, true, 'alice')

    const launchRun = vi.fn().mockResolvedValue(undefined)
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await startDevelopment(ctx, conn, { type: 'start_development', workspaceId, intentId: r.id })

    expect(sent).toEqual([])
    expect(launchRun).toHaveBeenCalledTimes(1)
  })
})
