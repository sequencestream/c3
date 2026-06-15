/**
 * Integration tests for the discussion store over the shared c3.db adapter.
 *
 * Covers: schema/index creation, the migration paradigm (an old db with NO
 * discussion tables → created on first access; an old `discussions` table with
 * only the core columns → `ensureColumn` backfills goal/context/conclusion/
 * completed_at, idempotently), and full CRUD (create/get/list with status filter
 * + project scope + resolve()-normalization, status stamping, conclusion, message
 * append with monotonic seq + updated_at bump, ordered listMessages). Runs under
 * Node's `node:sqlite` branch via real temp files.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  appendMessage,
  createDiscussion,
  deleteAgentSession,
  deleteAllByDiscussion,
  getAgentSession,
  getDiscussion,
  isStoreAvailable,
  listAgentSessions,
  listDiscussions,
  listMessages,
  resetStoreForTests,
  setAgentSession,
  setAgenda,
  setConclusion,
  setDiscussionResearchResult,
  updateDiscussionStatus,
} from './store.js'

let dir: string
const proj = '/abs/project-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-disc-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('schema', () => {
  it('creates the tables and their indexes on first access', () => {
    expect(isStoreAvailable()).toBe(true)
    // First store call triggers schema-ensure.
    expect(listDiscussions(proj)).toEqual([])
    const raw = getDb()!
    const tables = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    expect(tables).toContain('discussions')
    expect(tables).toContain('discussion_messages')
    expect(tables).toContain('discussion_agent_sessions')
    const indexes = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index'")
      .map((r) => r.name)
    expect(indexes).toContain('idx_disc_workspace_status')
    expect(indexes).toContain('idx_disc_msg_discussion')
    const version = raw.get<{ user_version: number }>('PRAGMA user_version')
    expect(version?.user_version).toBe(4)
    // v3 added the participant selection column.
    const cols = raw.all<{ name: string }>('PRAGMA table_info(discussions)').map((r) => r.name)
    expect(cols).toContain('participant_agent_ids')
  })
})

describe('discussions CRUD', () => {
  it('creates a discussion with defaults and reads it back', () => {
    const d = createDiscussion({ workspacePath: proj, title: 'T', type: 'design' })
    expect(d.status).toBe('draft') // default
    expect(d.goal).toBe('') // default
    expect(d.context).toBe('')
    expect(d.researchResult).toBe('') // default — research not yet run
    expect(d.conclusion).toBeNull()
    expect(d.completedAt).toBeNull()
    expect(d.agenda).toEqual([]) // default empty agenda
    expect(d.agendaIndex).toBe(0)
    expect(d.participantAgentIds).toEqual([]) // default unset → orchestrator falls back to all
    expect(d.createdAt).toBe(d.updatedAt)
    const got = getDiscussion(d.id)
    expect(got?.title).toBe('T')
    expect(got?.type).toBe('design')
  })

  it('honors explicit goal/context/status on create', () => {
    const d = createDiscussion({
      workspacePath: proj,
      title: 'T',
      type: 'arch',
      goal: 'decide X',
      context: 'background Y',
      status: 'in_progress',
    })
    expect(d.goal).toBe('decide X')
    expect(d.context).toBe('background Y')
    expect(d.status).toBe('in_progress')
  })

  it('persists and reads back the selected participant set', () => {
    const d = createDiscussion({
      workspacePath: proj,
      title: 'T',
      type: 'design',
      participantAgentIds: ['gpt', 'claude'],
    })
    expect(d.participantAgentIds).toEqual(['gpt', 'claude'])
    expect(getDiscussion(d.id)?.participantAgentIds).toEqual(['gpt', 'claude'])
  })

  it('setDiscussionResearchResult writes research_result and leaves context untouched', () => {
    const d = createDiscussion({
      workspacePath: proj,
      title: 'T',
      type: 'design',
      context: 'USER ORIGINAL',
    })
    setDiscussionResearchResult(d.id, 'RESEARCH OUTPUT')
    const got = getDiscussion(d.id)
    expect(got?.researchResult).toBe('RESEARCH OUTPUT')
    expect(got?.context).toBe('USER ORIGINAL') // original context never overwritten
  })

  it('orders by updated_at descending and filters by status', () => {
    const a = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    createDiscussion({ workspacePath: proj, title: 'B', type: 't' })
    updateDiscussionStatus(a.id, 'in_progress')
    const list = listDiscussions(proj)
    expect(list.map((x) => x.title).sort()).toEqual(['A', 'B'])
    // tie-safe ordering contract: returned rows are non-increasing in updatedAt
    // (sub-ms creates can share a timestamp, so we assert the property, not a
    // fixed permutation).
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].updatedAt).toBeGreaterThanOrEqual(list[i].updatedAt)
    }
    expect(listDiscussions(proj, 'draft').map((x) => x.title)).toEqual(['B'])
    expect(listDiscussions(proj, 'in_progress').map((x) => x.title)).toEqual(['A'])
  })

  it('scopes by project and normalizes the path (resolve)', () => {
    createDiscussion({ workspacePath: '/abs/project-a/', title: 'A', type: 't' }) // trailing slash
    createDiscussion({ workspacePath: '/abs/project-b', title: 'B', type: 't' })
    expect(listDiscussions('/abs/project-a').map((x) => x.title)).toEqual(['A'])
    expect(listDiscussions('/abs/project-b').map((x) => x.title)).toEqual(['B'])
  })

  it('stamps completedAt when completed and clears it when reverted', () => {
    const d = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    expect(getDiscussion(d.id)?.completedAt).toBeNull()

    updateDiscussionStatus(d.id, 'completed')
    const done = getDiscussion(d.id)
    expect(done?.status).toBe('completed')
    expect(typeof done?.completedAt).toBe('number')
    expect(done?.completedAt).toBeGreaterThan(0)

    updateDiscussionStatus(d.id, 'cancelled')
    expect(getDiscussion(d.id)?.completedAt).toBeNull()
  })

  it('sets the conclusion and bumps updated_at', () => {
    const d = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    setConclusion(d.id, 'we will use approach X')
    const got = getDiscussion(d.id)
    expect(got?.conclusion).toBe('we will use approach X')
    expect(got!.updatedAt).toBeGreaterThanOrEqual(d.updatedAt)
  })

  it('persists the agenda (subtopics + index) and round-trips the JSON', () => {
    const d = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    setAgenda(d.id, ['延迟', '成本', '运维'], 1)
    const got = getDiscussion(d.id)
    expect(got?.agenda).toEqual(['延迟', '成本', '运维'])
    expect(got?.agendaIndex).toBe(1)
    expect(got!.updatedAt).toBeGreaterThanOrEqual(d.updatedAt)
    // index can reach length (all subtopics done)
    setAgenda(d.id, ['延迟', '成本', '运维'], 3)
    expect(getDiscussion(d.id)?.agendaIndex).toBe(3)
  })

  it('persists across a cache reset (real file)', () => {
    const d = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    setAgenda(d.id, ['x'], 0)
    resetDbForTests()
    resetStoreForTests()
    expect(getDiscussion(d.id)?.title).toBe('A')
    expect(getDiscussion(d.id)?.agenda).toEqual(['x'])
  })
})

describe('discussion messages', () => {
  it('appends messages with monotonic per-discussion seq and bumps the discussion', () => {
    const d = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    const m1 = appendMessage({ discussionId: d.id, speakerKind: 'human', content: 'hi' })
    const m2 = appendMessage({
      discussionId: d.id,
      speakerKind: 'agent',
      speakerAgentId: 'ag-1',
      speakerName: 'Reviewer',
      content: 'hello',
    })
    expect(m1.seq).toBe(1)
    expect(m2.seq).toBe(2)
    expect(m2.speakerAgentId).toBe('ag-1')
    expect(m2.speakerName).toBe('Reviewer')
    // appending bumped the discussion's updated_at past its creation time
    expect(getDiscussion(d.id)!.updatedAt).toBeGreaterThanOrEqual(d.createdAt)
  })

  it('keeps seq independent per discussion', () => {
    const a = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    const b = createDiscussion({ workspacePath: proj, title: 'B', type: 't' })
    appendMessage({ discussionId: a.id, speakerKind: 'human', content: 'a1' })
    const b1 = appendMessage({ discussionId: b.id, speakerKind: 'human', content: 'b1' })
    expect(b1.seq).toBe(1) // not 2 — scoped to discussion b
  })

  it('lists messages in seq order with nullable speaker fields defaulting to null', () => {
    const d = createDiscussion({ workspacePath: proj, title: 'A', type: 't' })
    appendMessage({ discussionId: d.id, speakerKind: 'organizer', content: 'first' })
    appendMessage({ discussionId: d.id, speakerKind: 'human', content: 'second' })
    const msgs = listMessages(d.id)
    expect(msgs.map((m) => m.content)).toEqual(['first', 'second'])
    expect(msgs[0].speakerKind).toBe('organizer')
    expect(msgs[0].speakerAgentId).toBeNull()
    expect(msgs[0].speakerName).toBeNull()
  })
})

describe('agent sessions', () => {
  it('creates an agent session and reads it back', () => {
    setAgentSession('disc-1', 'ag-1', 'sess-abc', 'claude', 0)
    const got = getAgentSession('disc-1', 'ag-1')
    expect(got).not.toBeNull()
    expect(got!.discussionId).toBe('disc-1')
    expect(got!.agentId).toBe('ag-1')
    expect(got!.sessionId).toBe('sess-abc')
    expect(got!.vendor).toBe('claude')
    expect(got!.lastSeq).toBe(0)
    expect(typeof got!.createdAt).toBe('number')
    expect(got!.createdAt).toBeGreaterThan(0)
  })

  it('preserves created_at on update and updates session_id/vendor/last_seq', () => {
    setAgentSession('disc-1', 'ag-1', 'sess-old', 'codex', 5)
    const first = getAgentSession('disc-1', 'ag-1')!
    const createdAt = first.createdAt

    setAgentSession('disc-1', 'ag-1', 'sess-new', 'claude', 10)
    const second = getAgentSession('disc-1', 'ag-1')
    expect(second!.sessionId).toBe('sess-new')
    expect(second!.vendor).toBe('claude')
    expect(second!.lastSeq).toBe(10)
    // created_at must remain unchanged from the first insert
    expect(second!.createdAt).toBe(createdAt)
  })

  it('defaults vendor to "" and lastSeq to 0', () => {
    setAgentSession('disc-1', 'ag-1', 'sess-1')
    const got = getAgentSession('disc-1', 'ag-1')
    expect(got!.vendor).toBe('')
    expect(got!.lastSeq).toBe(0)
  })

  it('deletes a single agent session', () => {
    setAgentSession('disc-1', 'ag-1', 'sess-1', 'claude')
    expect(getAgentSession('disc-1', 'ag-1')).not.toBeNull()
    deleteAgentSession('disc-1', 'ag-1')
    expect(getAgentSession('disc-1', 'ag-1')).toBeNull()
  })

  it('lists all sessions for a discussion', () => {
    setAgentSession('disc-1', 'ag-1', 'sess-a', 'claude')
    setAgentSession('disc-1', 'ag-2', 'sess-b', 'codex', 3)
    setAgentSession('disc-2', 'ag-1', 'sess-c', 'codex') // different discussion

    const list = listAgentSessions('disc-1')
    expect(list).toHaveLength(2)
    expect(list.map((s) => s.agentId).sort()).toEqual(['ag-1', 'ag-2'])
    expect(list.every((s) => s.discussionId === 'disc-1')).toBe(true)
  })

  it('deleteAllByDiscussion removes all sessions for a discussion', () => {
    setAgentSession('disc-1', 'ag-1', 'sess-a')
    setAgentSession('disc-1', 'ag-2', 'sess-b')
    setAgentSession('disc-2', 'ag-1', 'sess-c') // untouched

    deleteAllByDiscussion('disc-1')
    expect(listAgentSessions('disc-1')).toEqual([])
    // other discussion is unaffected
    expect(listAgentSessions('disc-2')).toHaveLength(1)
  })

  it('persists across a cache reset (real file)', () => {
    setAgentSession('disc-persist', 'ag-1', 'sess-p', 'claude', 7)
    resetDbForTests()
    resetStoreForTests()
    const got = getAgentSession('disc-persist', 'ag-1')
    expect(got).not.toBeNull()
    expect(got!.sessionId).toBe('sess-p')
    expect(got!.vendor).toBe('claude')
    expect(got!.lastSeq).toBe(7)
  })
})

describe('migration', () => {
  it('creates the discussion tables on an old db that lacks them', () => {
    // Mimic a pre-existing c3.db that only has unrelated tables (no discussion ones).
    const raw = getDb()!
    raw.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY); PRAGMA user_version=7;')

    // First store access ensures the discussion schema.
    resetStoreForTests()
    expect(() => createDiscussion({ workspacePath: proj, title: 'A', type: 't' })).not.toThrow()
    const tables = raw
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    expect(tables).toContain('discussions')
    expect(tables).toContain('discussion_messages')
    expect(tables).toContain('discussion_agent_sessions')
  })

  it('backfills missing columns on an old discussions table, keeps rows, is idempotent', () => {
    // Build an old-schema `discussions` table with only the core columns (no
    // goal/context/conclusion/completed_at) and one historic row.
    const raw = getDb()!
    raw.exec(`
      CREATE TABLE discussions (
        id            TEXT PRIMARY KEY,
        project_path  TEXT NOT NULL,
        title         TEXT NOT NULL,
        type          TEXT NOT NULL,
        status        TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      PRAGMA user_version=0;
    `)
    raw.run(
      `INSERT INTO discussions (id, project_path, title, type, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      'old-1',
      proj,
      'Legacy',
      't',
      'draft',
      1,
      1,
    )

    // First store access triggers the column migration.
    resetStoreForTests()
    const got = getDiscussion('old-1')
    expect(got?.title).toBe('Legacy') // historic row survives
    expect(got?.goal).toBe('') // backfilled default
    expect(got?.context).toBe('') // backfilled default
    expect(got?.researchResult).toBe('') // backfilled default (missing col → '')
    expect(got?.conclusion).toBeNull() // new nullable column
    expect(got?.completedAt).toBeNull()
    expect(got?.agenda).toEqual([]) // backfilled default '[]' → parsed to empty list
    expect(got?.agendaIndex).toBe(0) // backfilled default 0
    expect(got?.participantAgentIds).toEqual([]) // backfilled default '[]' → fallback all

    const cols = raw.all<{ name: string }>('PRAGMA table_info(discussions)').map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'goal',
        'context',
        'research_result',
        'agenda',
        'agenda_index',
        'participant_agent_ids',
        'conclusion',
        'completed_at',
      ]),
    )

    // Idempotent: a second ensure must not try to re-add columns (would throw).
    resetStoreForTests()
    expect(() => listDiscussions(proj)).not.toThrow()
    expect(getDiscussion('old-1')?.goal).toBe('')
  })
})

describe('degradation', () => {
  it('reads return empty/null and writes throw when the db is unavailable', () => {
    process.env.C3_DB_PATH = '/dev/null/nope/c3.db' // open fails
    resetDbForTests()
    resetStoreForTests()
    expect(isStoreAvailable()).toBe(false)
    expect(listDiscussions(proj)).toEqual([])
    expect(getDiscussion('x')).toBeNull()
    expect(listMessages('x')).toEqual([])
    expect(getAgentSession('x', 'y')).toBeNull()
    expect(listAgentSessions('x')).toEqual([])
    expect(() => createDiscussion({ workspacePath: proj, title: 'A', type: 't' })).toThrow(
      /讨论库不可用/,
    )
    expect(() => setAgentSession('x', 'y', 's')).toThrow(/讨论库不可用/)
    expect(() => deleteAgentSession('x', 'y')).toThrow(/讨论库不可用/)
    expect(() => deleteAllByDiscussion('x')).toThrow(/讨论库不可用/)
  })
})
