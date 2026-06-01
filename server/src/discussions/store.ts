/**
 * Discussion domain store over the shared {@link Db} (c3.db).
 *
 * Owns the discussion schema (created lazily, versioned via `PRAGMA user_version`)
 * and all discussion / message operations. Sibling to the requirement store: both
 * ride the one `~/.c3/c3.db` connection, each owning its own tables and a private
 * `schemaReady` flag. Every `projectPath` arg is `resolve()`d so it matches the
 * workspace registry key, the runtime `workspacePath`, and the SDK `cwd`.
 *
 * Degradation: when the db is unavailable, reads return empty/null and writes
 * throw (callers surface an error or skip), so c3 keeps running without the
 * discussion feature.
 */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
  Discussion,
  DiscussionMessage,
  DiscussionSpeakerKind,
  DiscussionStatus,
} from '@ccc/shared/protocol'
import { getDb, isDbAvailable, type Db } from '../db.js'

/**
 * Discussion schema version. Independent of the requirement store's version —
 * both write the single `PRAGMA user_version` and so clobber each other, but the
 * value is informational only: migrations key off `PRAGMA table_info` /
 * `CREATE TABLE IF NOT EXISTS`, never off the version number.
 */
const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS discussions (
  id            TEXT PRIMARY KEY,
  project_path  TEXT NOT NULL,
  title         TEXT NOT NULL,
  type          TEXT NOT NULL,
  goal          TEXT NOT NULL DEFAULT '',
  context       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  conclusion    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_disc_project_status ON discussions(project_path, status);

CREATE TABLE IF NOT EXISTS discussion_messages (
  id                TEXT PRIMARY KEY,
  discussion_id     TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  speaker_kind      TEXT NOT NULL,
  speaker_agent_id  TEXT,
  speaker_name      TEXT,
  content           TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disc_msg_discussion ON discussion_messages(discussion_id, seq);
`

let schemaReady = false

/**
 * Idempotently add a column to an existing table when it's missing. Used for
 * backward-compatible migrations: a fresh db already has the column via SCHEMA,
 * so we check `PRAGMA table_info` rather than relying on `user_version` history.
 * Works on both `node:sqlite` and `bun:sqlite` (only `exec`/`all`).
 */
function ensureColumn(d: Db, table: string, col: string, decl: string): void {
  const cols = d.all<{ name: string }>(`PRAGMA table_info(${table})`)
  if (!cols.some((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
  }
}

/** Return the db with the discussion schema ensured once, or null if unavailable. */
function db(): Db | null {
  const d = getDb()
  if (!d) return null
  if (!schemaReady) {
    d.exec(SCHEMA)
    // Defensive idempotent backfill: a `discussions` table created by an earlier
    // (in-development) build may predate these columns. Keyed off column presence,
    // so it's a no-op on a fresh schema and safe across runs.
    ensureColumn(d, 'discussions', 'goal', "TEXT NOT NULL DEFAULT ''")
    ensureColumn(d, 'discussions', 'context', "TEXT NOT NULL DEFAULT ''")
    ensureColumn(d, 'discussions', 'conclusion', 'TEXT')
    ensureColumn(d, 'discussions', 'completed_at', 'INTEGER')
    d.exec(`PRAGMA user_version=${SCHEMA_VERSION};`)
    schemaReady = true
  }
  return d
}

function requireDb(): Db {
  const d = db()
  if (!d) throw new Error('讨论库不可用 (c3.db unavailable)')
  return d
}

/** Whether the store can be used (db opened). */
export function isStoreAvailable(): boolean {
  return isDbAvailable()
}

/** Test-only: forget the "schema ensured" flag (pair with `resetDbForTests`). */
export function resetStoreForTests(): void {
  schemaReady = false
}

function tx<T>(d: Db, fn: () => T): T {
  d.exec('BEGIN')
  try {
    const out = fn()
    d.exec('COMMIT')
    return out
  } catch (err) {
    try {
      d.exec('ROLLBACK')
    } catch {
      /* noop */
    }
    throw err
  }
}

// ---- Discussions ----

interface DiscussionRow {
  id: string
  project_path: string
  title: string
  type: string
  goal: string
  context: string
  status: string
  conclusion: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

function toDiscussion(r: DiscussionRow): Discussion {
  return {
    id: r.id,
    projectPath: r.project_path,
    title: r.title,
    type: r.type,
    goal: r.goal,
    context: r.context,
    status: r.status as DiscussionStatus,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  }
}

/** Fields a caller supplies when creating a discussion. */
export interface CreateDiscussionInput {
  projectPath: string
  title: string
  type: string
  goal?: string
  context?: string
  /** Defaults to `draft`. */
  status?: DiscussionStatus
}

/** A project's discussions (optionally status-filtered), most-recently-updated first. */
export function listDiscussions(projectPath: string, status?: DiscussionStatus): Discussion[] {
  const d = db()
  if (!d) return []
  const proj = resolve(projectPath)
  const rows = status
    ? d.all<DiscussionRow>(
        'SELECT * FROM discussions WHERE project_path=? AND status=? ORDER BY updated_at DESC',
        proj,
        status,
      )
    : d.all<DiscussionRow>(
        'SELECT * FROM discussions WHERE project_path=? ORDER BY updated_at DESC',
        proj,
      )
  return rows.map(toDiscussion)
}

export function getDiscussion(id: string): Discussion | null {
  const d = db()
  if (!d) return null
  const row = d.get<DiscussionRow>('SELECT * FROM discussions WHERE id=?', id)
  return row ? toDiscussion(row) : null
}

/** Insert a discussion (default status `draft`) and return the hydrated row. */
export function createDiscussion(input: CreateDiscussionInput): Discussion {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  const status: DiscussionStatus = input.status ?? 'draft'
  const completedAt = status === 'completed' ? now : null
  d.run(
    `INSERT INTO discussions
       (id, project_path, title, type, goal, context, status, conclusion, created_at, updated_at, completed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    resolve(input.projectPath),
    input.title,
    input.type,
    input.goal ?? '',
    input.context ?? '',
    status,
    null,
    now,
    now,
    completedAt,
  )
  return getDiscussion(id)!
}

/**
 * Update a discussion's status. `completed` stamps the completion time; any other
 * status clears it (covers reverting from completed) — same rule as requirements.
 */
export function updateDiscussionStatus(id: string, status: DiscussionStatus): void {
  const d = requireDb()
  const now = Date.now()
  const completedAt = status === 'completed' ? now : null
  d.run(
    'UPDATE discussions SET status=?, updated_at=?, completed_at=? WHERE id=?',
    status,
    now,
    completedAt,
    id,
  )
}

/** Set the discussion's concluded outcome. */
export function setConclusion(id: string, conclusion: string): void {
  const d = requireDb()
  d.run('UPDATE discussions SET conclusion=?, updated_at=? WHERE id=?', conclusion, Date.now(), id)
}

/** Replace the discussion's background context (the research agent's completed output). */
export function setDiscussionContext(id: string, context: string): void {
  const d = requireDb()
  d.run('UPDATE discussions SET context=?, updated_at=? WHERE id=?', context, Date.now(), id)
}

// ---- Discussion messages ----

interface MessageRow {
  id: string
  discussion_id: string
  seq: number
  speaker_kind: string
  speaker_agent_id: string | null
  speaker_name: string | null
  content: string
  created_at: number
}

function toMessage(r: MessageRow): DiscussionMessage {
  return {
    id: r.id,
    discussionId: r.discussion_id,
    seq: r.seq,
    speakerKind: r.speaker_kind as DiscussionSpeakerKind,
    speakerAgentId: r.speaker_agent_id,
    speakerName: r.speaker_name,
    content: r.content,
    createdAt: r.created_at,
  }
}

/** Fields a caller supplies when appending a message. */
export interface AppendMessageInput {
  discussionId: string
  speakerKind: DiscussionSpeakerKind
  speakerAgentId?: string | null
  speakerName?: string | null
  content: string
}

/**
 * Append a message to a discussion. Assigns the next per-discussion `seq`
 * (`MAX(seq)+1`) and bumps the discussion's `updated_at`, all in one transaction
 * so the seq is race-free under the single synchronous connection.
 */
export function appendMessage(input: AppendMessageInput): DiscussionMessage {
  const d = requireDb()
  const id = randomUUID()
  const now = Date.now()
  return tx(d, () => {
    const row = d.get<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM discussion_messages WHERE discussion_id=?',
      input.discussionId,
    )
    const seq = row?.next ?? 1
    d.run(
      `INSERT INTO discussion_messages
         (id, discussion_id, seq, speaker_kind, speaker_agent_id, speaker_name, content, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      input.discussionId,
      seq,
      input.speakerKind,
      input.speakerAgentId ?? null,
      input.speakerName ?? null,
      input.content,
      now,
    )
    d.run('UPDATE discussions SET updated_at=? WHERE id=?', now, input.discussionId)
    return {
      id,
      discussionId: input.discussionId,
      seq,
      speakerKind: input.speakerKind,
      speakerAgentId: input.speakerAgentId ?? null,
      speakerName: input.speakerName ?? null,
      content: input.content,
      createdAt: now,
    }
  })
}

/** All messages of a discussion, in `seq` order. */
export function listMessages(discussionId: string): DiscussionMessage[] {
  const d = db()
  if (!d) return []
  const rows = d.all<MessageRow>(
    'SELECT * FROM discussion_messages WHERE discussion_id=? ORDER BY seq ASC',
    discussionId,
  )
  return rows.map(toMessage)
}
