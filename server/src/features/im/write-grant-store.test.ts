/**
 * Write grant store — per-capability L2 authorization independent from outbound ack.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { createRobot, ensureRobotSchema, getRobot, resetRobotStoreForTests } from './robot-store.js'
import {
  WriteGrantStoreError,
  acknowledgeWriteCapability,
  isWriteGrantActive,
  listWriteGrantsForRobot,
  resetWriteGrantStoreForTests,
  setWriteGrantEnabled,
  setWriteGrantStoreClockForTests,
} from './write-grant-store.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-write-grant-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetRobotStoreForTests()
  resetWriteGrantStoreForTests()
  ensureRobotSchema()
})

afterEach(() => {
  setWriteGrantStoreClockForTests(null)
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetRobotStoreForTests()
  resetWriteGrantStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

function createTestRobot() {
  return createRobot({
    name: 'helper',
    platform: 'feishu',
    appId: 'cli_app',
    appSecret: 'secret',
    vendor: 'claude',
    agentId: 'agent-1',
  })
}

function refuses(fn: () => unknown, code: string): WriteGrantStoreError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(WriteGrantStoreError)
    expect((err as WriteGrantStoreError).code).toBe(code)
    return err as WriteGrantStoreError
  }
  throw new Error(`expected refusal ${code}`)
}

describe('write grant store', () => {
  it('lists missing grants as unauthorized and inactive', () => {
    const robot = createTestRobot()
    const grants = listWriteGrantsForRobot(robot)
    expect(grants.find((g) => g.capability === 'queue_respond')).toMatchObject({
      status: 'unauthorized',
      enabled: false,
    })
    expect(isWriteGrantActive(robot, 'queue_respond')).toBe(false)
  })

  it('refuses dev_start and unknown capabilities', () => {
    const robot = createTestRobot()
    refuses(
      () => acknowledgeWriteCapability(robot.id, 'dev_start', 'admin'),
      'capability_not_grantable',
    )
    refuses(() => setWriteGrantEnabled(robot.id, 'dev_start', true), 'capability_not_grantable')
  })

  it('acknowledges each writable capability independently', () => {
    const robot = createTestRobot()
    setWriteGrantStoreClockForTests(() => 1_700_000_000_000)
    acknowledgeWriteCapability(robot.id, 'queue_respond', 'admin-a')
    const updated = getRobot(robot.id)!
    const grants = listWriteGrantsForRobot(updated)
    const queue = grants.find((g) => g.capability === 'queue_respond')!
    expect(queue.status).toBe('active')
    expect(queue.acknowledgedBy).toBe('admin-a')
    expect(queue.writeAckAt).toBe(1_700_000_000_000)
    expect(isWriteGrantActive(updated, 'queue_respond')).toBe(true)
    expect(isWriteGrantActive(updated, 'automation_control')).toBe(false)
  })

  it('disable stops active grant without deleting acknowledgement', () => {
    const robot = createTestRobot()
    acknowledgeWriteCapability(robot.id, 'annotate', 'admin')
    setWriteGrantEnabled(robot.id, 'annotate', false)
    const updated = getRobot(robot.id)!
    const grant = listWriteGrantsForRobot(updated).find((g) => g.capability === 'annotate')!
    expect(grant.status).toBe('disabled')
    expect(isWriteGrantActive(updated, 'annotate')).toBe(false)
  })

  it('cannot enable before acknowledge', () => {
    const robot = createTestRobot()
    refuses(() => setWriteGrantEnabled(robot.id, 'queue_respond', true), 'capability_invalid')
  })
})
