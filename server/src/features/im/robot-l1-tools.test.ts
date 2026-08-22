/**
 * Call-level L1 read tools for IM robots: object reverse-lookup, multi-workspace
 * enumeration, group hiddenCount projection, mid-turn scope change, and write refusal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthConfig } from '@ccc/shared/protocol'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import { registerWorkspace } from '../../kernel/config/workspace-store.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { hashPassword } from '../auth/password.js'
import { putWorkspaceScope, resetWorkspaceScopeStoreForTests } from '../auth/scope-store.js'
import { insertIntents, resetStoreForTests } from '../intents/store.js'
import {
  acknowledgeOutbound,
  createRobot,
  resetRobotStoreForTests,
  setRobotEnabled,
} from './robot-store.js'
import {
  accountNamespaceOf,
  resetIdentityStoreForTests,
  seedBindingForTests,
  setGroupWorkspaceScopes,
} from './identity-store.js'
import {
  chatContextFor,
  computeScopeHash,
  NOT_VISIBLE_RESULT,
  resolveCallScope,
} from './call-scope.js'
import {
  buildRobotL1Tools,
  refuseWriteViaObjectId,
  type RobotL1AuthContext,
} from './robot-l1-tools.js'

let dir: string

function useBasicAuth(...usernames: string[]): void {
  const auth: AuthConfig = {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: usernames.map((username) => ({
        username,
        passwordHash: hashPassword('pw'),
      })),
      adminUsername: usernames[0],
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
  }
  saveSettings({ ...loadSettings(), auth })
}

function makeWorkspace(name: string): string {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return registerWorkspace(p, name, Date.now()).name
}

function authCtx(input: {
  robotId: string
  senderId: string
  chatType: 'group' | 'p2p'
  chatId: string
  bindingId: string
  scopeHash: string
}): RobotL1AuthContext {
  return {
    robotId: input.robotId,
    senderId: input.senderId,
    chat: chatContextFor('feishu', 'cli_app', input.chatType, input.chatId),
    expectedBindingId: input.bindingId,
    turnStartScopeHash: input.scopeHash,
    onScopeChanged: () => {},
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-robot-l1-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = dir
  useConfigDb(dir)
  resetDbForTests()
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  resetWorkspaceScopeStoreForTests()
  resetStoreForTests()
})

afterEach(() => {
  releaseConfigDb()
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  resetWorkspaceScopeStoreForTests()
  resetStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('buildRobotL1Tools — object tools', () => {
  it('returns the same not_visible shape for missing and out-of-scope intents', async () => {
    useBasicAuth('root', 'alice')
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    putWorkspaceScope('alice', 'selected', [alpha], 1)
    const robot = createRobot({
      name: 'helper',
      platform: 'feishu',
      appId: 'cli_app',
      appSecret: 'secret',
      vendor: 'claude',
      agentId: 'agent-1',
    })
    acknowledgeOutbound(robot.id)
    setRobotEnabled(robot.id, true)
    const ns = accountNamespaceOf('feishu', 'cli_app')
    const binding = seedBindingForTests({
      accountNamespace: ns,
      senderId: 'ou_alice',
      subject: 'alice',
    })
    const chat = chatContextFor('feishu', 'cli_app', 'p2p', 'ou_alice')
    const scope = resolveCallScope({ robotId: robot.id, senderId: 'ou_alice', chat })
    expect(scope.ok).toBe(true)
    if (!scope.ok) return

    const [inScope] = insertIntents(join(dir, alpha), [
      { title: 'in', content: 'c', priority: 'P2', shortEnTitle: 'in' },
    ])
    const [foreign] = insertIntents(join(dir, beta), [
      { title: 'out', content: 'c', priority: 'P2', shortEnTitle: 'out' },
    ])
    const tools = buildRobotL1Tools(
      authCtx({
        robotId: robot.id,
        senderId: 'ou_alice',
        chatType: 'p2p',
        chatId: 'ou_alice',
        bindingId: binding.id,
        scopeHash: scope.scope.scopeHash,
      }),
    )
    const view = tools.find((t) => t.name === 'view_intent')!

    const allowed = await view.handler({ id: inScope!.id })
    expect(JSON.stringify(allowed.content)).not.toContain(NOT_VISIBLE_RESULT.code)

    for (const id of [foreign!.id, '00000000-0000-4000-8000-000000000000']) {
      const denied = await view.handler({ id })
      expect(JSON.parse(denied.content[0]!.text!)).toEqual(NOT_VISIBLE_RESULT)
    }
  })
})

describe('buildRobotL1Tools — list tools', () => {
  it('merges multiple workspaces and annotates workspaceName on each row', async () => {
    useBasicAuth('root', 'alice')
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    putWorkspaceScope('alice', 'all', [], 1)
    const robot = createRobot({
      name: 'helper',
      platform: 'feishu',
      appId: 'cli_app',
      appSecret: 'secret',
      vendor: 'claude',
      agentId: 'agent-1',
    })
    const ns = accountNamespaceOf('feishu', 'cli_app')
    const binding = seedBindingForTests({
      accountNamespace: ns,
      senderId: 'ou_alice',
      subject: 'alice',
    })
    const chat = chatContextFor('feishu', 'cli_app', 'p2p', 'ou_alice')
    const scope = resolveCallScope({ robotId: robot.id, senderId: 'ou_alice', chat })
    expect(scope.ok).toBe(true)
    if (!scope.ok) return

    insertIntents(join(dir, alpha), [
      { title: 'alpha intent', content: 'c', priority: 'P2', shortEnTitle: 'a' },
    ])
    insertIntents(join(dir, beta), [
      { title: 'beta intent', content: 'c', priority: 'P2', shortEnTitle: 'b' },
    ])

    const find = buildRobotL1Tools(
      authCtx({
        robotId: robot.id,
        senderId: 'ou_alice',
        chatType: 'p2p',
        chatId: 'ou_alice',
        bindingId: binding.id,
        scopeHash: scope.scope.scopeHash,
      }),
    ).find((t) => t.name === 'find_intents')!
    const result = await find.handler({})
    const body = result.content[0]!.text!
    expect(body).toContain(alpha)
    expect(body).toContain(beta)
    expect(body).toContain('workspaceName')
  })

  it('projects hiddenCount for group matches outside the whitelist', async () => {
    useBasicAuth('root', 'alice')
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    putWorkspaceScope('alice', 'all', [], 1)
    const robot = createRobot({
      name: 'helper',
      platform: 'feishu',
      appId: 'cli_app',
      appSecret: 'secret',
      vendor: 'claude',
      agentId: 'agent-1',
    })
    const ns = accountNamespaceOf('feishu', 'cli_app')
    const binding = seedBindingForTests({
      accountNamespace: ns,
      senderId: 'ou_alice',
      subject: 'alice',
    })
    setGroupWorkspaceScopes('root', 'feishu', 'cli_app', 'oc_group', [alpha])
    insertIntents(join(dir, alpha), [
      { title: 'visible', content: 'c', priority: 'P2', shortEnTitle: 'v' },
    ])
    insertIntents(join(dir, beta), [
      { title: 'hidden', content: 'c', priority: 'P2', shortEnTitle: 'h' },
    ])

    const chat = chatContextFor('feishu', 'cli_app', 'group', 'oc_group')
    const scope = resolveCallScope({ robotId: robot.id, senderId: 'ou_alice', chat })
    expect(scope.ok).toBe(true)
    if (!scope.ok) return

    const find = buildRobotL1Tools(
      authCtx({
        robotId: robot.id,
        senderId: 'ou_alice',
        chatType: 'group',
        chatId: 'oc_group',
        bindingId: binding.id,
        scopeHash: scope.scope.scopeHash,
      }),
    ).find((t) => t.name === 'find_intents')!
    const result = await find.handler({})
    const body = result.content[0]!.text!
    const payload = JSON.parse(body.slice(body.indexOf('{'))) as {
      items: { workspaceName: string }[]
      hiddenCount: number
    }
    expect(payload.hiddenCount).toBe(1)
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].workspaceName).toBe(alpha)
    expect(JSON.stringify(payload)).not.toContain(beta)
  })
})

describe('buildRobotL1Tools — scope freshness', () => {
  it('returns scope_changed when policy epoch moves mid-turn', async () => {
    useBasicAuth('root', 'alice')
    makeWorkspace('alpha')
    putWorkspaceScope('alice', 'all', [], 1)
    const robot = createRobot({
      name: 'helper',
      platform: 'feishu',
      appId: 'cli_app',
      appSecret: 'secret',
      vendor: 'claude',
      agentId: 'agent-1',
    })
    const ns = accountNamespaceOf('feishu', 'cli_app')
    const binding = seedBindingForTests({
      accountNamespace: ns,
      senderId: 'ou_alice',
      subject: 'alice',
    })
    const chat = chatContextFor('feishu', 'cli_app', 'p2p', 'ou_alice')
    const atStart = resolveCallScope({ robotId: robot.id, senderId: 'ou_alice', chat })
    expect(atStart.ok).toBe(true)
    if (!atStart.ok) return

    putWorkspaceScope('alice', 'selected', [], 2)
    const staleHash = atStart.scope.scopeHash
    const view = buildRobotL1Tools(
      authCtx({
        robotId: robot.id,
        senderId: 'ou_alice',
        chatType: 'p2p',
        chatId: 'ou_alice',
        bindingId: binding.id,
        scopeHash: staleHash,
      }),
    ).find((t) => t.name === 'view_intent')!
    const result = await view.handler({ id: '00000000-0000-4000-8000-000000000000' })
    expect(JSON.parse(result.content[0]!.text!)).toEqual({ code: 'scope_changed' })
    expect(result.isError).toBe(true)

    const fresh = resolveCallScope({ robotId: robot.id, senderId: 'ou_alice', chat })
    expect(fresh.ok && fresh.scope.scopeHash).not.toBe(staleHash)
    expect(
      computeScopeHash({
        subject: binding.subject,
        bindingId: binding.id,
        policyEpoch: fresh.ok ? fresh.scope.policyEpoch : 0,
        chatType: 'p2p',
        groupKey: null,
        detailWorkspaceNames: [],
      }),
    ).toBe(fresh.ok ? fresh.scope.scopeHash : '')
  })
})

describe('refuseWriteViaObjectId', () => {
  it('never grants a workspace path for write-class tools', () => {
    const result = refuseWriteViaObjectId()
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ code: 'web_only' })
    expect(result.isError).toBe(true)
  })
})
