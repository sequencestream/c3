/**
 * Business-logic tests for the shared `save_intents` handlers, driven DIRECTLY
 * (no SDK MCP wrapper). Two contracts:
 *  - `runSaveConfirmed` is the POST-confirmation persist: it upserts the batch,
 *    resolves intra-batch dependsOnIndexes, rejects (isError, atomic) on a cycle /
 *    an in_progress-locked or cross-project id / a store-down db, stays bound to
 *    the closure project, and fires `onSaved` so the caller can broadcast.
 *  - the single-intent comm back-link normalization the gate applies: driven
 *    through `gatedSave` with an auto-allow decision, it overwrites a single
 *    intent's `intentSessionId` with the bound run id and never back-links a
 *    multi-item batch.
 * Plus the zod input-shape validation for `saveSchema` / `saveIntentDirectlySchema`.
 *
 * The gate's allow/deny/ordering/live-run-id semantics live in save-gate.test.ts;
 * this file only covers the persist handler + the back-link normalization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces
// are unregistered, so resolve/pathToId would otherwise return null.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { z } from 'zod'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { runSaveConfirmed, saveIntentDirectlySchema, saveSchema } from './tool-defs.js'
import { gatedSave, type SaveGateBinding, type SaveGateDeps } from './save-gate.js'
import { getIntent, insertIntents, listIntents, resetStoreForTests, updateStatus } from './store.js'

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

describe('save_intents single-intent session back-link (gate normalization)', () => {
  /** An auto-allow gate so the persist runs; the gate applies the back-link normalization. */
  function autoAllowGate(): SaveGateDeps {
    return {
      emit: () => {},
      waitForDecision: async () => ({ decision: 'allow' }),
      broadcastIntents: () => {},
    }
  }
  const binding: SaveGateBinding = {
    workspacePath: proj,
    getRunId: () => 'run-1',
    signal: new AbortController().signal,
  }

  it('normalizes a single intent intentSessionId to the bound run id', async () => {
    // The model echoes the injected (pending) session id; the gate overwrites it with
    // binding.getRunId() (here 'run-1') so the persisted value matches the bound session.
    const res = await gatedSave(autoAllowGate(), binding, {
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

  it('does NOT back-link any row when more than one intent is saved (batch ignored)', async () => {
    const res = await gatedSave(autoAllowGate(), binding, {
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

  it('leaves intent_session_id null when a single intent omits the field', async () => {
    await gatedSave(autoAllowGate(), binding, {
      intents: [{ title: 'Solo', shortEnTitle: 'solo', content: '', priority: 'P0' }],
    })
    const [saved] = listIntents(proj)
    expect(getIntent(saved.id)?.intentSessionId).toBeNull()
  })
})

describe('save_intents input validation (shortEnTitle required)', () => {
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
})
