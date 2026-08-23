/**
 * Business-logic tests for the shared `save_intents` handlers, driven DIRECTLY
 * (no SDK MCP wrapper). Two contracts:
 *  - `runSaveConfirmed` is the POST-confirmation persist: it upserts the batch,
 *    resolves intra-batch dependsOnIndexes, rejects (isError, atomic) on a cycle /
 *    an in_progress-locked or cross-project id / a store-down db, stays bound to
 *    the closure project, and fires `onSaved` so the caller can broadcast.
 *  - the single-intent comm back-link normalization `runCommSave` applies: it
 *    overwrites a single intent's `intentSessionId` with the bound run id and
 *    never back-links a multi-item batch.
 * Plus the zod input-shape validation for `saveSchema` / `saveIntentDirectlySchema`.
 *
 * The comm handler's batch constraint / live-run-id semantics live in
 * save-comm.test.ts; this file only covers the persist handler + the back-link
 * normalization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces
// are unregistered, so resolve/pathToName would otherwise return null.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
}))
import { z } from 'zod'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  intentContentGuidance,
  runSaveConfirmed,
  saveDesc,
  saveIntentDirectlyDesc,
  saveIntentDirectlySchema,
  saveSchema,
} from './tool-defs.js'
import { runCommSave, type CommSaveBinding } from './save-comm.js'
import {
  getIntent,
  insertIntents,
  listIntents,
  resetStoreForTests,
  setAutomate,
  updateStatus,
} from './store.js'

const proj = '/abs/save-handlers-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-save-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('runSaveConfirmed — post-confirmation persist', () => {
  it('persists a batch as todo, calls onSaved, returns a success result', () => {
    // Rows land as `todo`, scoped to the project; onSaved fires so the caller can broadcast.
    const onSaved = vi.fn()
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          { title: 'Login', shortEnTitle: 'auto', content: 'auth flow', priority: 'P0' },
          {
            title: 'Logout',
            shortEnTitle: 'auto',
            content: 'end session',
            priority: 'P1',
            dependsOn: ['x'],
          },
        ],
      },
      onSaved,
    )

    expect(res.isError).toBeFalsy()
    expect(res.content[0].type).toBe('text')
    expect(res.content[0].text).toContain('已保存 2 条意图')
    expect(res.content[0].text).toContain('Login')

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith(proj)

    const saved = listIntents(proj)
    expect(saved.map((r) => r.title).sort()).toEqual(['Login', 'Logout'])
    expect(saved.every((r) => r.status === 'todo')).toBe(true)
    const logout = saved.find((r) => r.title === 'Logout')!
    expect(logout.dependsOn).toEqual(['x'])
  })

  it('creates an explicitly automated todo and keeps omitted defaults compatible', () => {
    const explicit = runSaveConfirmed(
      proj,
      {
        intents: [
          {
            title: 'Automated',
            shortEnTitle: 'automated',
            content: '',
            priority: 'P0',
            status: 'todo',
            automate: true,
          },
          { title: 'Default', shortEnTitle: 'default', content: '', priority: 'P1' },
        ],
      },
      () => {},
    )

    expect(explicit.isError).toBeFalsy()
    expect(getIntent(listIntents(proj).find((r) => r.title === 'Automated')!.id)).toMatchObject({
      status: 'todo',
      automate: true,
    })
    expect(getIntent(listIntents(proj).find((r) => r.title === 'Default')!.id)).toMatchObject({
      status: 'todo',
      automate: false,
    })
  })

  it('atomically promotes a draft to todo and enables automation on the same id', () => {
    const [draft] = insertIntents(
      proj,
      [{ title: 'Draft', shortEnTitle: 'draft', content: 'before', priority: 'P1' }],
      'draft',
    )

    const result = runSaveConfirmed(
      proj,
      {
        intents: [
          {
            id: draft.id,
            title: 'Activated',
            shortEnTitle: 'activated',
            content: 'after',
            priority: 'P0',
            status: 'todo',
            automate: true,
          },
        ],
      },
      () => {},
    )

    expect(result.isError).toBeFalsy()
    expect(listIntents(proj)).toHaveLength(1)
    expect(getIntent(draft.id)).toMatchObject({
      title: 'Activated',
      content: 'after',
      status: 'todo',
      automate: true,
    })
  })

  it('preserves automate when omitted and permits todo/cancelled activation semantics', () => {
    const [todo, cancelled] = insertIntents(proj, [
      { title: 'Todo', shortEnTitle: 'todo', content: '', priority: 'P1' },
      { title: 'Cancelled', shortEnTitle: 'cancelled', content: '', priority: 'P1' },
    ])
    setAutomate(todo.id, true)
    updateStatus(cancelled.id, 'cancelled')

    const result = runSaveConfirmed(
      proj,
      {
        intents: [
          {
            id: todo.id,
            title: 'Todo',
            shortEnTitle: 'todo',
            content: '',
            priority: 'P1',
            status: 'todo',
          },
          {
            id: cancelled.id,
            title: 'Cancelled again',
            shortEnTitle: 'cancelled',
            content: '',
            priority: 'P1',
            automate: true,
          },
        ],
      },
      () => {},
    )

    expect(result.isError).toBeFalsy()
    expect(getIntent(todo.id)).toMatchObject({ status: 'todo', automate: true })
    expect(getIntent(cancelled.id)).toMatchObject({ status: 'todo', automate: true })
  })

  it('rejects automate=true on a draft and leaves the whole mixed batch untouched', () => {
    const [draft] = insertIntents(
      proj,
      [
        {
          title: 'Original',
          shortEnTitle: 'original',
          content: 'before',
          priority: 'P1',
          dependsOn: ['existing-dependency'],
        },
      ],
      'draft',
    )
    const onSaved = vi.fn()

    const result = runSaveConfirmed(
      proj,
      {
        intents: [
          {
            id: draft.id,
            title: 'Dirty rewrite',
            shortEnTitle: 'dirty',
            content: 'after',
            priority: 'P0',
            automate: true,
            dependsOn: ['replacement-dependency'],
          },
          { title: 'Must not exist', shortEnTitle: 'no-write', content: '', priority: 'P2' },
        ],
      },
      onSaved,
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('automate=true')
    expect(onSaved).not.toHaveBeenCalled()
    expect(listIntents(proj)).toHaveLength(1)
    expect(getIntent(draft.id)).toMatchObject({
      title: 'Original',
      content: 'before',
      priority: 'P1',
      status: 'draft',
      automate: false,
      dependsOn: ['existing-dependency'],
    })
  })

  it('rejects an explicit todo transition from a non-whitelisted modifiable status', () => {
    const [blocked] = insertIntents(proj, [
      { title: 'Blocked', shortEnTitle: 'blocked', content: '', priority: 'P1' },
    ])
    updateStatus(blocked.id, 'blocked')

    const result = runSaveConfirmed(
      proj,
      {
        intents: [
          {
            id: blocked.id,
            title: 'Blocked',
            shortEnTitle: 'blocked',
            content: '',
            priority: 'P1',
            status: 'todo',
          },
        ],
      },
      () => {},
    )

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('不允许从 blocked 转为 todo')
    expect(getIntent(blocked.id)?.status).toBe('blocked')
  })

  it('resolves intra-batch dependsOnIndexes to the sibling real id', () => {
    // An item can reference a sibling in the same batch by 0-based index; the handler
    // (via insertIntents) resolves it to that sibling's minted id.
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          { title: 'Schema', shortEnTitle: 'auto', content: '', priority: 'P0' },
          {
            title: 'Migration',
            shortEnTitle: 'auto',
            content: '',
            priority: 'P0',
            dependsOnIndexes: [0],
          },
        ],
      },
      () => {},
    )
    expect(res.isError).toBeFalsy()
    const saved = listIntents(proj)
    const schema = saved.find((r) => r.title === 'Schema')!
    const migration = saved.find((r) => r.title === 'Migration')!
    expect(migration.dependsOn).toEqual([schema.id])
  })

  it('returns isError without persisting when an intra-batch reference is invalid (cycle)', () => {
    // A cyclic / out-of-range index makes insertIntents throw; the handler catches it
    // and reports 保存失败 so nothing was written (atomic reject).
    const onSaved = vi.fn()
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          { title: 'A', shortEnTitle: 'auto', content: '', priority: 'P0', dependsOnIndexes: [1] },
          { title: 'B', shortEnTitle: 'auto', content: '', priority: 'P0', dependsOnIndexes: [0] },
        ],
      },
      onSaved,
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(onSaved).not.toHaveBeenCalled()
    expect(listIntents(proj)).toEqual([])
  })

  it('upserts: a batch item with an id updates the original in place, no new row', () => {
    // refine 定稿 carries the original id → the entry is updated, not duplicated.
    const onSaved = vi.fn()
    const [r] = insertIntents(proj, [
      { title: 'old', shortEnTitle: 'auto', content: 'before', priority: 'P2' },
    ])
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          { id: r.id, title: 'new', shortEnTitle: 'auto', content: 'after', priority: 'P0' },
        ],
      },
      onSaved,
    )
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('更新 1')
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(listIntents(proj)).toHaveLength(1) // updated in place, no duplicate
    expect(getIntent(r.id)!.title).toBe('new')
  })

  it('upserts a cancelled intent and reactivates it to todo', () => {
    // cancelled + id → updated and status flips back to todo.
    const [r] = insertIntents(proj, [
      { title: 'c', shortEnTitle: 'auto', content: 'x', priority: 'P0' },
    ])
    updateStatus(r.id, 'cancelled')
    const res = runSaveConfirmed(
      proj,
      { intents: [{ id: r.id, title: 'c2', shortEnTitle: 'auto', content: 'y', priority: 'P0' }] },
      () => {},
    )
    expect(res.isError).toBeFalsy()
    const got = getIntent(r.id)!
    expect(got.status).toBe('todo')
    expect(got.title).toBe('c2')
  })

  it('returns isError without persisting when a target is in_progress (locked)', () => {
    // An immutable target rejects the whole batch (atomic).
    const onSaved = vi.fn()
    const [r] = insertIntents(proj, [
      { title: 'locked', shortEnTitle: 'auto', content: 'orig', priority: 'P0' },
    ])
    updateStatus(r.id, 'in_progress')
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          { id: r.id, title: 'hacked', shortEnTitle: 'auto', content: 'no', priority: 'P3' },
          { title: 'sibling', shortEnTitle: 'auto', content: '', priority: 'P0' },
        ],
      },
      onSaved,
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(onSaved).not.toHaveBeenCalled()
    expect(getIntent(r.id)!.title).toBe('locked')
    expect(listIntents(proj)).toHaveLength(1) // sibling not inserted (atomic)
  })

  it('returns isError without persisting for an unknown / cross-project id', () => {
    // A foreign or non-existent id rejects the whole batch.
    const onSaved = vi.fn()
    const res = runSaveConfirmed(
      proj,
      { intents: [{ id: 'ghost', title: 'x', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      onSaved,
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(onSaved).not.toHaveBeenCalled()
    expect(listIntents(proj)).toEqual([])
  })

  it('handles a mixed update+insert batch in one transaction', () => {
    // One item updates (id) while another inserts (no id), atomically.
    const [r] = insertIntents(proj, [
      { title: 'base', shortEnTitle: 'auto', content: '', priority: 'P0' },
    ])
    const res = runSaveConfirmed(
      proj,
      {
        intents: [
          { id: r.id, title: 'base2', shortEnTitle: 'auto', content: '', priority: 'P0' },
          {
            title: 'fresh',
            shortEnTitle: 'auto',
            content: '',
            priority: 'P1',
            dependsOnIndexes: [0],
          },
        ],
      },
      () => {},
    )
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('新建 1、更新 1')
    expect(listIntents(proj)).toHaveLength(2)
    const fresh = listIntents(proj).find((x) => x.title === 'fresh')!
    expect(fresh.dependsOn).toEqual([r.id])
  })

  it('stays bound to the given project path (no cross-project save)', () => {
    // workspacePath is supplied by the closure so the agent can't redirect the save.
    runSaveConfirmed(
      '/abs/proj-a',
      { intents: [{ title: 'A', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      () => {},
    )
    runSaveConfirmed(
      '/abs/proj-b',
      { intents: [{ title: 'B', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      () => {},
    )
    expect(listIntents('/abs/proj-a').map((r) => r.title)).toEqual(['A'])
    expect(listIntents('/abs/proj-b').map((r) => r.title)).toEqual(['B'])
  })

  it('returns isError without persisting when the store is unavailable', () => {
    // db-down ⇒ the handler tells the caller it was not saved (isError).
    resetDbForTests()
    resetStoreForTests()
    // Point at a path under a non-directory so open/mkdir fails ⇒ db unavailable.
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    const onSaved = vi.fn()
    const res = runSaveConfirmed(
      proj,
      { intents: [{ title: 'X', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      onSaved,
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('不可用')
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('save_intents single-intent session back-link (comm-handler normalization)', () => {
  const deps = { broadcastIntents: () => {} }
  const binding: CommSaveBinding = { workspacePath: proj, getRunId: () => 'run-1' }

  it('normalizes a single intent intentSessionId to the bound run id', () => {
    // The model echoes the injected (pending) session id; the handler overwrites it
    // with binding.getRunId() (here 'run-1') so the persisted value matches the
    // bound session.
    const res = runCommSave(deps, binding, {
      intents: [
        {
          title: 'Solo',
          shortEnTitle: 'solo',
          content: '',
          priority: 'P0',
          intentSessionId: 'pending:whatever',
        },
      ],
    })
    expect(res.isError).toBeFalsy()
    const [saved] = listIntents(proj)
    expect(getIntent(saved.id)?.intentSessionId).toBe('run-1')
  })

  it('does NOT back-link any row when more than one intent is saved (batch ignored)', () => {
    const res = runCommSave(deps, binding, {
      intents: [
        {
          title: 'A',
          shortEnTitle: 'a',
          content: '',
          priority: 'P0',
          intentSessionId: 'pending:x',
        },
        {
          title: 'B',
          shortEnTitle: 'b',
          content: '',
          priority: 'P1',
          intentSessionId: 'pending:y',
        },
      ],
    })
    expect(res.isError).toBeFalsy()
    for (const r of listIntents(proj)) expect(getIntent(r.id)?.intentSessionId).toBeNull()
  })

  it('leaves intent_session_id null when a single intent omits the field', () => {
    runCommSave(deps, binding, {
      intents: [{ title: 'Solo', shortEnTitle: 'solo', content: '', priority: 'P0' }],
    })
    const [saved] = listIntents(proj)
    expect(getIntent(saved.id)?.intentSessionId).toBeNull()
  })
})

describe('save_intents input validation', () => {
  const schema = z.object(saveSchema)

  it('rejects a batch when an item is missing shortEnTitle', () => {
    const parsed = schema.safeParse({ intents: [{ title: 'A', content: 'c', priority: 'P0' }] })
    expect(parsed.success).toBe(false)
  })

  it('accepts a batch when shortEnTitle is present', () => {
    const parsed = schema.safeParse({
      intents: [{ title: 'A', shortEnTitle: 'a-slug', content: 'c', priority: 'P0' }],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts optional todo/automate fields and rejects non-whitelisted status targets', () => {
    expect(
      schema.safeParse({
        intents: [
          {
            title: 'A',
            shortEnTitle: 'a',
            content: '',
            priority: 'P0',
            status: 'todo',
            automate: true,
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        intents: [{ title: 'A', shortEnTitle: 'a', content: '', priority: 'P0', status: 'draft' }],
      }).success,
    ).toBe(false)
  })

  it('keeps five-dimension content guidance soft at tool and content-field level', () => {
    for (const description of [saveDesc, saveIntentDirectlyDesc, intentContentGuidance]) {
      for (const dimension of ['Why', 'What', 'Trade-offs / Non-goals', 'When', 'Acceptance']) {
        expect(description).toContain(dimension)
      }
    }
    expect(saveSchema.intents.element.shape.content.description).toBe(intentContentGuidance)
    expect(saveIntentDirectlySchema.intents.element.shape.content.description).toBe(
      intentContentGuidance,
    )
    expect(
      schema.safeParse({
        intents: [{ title: 'A', shortEnTitle: 'a', content: '', priority: 'P0' }],
      }).success,
    ).toBe(true)
  })
})

describe('intentSessionId field exposure / isolation', () => {
  it('save_intents schema accepts an optional intentSessionId', () => {
    const schema = z.object(saveSchema)
    const parsed = schema.safeParse({
      intents: [
        { title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P0', intentSessionId: 'sess-1' },
      ],
    })
    expect(parsed.success).toBe(true)
    // It is optional: a batch without it still validates.
    expect(
      schema.safeParse({
        intents: [{ title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P0' }],
      }).success,
    ).toBe(true)
  })

  it('save_intent_directly schema STRIPS intentSessionId (no comm-session semantics)', () => {
    // z.object strips unknown keys by default, so a supplied intentSessionId must not
    // survive parsing — the automation path can never carry a back-link.
    const schema = z.object(saveIntentDirectlySchema)
    const parsed = schema.safeParse({
      intents: [
        { title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P0', intentSessionId: 'sess-1' },
      ],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.intents[0]).not.toHaveProperty('intentSessionId')
  })

  it('save_intent_directly schema strips status/automate and remains create-only', () => {
    const schema = z.object(saveIntentDirectlySchema)
    const parsed = schema.parse({
      intents: [
        {
          id: 'existing',
          title: 'A',
          shortEnTitle: 'a',
          content: '',
          priority: 'P0',
          status: 'todo',
          automate: true,
        },
      ],
    })
    expect(parsed.intents[0]).not.toHaveProperty('id')
    expect(parsed.intents[0]).not.toHaveProperty('status')
    expect(parsed.intents[0]).not.toHaveProperty('automate')
  })
})
