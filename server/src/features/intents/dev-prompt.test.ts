/**
 * Dev-launch prompt construction + the SDD forced gate.
 *
 * `buildDevPrompt` splits a dev session's first turn into three delivery channels
 * (hide-session-system-instructions): `systemInstruction` (the SDD work contract),
 * `userTurnPrefix` (a slash-command dev skill), and `visible` (the client echo). An
 * internal instruction must NEVER leak into `visible`; the visible body stays
 * byte-for-byte the historic shape. The handler test covers the server-side gate AND
 * pins the launch wiring: `start_development` echoes only the visible body while the
 * SDD instruct / devSkill ride the non-visible inject channels.
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

describe('buildDevPrompt — channel split (hide-session-system-instructions)', () => {
  const base = { title: 'Cache the endpoint', content: 'Add an LRU cache.', dependsOn: [] }

  it('SDD off, no devSkill: visible is the historic bare shape; no internal channels', () => {
    const p = buildDevPrompt({ ...base, devSkill: '', sddEnabled: false, specPath: null })
    expect(p.visible).toBe('Cache the endpoint\n\nAdd an LRU cache.')
    expect(p.systemInstruction).toBe('')
    expect(p.userTurnPrefix).toBe('')
  })

  it('SDD off, no devSkill, with deps: visible appends the 依赖需求 note only (regression)', () => {
    const p = buildDevPrompt({
      ...base,
      dependsOn: ['a', 'b'],
      devSkill: '',
      sddEnabled: false,
      specPath: null,
    })
    expect(p.visible).toBe('Cache the endpoint\n\nAdd an LRU cache.\n\n依赖需求:a, b')
    expect(p.systemInstruction).toBe('')
    expect(p.userTurnPrefix).toBe('')
  })

  it('devSkill configured: slash command rides userTurnPrefix, NOT the visible echo', () => {
    const p = buildDevPrompt({
      ...base,
      devSkill: '/dev',
      sddEnabled: true,
      specPath: '.specs/s.md',
    })
    // The slash command is delivered out-of-band; it must never appear in the echo.
    expect(p.userTurnPrefix).toBe('/dev ')
    expect(p.visible).not.toContain('/dev')
    // devSkill wins ⇒ the SDD instruct is not stacked on the system channel either.
    expect(p.systemInstruction).toBe('')
    expect(p.visible).not.toContain(SDD_WORK_SESSION_INSTRUCT)
    // SDD on ⇒ the spec-path note is still part of the VISIBLE body even when devSkill wins.
    expect(p.visible.startsWith('Cache the endpoint\n\n')).toBe(true)
    expect(p.visible.endsWith(`\n\n${buildDevSpecNote('.specs/s.md')}`)).toBe(true)
  })

  it('no devSkill, SDD on: the SDD instruct rides systemInstruction, NOT the visible echo', () => {
    const specPath = '.specs/2026/06/18/2026-06-18-001-cache/spec.md'
    const p = buildDevPrompt({ ...base, devSkill: '', sddEnabled: true, specPath })
    // The work contract is the system channel; the echo must not carry it.
    expect(p.systemInstruction).toBe(SDD_WORK_SESSION_INSTRUCT)
    expect(p.visible).not.toContain(SDD_WORK_SESSION_INSTRUCT)
    expect(p.visible).not.toContain('Hard constraints')
    expect(p.userTurnPrefix).toBe('')
    // The intent body + spec-path note are visible business context.
    expect(p.visible).toContain('Cache the endpoint\n\nAdd an LRU cache.')
    expect(p.visible).toContain(specPath)
    expect(p.visible.endsWith(buildDevSpecNote(specPath))).toBe(true)
  })

  it('SDD on but specPath null: instruct on system channel, visible has no spec-path note', () => {
    const p = buildDevPrompt({ ...base, devSkill: '', sddEnabled: true, specPath: null })
    expect(p.systemInstruction).toBe(SDD_WORK_SESSION_INSTRUCT)
    expect(p.visible).toBe('Cache the endpoint\n\nAdd an LRU cache.')
  })
})

describe('start_development SDD forced gate', () => {
  let dir: string
  let workspaceId: string
  let proj: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-dev-gate-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    process.env.C3_DIR = dir
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
    delete process.env.C3_DIR
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

  it('SDD on + spec approved ⇒ launches with the SDD instruct on the inject channel, not the echo', async () => {
    const [r] = insertIntents(proj, [
      { title: 'Approved', shortEnTitle: 'appr', content: 'Body text.', priority: 'P1' },
    ])
    setSpecPath(r.id, '.specs/2026/06/18/2026-06-18-001-appr/spec.md')
    setSpecApproved(r.id, true, 'alice')

    const launchRun = vi.fn().mockResolvedValue(undefined)
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await startDevelopment(ctx, conn, { type: 'start_development', workspaceId, intentId: r.id })

    // No error on the success path (the launch emits only `dev_launch_progress`).
    expect(sent.filter((m) => m.type === 'error')).toEqual([])
    expect(launchRun).toHaveBeenCalledTimes(1)
    // Args: (runtime, visiblePrompt, images, inject).
    const [, visiblePrompt, , inject] = launchRun.mock.calls[0]
    // The visible echo carries the intent body but NEVER the internal SDD work contract.
    expect(visiblePrompt).toContain('Approved\n\nBody text.')
    expect(visiblePrompt).not.toContain(SDD_WORK_SESSION_INSTRUCT)
    expect(visiblePrompt).not.toContain('Hard constraints')
    // The internal instruction rides the non-visible system-instruction channel.
    expect(inject?.systemInstruction).toBe(SDD_WORK_SESSION_INSTRUCT)
    expect(inject?.userTurnPrefix).toBe('')
  })
})
