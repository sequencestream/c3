/**
 * Integration tests for the intent `module` field (新增"模块名称"字段).
 *
 * Covers the acceptance criteria from intent.md scenarios 1–5 and design.md
 * §6 that are NOT already owned by store.test.ts (which holds: insert stores
 * module + '' fallback, and the single-historic-row pre-v2 → v2 migration). Here
 * we add the gaps:
 *   - fresh-schema PRAGMA table_info shape (scenario 1),
 *   - multi-row + post-migration-insert migration extensions (scenario 2),
 *   - end-to-end module round-trip through the REAL save_intents handler
 *     incl. the omitted-module '' fallback (scenarios 3 & 4),
 *   - module carried by listIntents / getIntent / insertIntents
 *     return values (scenario 5),
 *   - degradation contract not regressed by the new column (constraint).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { createIntentMcpServer } from './save-tool.js'
import {
  getIntent,
  insertIntents,
  isStoreAvailable,
  listIntents,
  resetStoreForTests,
} from './store.js'

const proj = '/abs/module-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-module-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

// --- save_intents handler plumbing (mirrors save-tool.test.ts) -----------
interface CallToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult>

/** Reach into the SDK MCP server instance for the actual registered handler. */
function getSaveHandler(servers: Record<string, McpServerConfig>): Handler {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return c3.instance._registeredTools.save_intents.handler
}

describe('module field — fresh-schema create (scenario 1)', () => {
  it('a brand-new db gets a intents.module column declared NOT NULL DEFAULT ""', () => {
    // Scenario 1 / design §3.1: first store access on a fresh db runs SCHEMA, so
    // PRAGMA table_info(intents) must list `module` with notnull=1 and a
    // default of '' — no migration path involved, the column comes from CREATE TABLE.
    expect(isStoreAvailable()).toBe(true)
    // Touch the store so the schema is ensured.
    listIntents(proj)

    const raw = getDb()!
    const cols = raw.all<{ name: string; notnull: number; dflt_value: string | null }>(
      'PRAGMA table_info(intents)',
    )
    const moduleCol = cols.find((c) => c.name === 'module')
    expect(moduleCol).toBeDefined()
    expect(moduleCol!.notnull).toBe(1)
    // SQLite reports a string-literal default as the quoted token "''".
    expect(moduleCol!.dflt_value).toBe("''")
    // Fresh db is already at the current schema version.
    const version = raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(11)
  })
})

describe('module field — pre-v2 migration extensions (scenario 2)', () => {
  /** Build an old-schema (no `module`) intents table with N historic rows. */
  function seedLegacyDb(rows: { id: string; title: string }[]): void {
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE intents (
        id              TEXT PRIMARY KEY,
        project_path    TEXT NOT NULL,
        title           TEXT NOT NULL,
        content         TEXT NOT NULL,
        priority        TEXT NOT NULL,
        status          TEXT NOT NULL,
        last_dev_session_id TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      PRAGMA user_version=1;
    `)
    for (const r of rows) {
      raw.run(
        `INSERT INTO intents
           (id, project_path, title, content, priority, status, last_dev_session_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        r.id,
        proj,
        r.title,
        'body',
        'P1',
        'todo',
        null,
        1,
        1,
      )
    }
  }

  it('backfills module="" for MULTIPLE historic rows (none lost) and lands at current version', () => {
    // Scenario 2 extension: the existing test migrates a single row; ensure the
    // ALTER … ADD COLUMN DEFAULT '' applies to every legacy row, not just one.
    seedLegacyDb([
      { id: 'old-1', title: 'Legacy A' },
      { id: 'old-2', title: 'Legacy B' },
      { id: 'old-3', title: 'Legacy C' },
    ])

    // First store access triggers the schema-ensure / migration.
    resetStoreForTests()
    const list = listIntents(proj)
    expect(list.map((r) => r.title).sort()).toEqual(['Legacy A', 'Legacy B', 'Legacy C'])
    expect(list.every((r) => r.module === '')).toBe(true)

    const raw = getDb()!
    expect(raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(11)
  })

  it('a row inserted AFTER migration coexists with legacy rows and carries its module', () => {
    // Scenario 2 + 3 cross-check: after the column is added, a new insert with an
    // explicit module persists that value while the migrated legacy row keeps ''.
    seedLegacyDb([{ id: 'old-1', title: 'Legacy' }])

    // Trigger migration, then insert a fresh intent with a module.
    resetStoreForTests()
    const [fresh] = insertIntents(proj, [
      { title: 'New', content: '', priority: 'P0', module: '需求管理' },
    ])

    expect(getIntent('old-1')?.module).toBe('') // legacy backfilled
    expect(getIntent(fresh.id)?.module).toBe('需求管理') // new value kept

    // Both visible through the list, each with the right module.
    const byTitle = new Map(listIntents(proj).map((r) => [r.title, r.module]))
    expect(byTitle.get('Legacy')).toBe('')
    expect(byTitle.get('New')).toBe('需求管理')
  })
})

describe('module field — save_intents end-to-end (scenarios 3 & 4)', () => {
  it('round-trips a batch WITH module values through the real handler per row', async () => {
    // Scenario 3: the agent (post-confirmation) submits modules; each saved row's
    // module must equal what was given, readable via listIntents.
    const onSaved = vi.fn()
    const handler = getSaveHandler(createIntentMcpServer(proj, onSaved))
    const res = await handler(
      {
        intents: [
          { title: 'Login', content: 'auth flow', priority: 'P0', module: '认证' },
          { title: 'Switch session', content: 'sess', priority: 'P1', module: '会话' },
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()
    expect(onSaved).toHaveBeenCalledWith(proj)

    const byTitle = new Map(listIntents(proj).map((r) => [r.title, r.module]))
    expect(byTitle.get('Login')).toBe('认证')
    expect(byTitle.get('Switch session')).toBe('会话')
  })

  it('persists "" for items that OMIT module, while siblings keep theirs (mixed batch)', async () => {
    // Scenario 4: a mixed batch where one item omits module must not error; the
    // omitted one falls back to '' end-to-end through the registered handler.
    const handler = getSaveHandler(createIntentMcpServer(proj, () => {}))
    const res = await handler(
      {
        intents: [
          { title: 'WithMod', content: '', priority: 'P0', module: '权限' },
          { title: 'NoMod', content: '', priority: 'P1' }, // module omitted
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()

    const byTitle = new Map(listIntents(proj).map((r) => [r.title, r.module]))
    expect(byTitle.get('WithMod')).toBe('权限')
    expect(byTitle.get('NoMod')).toBe('') // '' fallback, no throw
  })
})

describe('module field — read-back carries module (scenario 5)', () => {
  it('insertIntents / listIntents / getIntent all return module per row', () => {
    // Scenario 5: hydrate must map module onto every read surface. Use two rows
    // with distinct modules so we also catch any per-row mix-up.
    const saved = insertIntents(proj, [
      { title: 'A', content: '', priority: 'P0', module: 'mod-a' },
      { title: 'B', content: '', priority: 'P1', module: 'mod-b' },
    ])
    // insertIntents return value carries module.
    expect(new Map(saved.map((r) => [r.title, r.module]))).toEqual(
      new Map([
        ['A', 'mod-a'],
        ['B', 'mod-b'],
      ]),
    )
    // listIntents carries module.
    const listed = new Map(listIntents(proj).map((r) => [r.title, r.module]))
    expect(listed.get('A')).toBe('mod-a')
    expect(listed.get('B')).toBe('mod-b')
    // getIntent carries module.
    const a = saved.find((r) => r.title === 'A')!
    expect(getIntent(a.id)?.module).toBe('mod-a')
  })
})

describe('module field — degradation contract not regressed (constraint)', () => {
  it('with the db unavailable, reads stay empty and writes still throw', () => {
    // Constraint: adding the module column must not change the db-down contract —
    // reads return empty, writes throw (the save-tool turns that into isError).
    resetDbForTests()
    resetStoreForTests()
    process.env.C3_DB_PATH = '/dev/null/broken/c3.db'

    expect(isStoreAvailable()).toBe(false)
    expect(listIntents(proj)).toEqual([])
    expect(getIntent('any')).toBeNull()
    expect(() =>
      insertIntents(proj, [{ title: 'X', content: '', priority: 'P0', module: 'm' }]),
    ).toThrow()
  })
})
