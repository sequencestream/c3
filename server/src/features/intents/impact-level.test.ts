/**
 * Intent impact level (L1–L5) — column, read narrowing, write paths, the
 * `save_intents` input contract and the `set_intent_impact_level` handler.
 *
 *  - schema: the column exists on a fresh db and is added to an upgraded one;
 *    rows that predate it read as ungraded (no backfill).
 *  - read model: an unknown / out-of-range persisted value narrows to `null`
 *    rather than surfacing verbatim or landing on a middle grade.
 *  - upsert: an ABSENT field keeps the stored grade, an EXPLICIT `null` clears
 *    it, a value pins it; changing only the grade never revokes spec approval.
 *  - save_intents: the enum is validated at the tool boundary.
 *  - handler: writes + broadcasts; `in_progress` / `done` are locked
 *    (`intent.impactLevelLocked`, nothing written, no broadcast).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
  workspaceNameFor,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  listIntents,
  resetStoreForTests,
  setSpecApproved,
  updateStatus,
  upsertIntents,
} from './store.js'
import { setIntentImpactLevel } from './index.js'
import { runCommSave } from './save-comm.js'
import { saveSchema } from './tool-defs.js'
import type { IntentToolResult } from './tool-defs.js'
import { resetStoreForTests as resetSessionMetadataStoreForTests } from '../sessions/session-metadata-store.js'

let dir: string
let prevC3Dir: string | undefined
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-intent-impact-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToName(dir)!)!
})

afterEach(() => {
  resetDbForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
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

function fakeCtx(): { ctx: KernelContext; broadcastIntents: ReturnType<typeof vi.fn> } {
  const broadcastIntents = vi.fn()
  return { ctx: { broadcastIntents } as unknown as KernelContext, broadcastIntents }
}

/** Drive the real save_intents handler through the same zod parse the MCP route does. */
function saveIntents(rawArgs: unknown): IntentToolResult {
  const args = z.object(saveSchema).parse(rawArgs)
  return runCommSave(
    { broadcastIntents: () => {} },
    { workspacePath: proj, getRunId: () => 'run-1' },
    args,
  )
}

describe('impact level — column + historic rows', () => {
  it('declares a nullable CHECK-constrained impact_level on a fresh db', () => {
    listIntents(proj)
    const raw = getDb()!
    const col = raw
      .all<{ name: string; notnull: number; dflt_value: string | null }>(
        'PRAGMA table_info(intents)',
      )
      .find((c) => c.name === 'impact_level')
    expect(col).toBeDefined()
    // Ungraded is a real reading, so the column must NOT be NOT NULL and must
    // not carry a default grade nobody chose.
    expect(col!.notnull).toBe(0)
    expect(col!.dflt_value).toBeNull()

    const [r] = insertIntents(proj, [
      { title: 'T', shortEnTitle: 't', content: 'x', priority: 'P1', impactLevel: 'L2' },
    ])
    expect(() => raw.run("UPDATE intents SET impact_level='L9' WHERE id=?", r.id)).toThrow()
  })

  it('adds the column to an upgraded db and reads its historic rows as ungraded', () => {
    // A pre-v23 ledger: same table without impact_level. The store's schema
    // ensure must add the column and leave every existing row ungraded — a
    // backfill would invent grades nobody ever made.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id              TEXT PRIMARY KEY,
        workspace_name  TEXT NOT NULL,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        priority        TEXT NOT NULL,
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      PRAGMA user_version=22;
    `)
    raw.run(
      'INSERT INTO intents (id, workspace_name, title, content, priority, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      'old-1',
      workspaceNameFor(proj),
      'Legacy',
      'body',
      'P1',
      'todo',
      1,
      1,
    )

    resetStoreForTests()
    const list = listIntents(proj)
    expect(list).toHaveLength(1)
    expect(list[0].impactLevel).toBeNull()
    expect(raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(24)
  })

  it('narrows an uninterpretable persisted value to ungraded, not to a middle grade', () => {
    // A value written by an older / foreign writer, i.e. a column that predates
    // the CHECK. The read model must refuse to interpret it rather than surface
    // it verbatim or round it to a middle grade.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id              TEXT PRIMARY KEY,
        workspace_name  TEXT NOT NULL,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        priority        TEXT NOT NULL,
        impact_level    TEXT,
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      PRAGMA user_version=22;
    `)
    raw.run(
      'INSERT INTO intents (id, workspace_name, title, content, priority, impact_level, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      'weird-1',
      workspaceNameFor(proj),
      'Legacy',
      'body',
      'P1',
      'L9',
      'todo',
      1,
      1,
    )

    resetStoreForTests()
    expect(getIntent('weird-1')?.impactLevel).toBeNull()
  })
})

describe('impact level — write paths', () => {
  it('insertIntents stores the grade, or leaves it ungraded when omitted', () => {
    const [graded, ungraded] = insertIntents(proj, [
      { title: 'A', shortEnTitle: 'a', content: '', priority: 'P1', impactLevel: 'L1' },
      { title: 'B', shortEnTitle: 'b', content: '', priority: 'P1' },
    ])
    expect(graded.impactLevel).toBe('L1')
    expect(ungraded.impactLevel).toBeNull()
  })

  it('upsert: absent keeps the stored grade, explicit null clears it, a value pins it', () => {
    const [r] = insertIntents(proj, [
      { title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P1', impactLevel: 'L2' },
    ])

    // Absent → a routine edit must not silently ungrade.
    upsertIntents(proj, [
      { id: r.id, title: 'A2', shortEnTitle: 'a', content: 'c', priority: 'P1' },
    ])
    expect(getIntent(r.id)?.impactLevel).toBe('L2')

    // Explicit value → pinned.
    upsertIntents(proj, [
      { id: r.id, title: 'A2', shortEnTitle: 'a', content: 'c', priority: 'P1', impactLevel: 'L4' },
    ])
    expect(getIntent(r.id)?.impactLevel).toBe('L4')

    // Explicit null → back to ungraded.
    upsertIntents(proj, [
      { id: r.id, title: 'A2', shortEnTitle: 'a', content: 'c', priority: 'P1', impactLevel: null },
    ])
    expect(getIntent(r.id)?.impactLevel).toBeNull()
  })

  it('a grade change alone does not revoke spec approval', () => {
    const [r] = insertIntents(proj, [
      { title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P1', impactLevel: 'L3' },
    ])
    setSpecApproved(r.id, true, 'alice')

    upsertIntents(proj, [
      { id: r.id, title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P1', impactLevel: 'L1' },
    ])

    const after = getIntent(r.id)!
    expect(after.impactLevel).toBe('L1')
    expect(after.specApproved).toBe(true)
    expect(after.specStatus).toBe('approved')
  })
})

describe('impact level — save_intents input contract', () => {
  it('persists a graded batch through the real handler', () => {
    const res = saveIntents({
      intents: [
        { title: 'Pay', shortEnTitle: 'pay', content: 'money', priority: 'P1', impactLevel: 'L1' },
        { title: 'Copy', shortEnTitle: 'copy', content: 'text', priority: 'P3', impactLevel: 'L5' },
      ],
    })
    expect(res.isError).toBeUndefined()
    const byTitle = new Map(listIntents(proj).map((r) => [r.title, r.impactLevel]))
    expect(byTitle.get('Pay')).toBe('L1')
    expect(byTitle.get('Copy')).toBe('L5')
  })

  it('rejects a grade outside L1–L5 at the tool boundary', () => {
    expect(() =>
      saveIntents({
        intents: [
          { title: 'X', shortEnTitle: 'x', content: '', priority: 'P1', impactLevel: 'L6' },
        ],
      }),
    ).toThrow()
    expect(listIntents(proj)).toHaveLength(0)
  })
})

describe('set_intent_impact_level — handler', () => {
  function newIntent(): string {
    const [r] = insertIntents(proj, [
      { title: 'T', shortEnTitle: 't', content: 'x', priority: 'P1' },
    ])
    return r.id
  }

  it('persists a grade and broadcasts', () => {
    const id = newIntent()
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()

    setIntentImpactLevel(ctx, conn, { type: 'set_intent_impact_level', intentId: id, level: 'L2' })

    expect(getIntent(id)?.impactLevel).toBe('L2')
    expect(broadcastIntents).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('clears the grade on an explicit null', () => {
    const id = newIntent()
    const { ctx } = fakeCtx()
    const { conn } = fakeConn()

    setIntentImpactLevel(ctx, conn, { type: 'set_intent_impact_level', intentId: id, level: 'L1' })
    setIntentImpactLevel(ctx, conn, { type: 'set_intent_impact_level', intentId: id, level: null })

    expect(getIntent(id)?.impactLevel).toBeNull()
  })

  it.each(['in_progress', 'done'] as const)(
    'refuses to write while %s, with nothing persisted and no broadcast',
    (status) => {
      const id = newIntent()
      const { ctx: setupCtx } = fakeCtx()
      const { conn: setupConn } = fakeConn()
      setIntentImpactLevel(setupCtx, setupConn, {
        type: 'set_intent_impact_level',
        intentId: id,
        level: 'L3',
      })
      updateStatus(id, status)

      const { ctx, broadcastIntents } = fakeCtx()
      const { conn, sent } = fakeConn()
      setIntentImpactLevel(ctx, conn, {
        type: 'set_intent_impact_level',
        intentId: id,
        level: 'L1',
      })

      expect(getIntent(id)?.impactLevel).toBe('L3')
      expect(broadcastIntents).not.toHaveBeenCalled()
      expect(sent).toEqual([{ type: 'error', error: { code: 'intent.impactLevelLocked' } }])
    },
  )

  it('reports an unknown intent without writing', () => {
    const { ctx, broadcastIntents } = fakeCtx()
    const { conn, sent } = fakeConn()
    setIntentImpactLevel(ctx, conn, {
      type: 'set_intent_impact_level',
      intentId: 'nope',
      level: 'L1',
    })
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
  })
})
