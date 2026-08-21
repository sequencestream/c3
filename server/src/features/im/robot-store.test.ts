/**
 * The robot store. What is pinned here is what ADR-0046 depends on being true no
 * matter which client is talking to the server: a robot cannot be created
 * already enabled, cannot be enabled without both a credential and a recorded
 * acknowledgement, and never hands its app secret back through the read path.
 * Alongside that, the thread mapping is what makes an IM thread read as one
 * continuous conversation, and the audit records that an outbound happened
 * without recording what was said.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  RobotStoreError,
  acknowledgeOutbound,
  beginTurn,
  bindThreadSession,
  createRobot,
  deleteRobot,
  ensureRobotSchema,
  finishTurn,
  getRobot,
  getThread,
  listEnabledRobots,
  listRobots,
  listTurns,
  openThread,
  resetRobotStoreForTests,
  robotSecret,
  setRobotEnabled,
  updateRobot,
  type CreateRobotInput,
} from './robot-store.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-robot-store-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetRobotStoreForTests()
})

afterEach(() => {
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

describe('threads — one thread reads as one conversation', () => {
  it('reports no bound session on a thread first message', () => {
    const robot = createRobot(input())
    const thread = openThread({
      robotId: robot.id,
      threadKey: 'chat-1',
      chatId: 'chat-1',
      vendor: 'claude',
      messageId: 'm1',
    })
    expect(thread.sessionId).toBeNull()
    expect(thread.turnCount).toBe(0)
  })

  it('returns the PREVIOUSLY bound session on a follow-up, so the turn resumes it', () => {
    const robot = createRobot(input())
    openThread({
      robotId: robot.id,
      threadKey: 'chat-1',
      chatId: 'chat-1',
      vendor: 'claude',
      messageId: 'm1',
    })
    bindThreadSession(robot.id, 'chat-1', 'sess-9', 'claude')

    const second = openThread({
      robotId: robot.id,
      threadKey: 'chat-1',
      chatId: 'chat-1',
      vendor: 'claude',
      messageId: 'm2',
    })
    expect(second.sessionId).toBe('sess-9')
    expect(getThread(robot.id, 'chat-1')!.lastMessageId).toBe('m2')
  })

  it('keeps threads of different keys independent', () => {
    const robot = createRobot(input())
    for (const key of ['a', 'b']) {
      openThread({
        robotId: robot.id,
        threadKey: key,
        chatId: key,
        vendor: 'claude',
        messageId: `m-${key}`,
      })
    }
    bindThreadSession(robot.id, 'a', 'sess-a', 'claude')
    expect(getThread(robot.id, 'b')!.sessionId).toBeNull()
  })

  it('counts turns as they bind', () => {
    const robot = createRobot(input())
    openThread({
      robotId: robot.id,
      threadKey: 'k',
      chatId: 'c',
      vendor: 'claude',
      messageId: 'm1',
    })
    bindThreadSession(robot.id, 'k', 'sess-1', 'claude')
    bindThreadSession(robot.id, 'k', 'sess-1', 'claude')
    expect(getThread(robot.id, 'k')!.turnCount).toBe(2)
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
    expect(log).toMatchObject({ outcome: 'complete', outboundChars: 42, sessionId: 'sess-1' })
    // The whole row, as stored, must not contain anything resembling a body.
    const raw = getDb()!.get<Record<string, unknown>>(
      'SELECT * FROM im_robot_turns WHERE id = ?',
      turnId,
    )!
    expect(Object.keys(raw)).not.toContain('body')
    expect(Object.keys(raw)).not.toContain('content')
  })

  it('records the outcomes where nothing was sent', () => {
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
  it('removes the robot together with its threads and audit rows', () => {
    const robot = createRobot(input())
    openThread({
      robotId: robot.id,
      threadKey: 'k',
      chatId: 'c',
      vendor: 'claude',
      messageId: 'm1',
    })
    finishTurn(
      beginTurn({
        robotId: robot.id,
        threadKey: 'k',
        chatId: 'c',
        senderId: 'u',
        messageId: 'm1',
      }),
      { outcome: 'complete' },
    )

    deleteRobot(robot.id)

    expect(listRobots()).toEqual([])
    expect(getThread(robot.id, 'k')).toBeNull()
    expect(listTurns(robot.id)).toEqual([])
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
    // A pre-existing database with unrelated content is the "old database"
    // starting point: the tables simply appear, and nothing else is touched.
    getDb()!.exec('CREATE TABLE IF NOT EXISTS unrelated (x TEXT)')
    getDb()!.run("INSERT INTO unrelated (x) VALUES ('keep me')")
    resetRobotStoreForTests()

    expect(ensureRobotSchema()).toBe(true)
    expect(listRobots()).toEqual([])
    expect(getDb()!.get<{ x: string }>('SELECT x FROM unrelated')!.x).toBe('keep me')
  })

  it('converges from a partially created schema', () => {
    // Interrupted midway: one table exists, the others do not.
    resetDbForTests()
    resetRobotStoreForTests()
    getDb()!.exec(
      "CREATE TABLE IF NOT EXISTS im_robots (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, app_id TEXT NOT NULL, app_secret TEXT NOT NULL DEFAULT '', vendor TEXT NOT NULL, agent_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', tool_allowlist TEXT NOT NULL DEFAULT '[]', require_mention INTEGER NOT NULL DEFAULT 1, chat_allowlist TEXT NOT NULL DEFAULT '[]', dm_mode TEXT NOT NULL DEFAULT 'disabled', dm_allowlist TEXT NOT NULL DEFAULT '[]', max_turn_ms INTEGER, enabled INTEGER NOT NULL DEFAULT 0, outbound_ack_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    )

    expect(ensureRobotSchema()).toBe(true)
    const robot = createRobot(input())
    openThread({
      robotId: robot.id,
      threadKey: 'k',
      chatId: 'c',
      vendor: 'claude',
      messageId: 'm1',
    })
    expect(getThread(robot.id, 'k')).not.toBeNull()
  })
})
