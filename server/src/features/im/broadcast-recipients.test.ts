/**
 * Recipient resolution: bindings, scope, group grants, allowlists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { registerWorkspace } from '../../kernel/config/workspace-store.js'
import { LOCAL_SUBJECT } from '../auth/authorization.js'
import { putWorkspaceScope } from '../auth/scope-store.js'
import { dedupeBroadcastTargets, resolveBroadcastRecipients } from './broadcast-recipients.js'
import {
  acknowledgeOutbound,
  createRobot,
  getRobot,
  resetRobotStoreForTests,
  setRobotEnabled,
  updateRobot,
} from './robot-store.js'
import {
  resetIdentityStoreForTests,
  seedBindingForTests,
  setGroupWorkspaceScopes,
} from './identity-store.js'

let dir: string
let wsName: string

function makeWorkspace(name: string): string {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return registerWorkspace(p, name, Date.now()).name
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-im-rcpt-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = dir
  resetDbForTests()
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  wsName = makeWorkspace('wsa')
  putWorkspaceScope(LOCAL_SUBJECT, 'all', [], Date.now())
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

function enabledBroadcastRobot(): string {
  const robot = createRobot({
    name: 'bot',
    platform: 'feishu',
    appId: 'cli_app',
    appSecret: 'secret',
    vendor: 'claude',
    agentId: 'a1',
  })
  updateRobot(robot.id, {
    broadcastEventTypes: ['intent_parked'],
    broadcastToBoundUsers: true,
    broadcastGroupChatIds: ['oc_group'],
  })
  acknowledgeOutbound(robot.id)
  setRobotEnabled(robot.id, true)
  return robot.id
}

describe('resolveBroadcastRecipients', () => {
  it('returns p2p target for bound user with workspace scope', () => {
    const id = enabledBroadcastRobot()
    seedBindingForTests({
      accountNamespace: 'feishu:cli_app',
      senderId: 'ou_alice',
      subject: LOCAL_SUBJECT,
    })
    const robot = getRobot(id)!
    const targets = resolveBroadcastRecipients(robot, 'intent_parked', wsName)
    expect(targets.some((t) => t.kind === 'p2p_dm' && t.senderId === 'ou_alice')).toBe(true)
  })

  it('returns empty when event type is not enabled on robot', () => {
    const id = enabledBroadcastRobot()
    updateRobot(id, { broadcastEventTypes: [] })
    const robot = getRobot(id)!
    expect(resolveBroadcastRecipients(robot, 'intent_parked', wsName)).toEqual([])
  })

  it('group target downgrades when workspace outside group scope', () => {
    const id = enabledBroadcastRobot()
    updateRobot(id, { chatAllowlist: ['oc_group'] })
    setGroupWorkspaceScopes('admin', 'feishu', 'cli_app', 'oc_group', [wsName])
    const robot = getRobot(id)!
    const out = resolveBroadcastRecipients(robot, 'intent_parked', 'ws-other')
    expect(out.find((t) => t.kind === 'group')?.fullTemplate).toBe(false)
  })

  it('dedupes identical chat targets', () => {
    expect(
      dedupeBroadcastTargets([
        { kind: 'group', chatId: 'oc_1', fullTemplate: true },
        { kind: 'group', chatId: 'oc_1', fullTemplate: false },
      ]),
    ).toHaveLength(1)
  })
})
