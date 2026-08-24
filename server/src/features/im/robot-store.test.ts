/**
 * Robot store: authorization invariants, sender-isolated Conversations, bounded
 * context persistence, safe-cut migration, and audit-without-body.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROBOT_CONTEXT_MAX_TURNS, ROBOT_CONTEXT_RETENTION_MS } from '@ccc/shared/protocol'
import {
  getDb,
  hasMigration,
  resetDbForTests,
  ensureMigrationsTable,
  markMigration,
} from '../../kernel/infra/db.js'
import { identityTablesPresent } from './identity-schema.js'
import {
  RobotStoreError,
  acknowledgeOutbound,
  beginTurn,
  claimInboundMessage,
  commitContextTurn,
  createRobot,
  deleteRobot,
  ensureRobotSchema,
  failContextTurn,
  finishTurn,
  getConversation,
  getRobot,
  hasSenderIsolationMigration,
  listEnabledRobots,
  listRobots,
  listTurns,
  loadCommittedContext,
  resetRobotStoreForTests,
  resolvedSessionRef,
  robotSecret,
  setRobotEnabled,
  setRobotStoreClockForTests,
  updateRobot,
  type CreateRobotInput,
} from './robot-store.js'
import { conversationIdentityOf } from './thread-key.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-robot-store-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetRobotStoreForTests()
})

afterEach(() => {
  setRobotStoreClockForTests(null)
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetRobotStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

const input = (over: Partial<CreateRobotInput> = {}): CreateRobotInput => ({
  name: 'helper',
  platform: 'feishu',
  appId: 'cli_app',
  appSecret: 'super-secret',
  vendor: 'claude',
  agentId: 'agent-1',
  ...over,
})

function refuses(fn: () => unknown, code: string): RobotStoreError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RobotStoreError)
    expect((err as RobotStoreError).code).toBe(code)
    return err as RobotStoreError
  }
  throw new Error(`expected a refusal with code ${code}`)
}

function claim(
  robotId: string,
  over: Partial<{
    threadKey: string
    senderId: string
    messageId: string
    chatId: string
  }> = {},
) {
  return claimInboundMessage({
    platform: 'feishu',
    robotId,
    threadKey: over.threadKey ?? 'c:oc',
    senderId: over.senderId ?? 'u1',
    bindingId: 'b1',
    subject: 'local',
    scopeHash: 'h1',
    chatId: over.chatId ?? 'oc',
    vendor: 'claude',
    messageId: over.messageId ?? `m-${Math.random().toString(36).slice(2)}`,
  })
}

describe('creation — never enabled, never acknowledged', () => {
  it('creates a robot disabled and unacknowledged', () => {
    const robot = createRobot(input())
    expect(robot.enabled).toBe(false)
    expect(robot.outboundAckAt).toBeNull()
  })

  it('defaults the response surface to the narrow side', () => {
    const robot = createRobot(input())
    expect(robot.requireMention).toBe(true)
    expect(robot.dmMode).toBe('disabled')
    expect(robot.toolAllowlist).toEqual([])
  })

  it('refuses a name that could escape the robots directory', () => {
    for (const name of ['../evil', 'a/b', 'UPPER', '', 'x'.repeat(33), '-leading']) {
      refuses(() => createRobot(input({ name })), 'name_invalid')
    }
  })

  it('refuses a duplicate name', () => {
    createRobot(input())
    refuses(() => createRobot(input()), 'name_conflict')
  })
})

describe('the app secret never comes back through the read path', () => {
  it('reports only whether a secret is configured', () => {
    const robot = createRobot(input())
    expect(robot.hasSecret).toBe(true)
    expect(JSON.stringify(robot)).not.toContain('super-secret')
  })

  it('stores the secret encrypted, not as plaintext', () => {
    const robot = createRobot(input())
    const raw = getDb()!.get<{ app_secret: string }>(
      'SELECT app_secret FROM im_robots WHERE id = ?',
      robot.id,
    )!
    expect(raw.app_secret).not.toBe('super-secret')
    expect(raw.app_secret.startsWith('c3secret')).toBe(true)
  })

  it('hands the plaintext back only through the dedicated accessor', () => {
    const robot = createRobot(input())
    expect(robotSecret(robot.id)).toBe('super-secret')
  })

  it('keeps the stored secret when an update omits it', () => {
    const robot = createRobot(input())
    updateRobot(robot.id, { appId: 'cli_other' })
    expect(robotSecret(robot.id)).toBe('super-secret')
    expect(getRobot(robot.id)!.hasSecret).toBe(true)
  })
})

describe('enabling — the server enforces the authorization, not the client', () => {
  it('refuses to enable without an acknowledgement', () => {
    const robot = createRobot(input())
    refuses(() => setRobotEnabled(robot.id, true), 'outbound_not_acknowledged')
    expect(getRobot(robot.id)!.enabled).toBe(false)
  })

  it('refuses to enable without a credential to connect with', () => {
    const robot = createRobot(input({ appSecret: '' }))
    acknowledgeOutbound(robot.id)
    refuses(() => setRobotEnabled(robot.id, true), 'secret_required')
  })

  it('enables once both are satisfied', () => {
    const robot = createRobot(input())
    acknowledgeOutbound(robot.id)
    expect(setRobotEnabled(robot.id, true).enabled).toBe(true)
    expect(listEnabledRobots().map((r) => r.id)).toEqual([robot.id])
  })

  it('always allows disabling', () => {
    const robot = createRobot(input())
    acknowledgeOutbound(robot.id)
    setRobotEnabled(robot.id, true)
    expect(setRobotEnabled(robot.id, false).enabled).toBe(false)
    expect(listEnabledRobots()).toEqual([])
  })
})

describe('sender-isolated Conversations', () => {
  it('gives different senders independent Conversations in the same thread', () => {
    const robot = createRobot(input())
    const a = claim(robot.id, { senderId: 'alice', messageId: 'm1' })
    const b = claim(robot.id, { senderId: 'bob', messageId: 'm2' })
    expect(a.kind).toBe('claimed')
    expect(b.kind).toBe('claimed')
    if (a.kind !== 'claimed' || b.kind !== 'claimed') return
    commitContextTurn({
      contextTurnId: a.contextTurnId,
      userText: 'alice secret',
      assistantText: 'alice answer',
      sessionId: 'sess-a',
      vendor: 'claude',
    })
    expect(
      loadCommittedContext(
        conversationIdentityOf('feishu', robot.id, 'c:oc', 'bob', 'b1', 'local', 'h1'),
      ),
    ).toEqual([])
    expect(
      loadCommittedContext(
        conversationIdentityOf('feishu', robot.id, 'c:oc', 'alice', 'b1', 'local', 'h1'),
      ).map((t) => t.userText),
    ).toEqual(['alice secret'])
  })

  it('resumes the same sender continuous context', () => {
    const robot = createRobot(input())
    const first = claim(robot.id, { senderId: 'u1', messageId: 'm1' })
    expect(first.kind).toBe('claimed')
    if (first.kind !== 'claimed') return
    commitContextTurn({
      contextTurnId: first.contextTurnId,
      userText: 'q1',
      assistantText: 'a1',
      sessionId: 'sess-1',
      vendor: 'claude',
    })
    const second = claim(robot.id, { senderId: 'u1', messageId: 'm2' })
    expect(second.kind).toBe('claimed')
    if (second.kind !== 'claimed') return
    expect(second.conversation.sessionId).toBe('sess-1')
    expect(
      loadCommittedContext(
        conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
      ).map((t) => t.assistantText),
    ).toEqual(['a1'])
  })

  it('treats a duplicate messageId as a no-op claim', () => {
    const robot = createRobot(input())
    expect(claim(robot.id, { messageId: 'dup' }).kind).toBe('claimed')
    expect(claim(robot.id, { messageId: 'dup' }).kind).toBe('duplicate')
  })

  it('reserves a busy-path claim without healing a live pending', () => {
    const robot = createRobot(input())
    const pending = claim(robot.id, { messageId: 'm-pending' })
    expect(pending.kind).toBe('claimed')

    const busy = claimInboundMessage({
      platform: 'feishu',
      robotId: robot.id,
      threadKey: 'c:oc',
      senderId: 'u1',
      bindingId: 'b1',
      subject: 'local',
      scopeHash: 'h1',
      chatId: 'oc',
      vendor: 'claude',
      messageId: 'm-busy',
      forRun: false,
    })
    expect(busy.kind).toBe('busy')
    expect(
      claimInboundMessage({
        platform: 'feishu',
        robotId: robot.id,
        threadKey: 'c:oc',
        senderId: 'u1',
        bindingId: 'b1',
        subject: 'local',
        scopeHash: 'h1',
        chatId: 'oc',
        vendor: 'claude',
        messageId: 'm-busy',
        forRun: true,
      }).kind,
    ).toBe('duplicate')

    expect(
      getDb()!.get<{ status: string }>(
        `SELECT status FROM im_robot_context_turns
         WHERE robot_id = ? AND in_message_id = 'm-pending'`,
        robot.id,
      )?.status,
    ).toBe('pending')
    expect(
      getDb()!.get<{ status: string }>(
        `SELECT status FROM im_robot_context_turns
         WHERE robot_id = ? AND in_message_id = 'm-busy'`,
        robot.id,
      )?.status,
    ).toBe('failed')
  })

  it('does not put failed turn bodies into recovery context', () => {
    const robot = createRobot(input())
    const c = claim(robot.id, { messageId: 'm-fail' })
    expect(c.kind).toBe('claimed')
    if (c.kind !== 'claimed') return
    failContextTurn(c.contextTurnId)
    expect(
      loadCommittedContext(
        conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
      ),
    ).toEqual([])
    expect(
      resolvedSessionRef(
        getConversation(
          conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
        )!,
        'claude',
      ),
    ).toBeNull()
  })

  it('refuses to resume a session when vendor mismatches', () => {
    const robot = createRobot(input())
    const c = claim(robot.id, { messageId: 'm1' })
    if (c.kind !== 'claimed') return
    commitContextTurn({
      contextTurnId: c.contextTurnId,
      userText: 'q',
      assistantText: 'a',
      sessionId: 'sess-1',
      vendor: 'claude',
    })
    const conv = getConversation(
      conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
    )!
    expect(resolvedSessionRef(conv, 'codex')).toBeNull()
    expect(resolvedSessionRef(conv, 'claude')?.sessionId).toBe('sess-1')
  })
})

describe('retention', () => {
  it('hard-deletes the oldest complete turn when the 51st is written', () => {
    const robot = createRobot(input())
    for (let i = 0; i < ROBOT_CONTEXT_MAX_TURNS + 1; i++) {
      const c = claim(robot.id, { messageId: `m-${i}` })
      expect(c.kind).toBe('claimed')
      if (c.kind !== 'claimed') return
      commitContextTurn({
        contextTurnId: c.contextTurnId,
        userText: `q${i}`,
        assistantText: `a${i}`,
        sessionId: `sess-${i}`,
        vendor: 'claude',
      })
    }
    const turns = loadCommittedContext(
      conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
    )
    expect(turns).toHaveLength(ROBOT_CONTEXT_MAX_TURNS)
    expect(turns[0]?.userText).toBe('q1')
    expect(turns.at(-1)?.userText).toBe(`q${ROBOT_CONTEXT_MAX_TURNS}`)
  })

  it('keeps a turn at exactly 30 days and deletes after', () => {
    const robot = createRobot(input())
    const t0 = 1_700_000_000_000
    setRobotStoreClockForTests(() => t0)
    const c = claim(robot.id, { messageId: 'm1' })
    if (c.kind !== 'claimed') return
    commitContextTurn({
      contextTurnId: c.contextTurnId,
      userText: 'q',
      assistantText: 'a',
      sessionId: 's',
      vendor: 'claude',
    })

    setRobotStoreClockForTests(() => t0 + ROBOT_CONTEXT_RETENTION_MS)
    expect(
      loadCommittedContext(
        conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
      ),
    ).toHaveLength(1)

    setRobotStoreClockForTests(() => t0 + ROBOT_CONTEXT_RETENTION_MS + 1)
    expect(
      loadCommittedContext(
        conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
      ),
    ).toHaveLength(0)
  })
})

describe('audit — records that it happened, not what was said', () => {
  it('records a length, and no message text anywhere in the row', () => {
    const robot = createRobot(input())
    const turnId = beginTurn({
      robotId: robot.id,
      threadKey: 'k',
      chatId: 'c',
      senderId: 'u1',
      messageId: 'm1',
    })
    finishTurn(turnId, { outcome: 'complete', sessionId: 'sess-1', outboundChars: 42 })

    const [log] = listTurns(robot.id)
    expect(log).toMatchObject({
      outcome: 'complete',
      outboundChars: 42,
      sessionId: 'sess-1',
      rejectReason: null,
    })
    const raw = getDb()!.get<Record<string, unknown>>(
      'SELECT * FROM im_robot_turns WHERE id = ?',
      turnId,
    )!
    expect(Object.keys(raw)).not.toContain('body')
    expect(Object.keys(raw)).not.toContain('content')
    expect(Object.keys(raw)).not.toContain('user_text')
  })

  it('records input_rejected with a closed reason code', () => {
    const robot = createRobot(input())
    const id = beginTurn({
      robotId: robot.id,
      threadKey: 'k',
      chatId: 'c',
      senderId: 'u1',
      messageId: 'm-rej',
    })
    finishTurn(id, { outcome: 'input_rejected', rejectReason: 'credential', outboundChars: 0 })
    expect(listTurns(robot.id)[0]).toMatchObject({
      outcome: 'input_rejected',
      rejectReason: 'credential',
      outboundChars: 0,
    })
  })

  it('records non-complete outcomes including busy without bodies', () => {
    const robot = createRobot(input())
    for (const outcome of ['guard_refused', 'blocked', 'timeout', 'error', 'busy'] as const) {
      const id = beginTurn({
        robotId: robot.id,
        threadKey: 'k',
        chatId: 'c',
        senderId: 'u1',
        messageId: `m-${outcome}`,
      })
      finishTurn(id, { outcome, outboundChars: 0 })
    }
    expect(
      listTurns(robot.id)
        .map((t) => t.outcome)
        .sort(),
    ).toEqual(['blocked', 'busy', 'error', 'guard_refused', 'timeout'].sort())
    expect(listTurns(robot.id).every((t) => t.outboundChars === 0)).toBe(true)
  })
})

describe('deletion', () => {
  it('cascades Conversations, context and audit', () => {
    const robot = createRobot(input())
    const c = claim(robot.id, { messageId: 'm1' })
    if (c.kind !== 'claimed') return
    commitContextTurn({
      contextTurnId: c.contextTurnId,
      userText: 'q',
      assistantText: 'a',
      sessionId: 's',
      vendor: 'claude',
    })
    finishTurn(
      beginTurn({
        robotId: robot.id,
        threadKey: 'c:oc',
        chatId: 'oc',
        senderId: 'u1',
        messageId: 'm1',
      }),
      { outcome: 'complete' },
    )

    deleteRobot(robot.id)

    expect(listRobots()).toEqual([])
    expect(
      getConversation(
        conversationIdentityOf('feishu', robot.id, 'c:oc', 'u1', 'b1', 'local', 'h1'),
      ),
    ).toBeNull()
    expect(listTurns(robot.id)).toEqual([])
    expect(
      getDb()!.all('SELECT id FROM im_robot_context_turns WHERE robot_id = ?', robot.id),
    ).toEqual([])
  })
})

describe('safe-cut migration from shared sessions', () => {
  it('renames old shared threads aside and leaves no readable session_id', () => {
    // Simulate a pre-sender-isolation database.
    resetDbForTests()
    resetRobotStoreForTests()
    const d = getDb()!
    d.exec(`
      CREATE TABLE im_robots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
        app_id TEXT NOT NULL, app_secret TEXT NOT NULL DEFAULT '',
        vendor TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '',
        tool_allowlist TEXT NOT NULL DEFAULT '[]', require_mention INTEGER NOT NULL DEFAULT 1,
        chat_allowlist TEXT NOT NULL DEFAULT '[]', dm_mode TEXT NOT NULL DEFAULT 'disabled',
        dm_allowlist TEXT NOT NULL DEFAULT '[]', max_turn_ms INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, outbound_ack_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE im_robot_threads (
        robot_id TEXT NOT NULL, thread_key TEXT NOT NULL, chat_id TEXT NOT NULL,
        session_id TEXT, vendor TEXT NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
        PRIMARY KEY (robot_id, thread_key)
      );
      CREATE INDEX idx_im_thread_session ON im_robot_threads(session_id);
      CREATE INDEX idx_im_thread_idle ON im_robot_threads(last_active_at);
      CREATE TABLE im_robot_turns (
        id TEXT PRIMARY KEY, robot_id TEXT NOT NULL, thread_key TEXT NOT NULL,
        chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, in_message_id TEXT NOT NULL,
        session_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
        outcome TEXT, outbound_chars INTEGER NOT NULL DEFAULT 0,
        out_message_id TEXT, error TEXT
      );
      CREATE INDEX idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC);
      CREATE INDEX idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC);
    `)
    d.run(
      `INSERT INTO im_robots
         (id, name, platform, app_id, app_secret, vendor, agent_id, mode, tool_allowlist,
          require_mention, chat_allowlist, dm_mode, dm_allowlist, max_turn_ms,
          enabled, outbound_ack_at, created_at, updated_at)
       VALUES ('rb-old','old','feishu','app','','claude','a','','[]',1,'[]','disabled','[]',NULL,0,NULL,1,1)`,
    )
    d.run(
      `INSERT INTO im_robot_threads
         (robot_id, thread_key, chat_id, session_id, vendor, turn_count, last_message_id,
          created_at, last_active_at)
       VALUES ('rb-old','c:oc','oc','shared-sess','claude',3,'m-last',1,1)`,
    )
    d.run(
      `INSERT INTO im_robot_turns
         (id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
          started_at, finished_at, outcome, outbound_chars, out_message_id, error)
       VALUES ('t1','rb-old','c:oc','oc','alice','m-a','shared-sess',1,2,'complete',10,NULL,NULL)`,
    )
    d.run(
      `INSERT INTO im_robot_turns
         (id, robot_id, thread_key, chat_id, sender_id, in_message_id, session_id,
          started_at, finished_at, outcome, outbound_chars, out_message_id, error)
       VALUES ('t2','rb-old','c:oc','oc','bob','m-b','shared-sess',3,4,'complete',10,NULL,NULL)`,
    )

    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(hasSenderIsolationMigration()).toBe(true)
    expect(hasMigration(d, 'robots.sender_isolation.v1')).toBe(true)

    // Old shared session is not on any sender Conversation.
    expect(
      getConversation(
        conversationIdentityOf('feishu', 'rb-old', 'c:oc', 'alice', 'b1', 'local', 'h1'),
      ),
    ).toBeNull()
    expect(
      getConversation(
        conversationIdentityOf('feishu', 'rb-old', 'c:oc', 'bob', 'b1', 'local', 'h1'),
      ),
    ).toBeNull()
    expect(
      d.get("SELECT name FROM sqlite_master WHERE name='im_robot_threads_pre_sender'"),
    ).toBeTruthy()

    // Indexes must land on the new sender-isolated table, not stay on the archive.
    const threadIndexes = d.all<{ name: string; tbl_name: string }>(
      `SELECT name, tbl_name FROM sqlite_master
       WHERE type = 'index' AND name IN ('idx_im_thread_session', 'idx_im_thread_idle')
       ORDER BY name`,
    )
    expect(threadIndexes).toEqual([
      { name: 'idx_im_thread_idle', tbl_name: 'im_robot_threads' },
      { name: 'idx_im_thread_session', tbl_name: 'im_robot_threads' },
    ])
    const turnIndexes = d.all<{ name: string; tbl_name: string }>(
      `SELECT name, tbl_name FROM sqlite_master
       WHERE type = 'index' AND name IN ('idx_im_turn_robot', 'idx_im_turn_thread')
       ORDER BY name`,
    )
    expect(turnIndexes).toEqual([
      { name: 'idx_im_turn_robot', tbl_name: 'im_robot_turns' },
      { name: 'idx_im_turn_thread', tbl_name: 'im_robot_turns' },
    ])

    // Audit rows preserved.
    expect(listTurns('rb-old')).toHaveLength(2)

    // First post-upgrade message starts empty — does not inherit shared-sess.
    const c = claim('rb-old', { senderId: 'alice', messageId: 'm-new' })
    expect(c.kind).toBe('claimed')
    if (c.kind !== 'claimed') return
    expect(c.conversation.sessionId).toBeNull()
    expect(
      loadCommittedContext(
        conversationIdentityOf('feishu', 'rb-old', 'c:oc', 'alice', 'b1', 'local', 'h1'),
      ),
    ).toEqual([])

    // Migration is idempotent.
    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(listTurns('rb-old')).toHaveLength(2)
  })
})

describe('identity-scope migration (robots.identity_scope.v1)', () => {
  it('rebuilds seven-dimensional threads, drops old context bodies, preserves audit, and converges identity tables atomically', () => {
    resetDbForTests()
    resetRobotStoreForTests()
    const d = getDb()!
    d.exec(`
      CREATE TABLE im_robots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
        app_id TEXT NOT NULL, app_secret TEXT NOT NULL DEFAULT '',
        vendor TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '',
        tool_allowlist TEXT NOT NULL DEFAULT '[]', require_mention INTEGER NOT NULL DEFAULT 1,
        chat_allowlist TEXT NOT NULL DEFAULT '[]', dm_mode TEXT NOT NULL DEFAULT 'disabled',
        dm_allowlist TEXT NOT NULL DEFAULT '[]', max_turn_ms INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, outbound_ack_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE im_robot_threads (
        platform TEXT NOT NULL, robot_id TEXT NOT NULL, thread_key TEXT NOT NULL,
        sender_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT,
        vendor TEXT NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
        PRIMARY KEY (platform, robot_id, thread_key, sender_id)
      );
      CREATE TABLE im_robot_context_turns (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, robot_id TEXT NOT NULL,
        thread_key TEXT NOT NULL, sender_id TEXT NOT NULL, in_message_id TEXT NOT NULL,
        status TEXT NOT NULL, user_text TEXT NOT NULL DEFAULT '',
        assistant_text TEXT NOT NULL DEFAULT '', seq INTEGER, committed_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (platform, robot_id, in_message_id)
      );
      CREATE TABLE im_robot_turns (
        id TEXT PRIMARY KEY, robot_id TEXT NOT NULL, thread_key TEXT NOT NULL,
        chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, in_message_id TEXT NOT NULL,
        session_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
        outcome TEXT CHECK(outcome IS NULL OR outcome IN
          ('complete','error','blocked','timeout','guard_refused','input_rejected','busy')),
        reject_reason TEXT, outbound_chars INTEGER NOT NULL DEFAULT 0,
        out_message_id TEXT, error TEXT
      );
    `)
    d.run(
      `INSERT INTO im_robots
         (id,name,platform,app_id,app_secret,vendor,agent_id,mode,tool_allowlist,
          require_mention,chat_allowlist,dm_mode,dm_allowlist,max_turn_ms,
          enabled,outbound_ack_at,created_at,updated_at)
       VALUES ('rb-id','bot','feishu','app','','claude','a','','[]',1,'[]','disabled','[]',NULL,0,NULL,1,1)`,
    )
    d.run(
      `INSERT INTO im_robot_threads
         (platform,robot_id,thread_key,sender_id,chat_id,session_id,vendor,turn_count,
          last_message_id,created_at,last_active_at)
       VALUES ('feishu','rb-id','c:oc','alice','oc','sess-old','claude',1,'m1',1,1)`,
    )
    d.run(
      `INSERT INTO im_robot_context_turns
         (id,platform,robot_id,thread_key,sender_id,in_message_id,status,user_text,
          assistant_text,seq,committed_at,created_at)
       VALUES ('ctx-1','feishu','rb-id','c:oc','alice','m-old','committed','secret q','secret a',1,1,1)`,
    )
    d.run(
      `INSERT INTO im_robot_turns
         (id,robot_id,thread_key,chat_id,sender_id,in_message_id,session_id,
          started_at,finished_at,outcome,reject_reason,outbound_chars,out_message_id,error)
       VALUES ('t-old','rb-id','c:oc','oc','alice','m-old','sess-old',1,2,'complete',NULL,12,NULL,NULL)`,
    )

    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(hasMigration(d, 'robots.identity_scope.v1')).toBe(true)
    expect(identityTablesPresent(d)).toBe(true)
    expect(
      d.get("SELECT name FROM sqlite_master WHERE name='im_robot_threads_pre_identity'"),
    ).toBeTruthy()
    expect(d.all('SELECT id FROM im_robot_context_turns')).toEqual([])
    expect(listTurns('rb-id')).toHaveLength(1)
    expect(listTurns('rb-id')[0]?.outcome).toBe('complete')

    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(listTurns('rb-id')).toHaveLength(1)
  })

  it('rolls back the whole migration when turn copy fails', () => {
    resetDbForTests()
    resetRobotStoreForTests()
    const d = getDb()!
    ensureMigrationsTable(d)
    markMigration(d, 'robots.sender_isolation.v1')
    d.exec(`
      CREATE TABLE im_robots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
        app_id TEXT NOT NULL, app_secret TEXT NOT NULL DEFAULT '',
        vendor TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '',
        tool_allowlist TEXT NOT NULL DEFAULT '[]', require_mention INTEGER NOT NULL DEFAULT 1,
        chat_allowlist TEXT NOT NULL DEFAULT '[]', dm_mode TEXT NOT NULL DEFAULT 'disabled',
        dm_allowlist TEXT NOT NULL DEFAULT '[]', max_turn_ms INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, outbound_ack_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE im_robot_threads (
        platform TEXT NOT NULL, robot_id TEXT NOT NULL, thread_key TEXT NOT NULL,
        sender_id TEXT NOT NULL, chat_id TEXT NOT NULL, session_id TEXT,
        vendor TEXT NOT NULL, turn_count INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
        PRIMARY KEY (platform, robot_id, thread_key, sender_id)
      );
      CREATE TABLE im_robot_turns (
        id TEXT PRIMARY KEY, robot_id TEXT NOT NULL, thread_key TEXT NOT NULL,
        chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, in_message_id TEXT NOT NULL,
        session_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
        outcome TEXT CHECK(outcome IS NULL OR outcome IN
          ('complete','error','blocked','timeout','guard_refused','input_rejected','busy')),
        reject_reason TEXT, outbound_chars INTEGER NOT NULL DEFAULT 0,
        out_message_id TEXT, error TEXT
      );
    `)
    d.run(
      `INSERT INTO im_robot_turns
         (id,robot_id,thread_key,chat_id,sender_id,in_message_id,started_at,outcome,outbound_chars)
       VALUES ('bad','rb','k','c','u','m',1,'complete',1)`,
    )

    const origExec = d.exec.bind(d)
    d.exec = (sql: string) => {
      if (sql.includes('FROM im_robot_turns_pre_identity')) {
        throw new Error('inject copy failure')
      }
      return origExec(sql)
    }

    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(false)
    expect(hasMigration(d, 'robots.identity_scope.v1')).toBe(false)
    expect(identityTablesPresent(d)).toBe(false)
    expect(d.get<{ id: string }>("SELECT id FROM im_robot_turns WHERE id='bad'")?.id).toBe('bad')
  })
})

describe('platform-check removal (im_robots rebuild)', () => {
  function imRobotsSql(d: ReturnType<typeof getDb>): string | undefined {
    return d?.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'im_robots'`,
    )?.sql
  }

  function imRobotsColumns(d: ReturnType<typeof getDb>): string[] {
    return (d?.all<{ name: string }>('PRAGMA table_info(im_robots)') ?? []).map((c) => c.name)
  }

  it('fresh install: table carries no platform CHECK and the full column set', () => {
    resetDbForTests()
    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    const d = getDb()!
    const sql = imRobotsSql(d)!
    expect(sql).not.toMatch(/CHECK\s*\(\s*platform\s+IN\s+\(\s*'feishu'\s*\)\s*\)/)
    const cols = imRobotsColumns(d)
    expect(cols).toEqual(
      expect.arrayContaining([
        'config_revision',
        'outbound_ack_hash',
        'broadcast_event_types',
        'broadcast_to_bound_users',
        'broadcast_group_chat_ids',
        'locale',
      ]),
    )
    // feishu remains a valid value — the platform name lives in the registry,
    // not in the table constraint.
    const robot = createRobot(input())
    expect(robot.configRevision).toBe(0)
    // Idempotent: re-ensuring on the same database is a no-op.
    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(listRobots().map((r) => r.id)).toEqual([robot.id])
  })

  it('old install: rebuilds once the CHECK is gone and preserves rows', () => {
    resetDbForTests()
    resetRobotStoreForTests()
    const d = getDb()!
    // A pre-change database: full column set (migrations already marked) but the
    // feishu CHECK still baked into the table. The marker-gated ALTER migrations
    // will NOT re-run, so the rebuilt table must carry every column itself.
    ensureMigrationsTable(d)
    markMigration(d, 'robots.sender_isolation.v1')
    markMigration(d, 'robots.identity_scope.v1')
    markMigration(d, 'robots.locale.v1')
    markMigration(d, 'robots.broadcast_config.v1')
    markMigration(d, 'robots.config_revision.v1')
    d.exec(`
      CREATE TABLE im_robots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu')),
        app_id TEXT NOT NULL, app_secret TEXT NOT NULL DEFAULT '',
        vendor TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '',
        tool_allowlist TEXT NOT NULL DEFAULT '[]', require_mention INTEGER NOT NULL DEFAULT 1,
        chat_allowlist TEXT NOT NULL DEFAULT '[]', dm_mode TEXT NOT NULL DEFAULT 'disabled',
        dm_allowlist TEXT NOT NULL DEFAULT '[]', max_turn_ms INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, outbound_ack_at INTEGER,
        locale TEXT, outbound_ack_hash TEXT,
        broadcast_event_types TEXT NOT NULL DEFAULT '[]',
        broadcast_to_bound_users INTEGER NOT NULL DEFAULT 0,
        broadcast_group_chat_ids TEXT NOT NULL DEFAULT '[]',
        config_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_im_robot_name ON im_robots(name);
      CREATE INDEX idx_im_robot_enabled ON im_robots(enabled);
    `)
    d.run(
      `INSERT INTO im_robots
         (id, name, platform, app_id, app_secret, vendor, agent_id, mode, tool_allowlist,
          require_mention, chat_allowlist, dm_mode, dm_allowlist, max_turn_ms,
          enabled, outbound_ack_at, locale, outbound_ack_hash, broadcast_event_types,
          broadcast_to_bound_users, broadcast_group_chat_ids, config_revision,
          created_at, updated_at)
       VALUES ('rb-old-check','old','feishu','app','','claude','a','','[]',1,'[]','disabled',
               '[]',NULL,0,NULL,'zh','h1','[]',1,'[]',3,1,1)`,
    )

    expect(ensureRobotSchema()).toBe(true)
    const sql = imRobotsSql(d)!
    expect(sql).not.toMatch(/CHECK\s*\(\s*platform\s+IN\s*\(\s*'feishu'\s*\)\s*\)/)
    // Archive dropped; its indexes did not stay behind on a renamed table.
    expect(
      d.get("SELECT name FROM sqlite_master WHERE name='im_robots_pre_platform_check'"),
    ).toBeUndefined()
    // Full column set survived the rebuild even though the ALTER migrations skipped.
    expect(imRobotsColumns(d)).toEqual(
      expect.arrayContaining([
        'config_revision',
        'broadcast_event_types',
        'locale',
        'outbound_ack_hash',
      ]),
    )
    const robot = getRobot('rb-old-check')
    expect(robot?.configRevision).toBe(3)
    expect(robot?.broadcastToBoundUsers).toBe(true)
    expect(robot?.locale).toBe('zh')
    // Indexes recreated on the fresh table.
    const nameIndex = d.get<{ tbl_name: string }>(
      `SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_im_robot_name'`,
    )
    expect(nameIndex?.tbl_name).toBe('im_robots')

    // Idempotent: a second ensure keeps the row and does not rebuild again.
    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(getRobot('rb-old-check')?.name).toBe('old')
    expect(imRobotsSql(d)!).not.toMatch(/CHECK\s*\(\s*platform\s+IN\s*\(\s*'feishu'\s*\)\s*\)/)
  })

  it('mid-flight install: CHECK removed and late columns land with defaults', () => {
    resetDbForTests()
    resetRobotStoreForTests()
    const d = getDb()!
    // Base columns only (predates locale / broadcast / config_revision), still
    // carrying the feishu CHECK. The column migrations run, then the rebuild.
    d.exec(`
      CREATE TABLE im_robots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu')),
        app_id TEXT NOT NULL, app_secret TEXT NOT NULL DEFAULT '',
        vendor TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '',
        tool_allowlist TEXT NOT NULL DEFAULT '[]', require_mention INTEGER NOT NULL DEFAULT 1,
        chat_allowlist TEXT NOT NULL DEFAULT '[]', dm_mode TEXT NOT NULL DEFAULT 'disabled',
        dm_allowlist TEXT NOT NULL DEFAULT '[]', max_turn_ms INTEGER,
        enabled INTEGER NOT NULL DEFAULT 0, outbound_ack_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
    d.run(
      `INSERT INTO im_robots
         (id, name, platform, app_id, app_secret, vendor, agent_id, mode, tool_allowlist,
          require_mention, chat_allowlist, dm_mode, dm_allowlist, max_turn_ms,
          enabled, outbound_ack_at, created_at, updated_at)
       VALUES ('rb-mid','mid','feishu','app','','claude','a','','[]',1,'[]','disabled',
               '[]',NULL,0,NULL,1,1)`,
    )

    expect(ensureRobotSchema()).toBe(true)
    expect(imRobotsSql(d)!).not.toMatch(/CHECK\s*\(\s*platform\s+IN\s*\(\s*'feishu'\s*\)\s*\)/)
    expect(imRobotsColumns(d)).toEqual(
      expect.arrayContaining(['config_revision', 'broadcast_event_types', 'locale']),
    )
    const robot = getRobot('rb-mid')
    expect(robot?.configRevision).toBe(0)
    expect(robot?.broadcastEventTypes).toEqual([])
    expect(robot?.broadcastToBoundUsers).toBe(false)
    expect(robot?.locale).toBe('zh')

    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(getRobot('rb-mid')?.name).toBe('mid')
  })
})

describe('schema', () => {
  it('is idempotent — re-ensuring on the same database is a no-op', () => {
    expect(ensureRobotSchema()).toBe(true)
    const robot = createRobot(input())
    resetRobotStoreForTests()
    expect(ensureRobotSchema()).toBe(true)
    expect(listRobots().map((r) => r.id)).toEqual([robot.id])
  })

  it('converges a database that predates these tables', () => {
    getDb()!.exec('CREATE TABLE IF NOT EXISTS unrelated (x TEXT)')
    getDb()!.run("INSERT INTO unrelated (x) VALUES ('keep me')")
    resetRobotStoreForTests()

    expect(ensureRobotSchema()).toBe(true)
    expect(listRobots()).toEqual([])
    expect(getDb()!.get<{ x: string }>('SELECT x FROM unrelated')!.x).toBe('keep me')
  })

  it('converges from a partially created schema', () => {
    resetDbForTests()
    resetRobotStoreForTests()
    getDb()!.exec(
      "CREATE TABLE IF NOT EXISTS im_robots (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, app_id TEXT NOT NULL, app_secret TEXT NOT NULL DEFAULT '', vendor TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', tool_allowlist TEXT NOT NULL DEFAULT '[]', require_mention INTEGER NOT NULL DEFAULT 1, chat_allowlist TEXT NOT NULL DEFAULT '[]', dm_mode TEXT NOT NULL DEFAULT 'disabled', dm_allowlist TEXT NOT NULL DEFAULT '[]', max_turn_ms INTEGER, enabled INTEGER NOT NULL DEFAULT 0, outbound_ack_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    )

    expect(ensureRobotSchema()).toBe(true)
    const robot = createRobot(input())
    const claimed = claimInboundMessage({
      platform: 'feishu',
      robotId: robot.id,
      threadKey: 'k',
      senderId: 'u1',
      bindingId: 'b1',
      subject: 'local',
      scopeHash: 'h1',
      chatId: 'c',
      vendor: 'claude',
      messageId: 'm1',
    })
    expect(claimed.kind).toBe('claimed')
    expect(
      getConversation(conversationIdentityOf('feishu', robot.id, 'k', 'u1', 'b1', 'local', 'h1')),
    ).not.toBeNull()
  })

  it('rebuilds turn indexes onto the post-busy table after outcome migration', () => {
    resetDbForTests()
    resetRobotStoreForTests()
    const d = getDb()!
    // Predates `busy` / `reject_reason`: table + the same index names INDEXES uses.
    d.exec(`CREATE TABLE im_robot_turns (
      id TEXT PRIMARY KEY,
      robot_id TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      in_message_id TEXT NOT NULL,
      session_id TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      outcome TEXT
        CHECK(outcome IS NULL OR outcome IN
          ('complete','error','blocked','timeout','guard_refused')),
      outbound_chars INTEGER NOT NULL DEFAULT 0,
      out_message_id TEXT,
      error TEXT
    )`)
    d.exec('CREATE INDEX idx_im_turn_robot ON im_robot_turns(robot_id, started_at DESC)')
    d.exec(
      'CREATE INDEX idx_im_turn_thread ON im_robot_turns(robot_id, thread_key, started_at DESC)',
    )
    d.run(
      `INSERT INTO im_robot_turns
        (id, robot_id, thread_key, chat_id, sender_id, in_message_id, started_at, outcome, outbound_chars)
       VALUES ('t1', 'r1', 'k', 'c', 'u', 'm1', 1, 'complete', 10)`,
    )

    expect(ensureRobotSchema()).toBe(true)

    expect(
      d.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'im_robot_turns_pre_busy'`,
      ),
    ).toBeUndefined()

    const indexes = d.all<{ name: string; tbl_name: string }>(
      `SELECT name, tbl_name FROM sqlite_master
       WHERE type = 'index' AND name IN ('idx_im_turn_robot', 'idx_im_turn_thread')
       ORDER BY name`,
    )
    expect(indexes).toEqual([
      { name: 'idx_im_turn_robot', tbl_name: 'im_robot_turns' },
      { name: 'idx_im_turn_thread', tbl_name: 'im_robot_turns' },
    ])

    const kept = d.get<{ outcome: string; outbound_chars: number; reject_reason: string | null }>(
      'SELECT outcome, outbound_chars, reject_reason FROM im_robot_turns WHERE id = ?',
      't1',
    )
    expect(kept).toEqual({ outcome: 'complete', outbound_chars: 10, reject_reason: null })

    const turnId = beginTurn({
      robotId: 'r1',
      threadKey: 'k',
      chatId: 'c',
      senderId: 'u',
      messageId: 'm-busy',
    })
    finishTurn(turnId, { outcome: 'busy', outboundChars: 0 })
    expect(listTurns('r1').some((t) => t.outcome === 'busy')).toBe(true)
  })
})
