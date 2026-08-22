/**
 * Per-call IM workspace scope: binding subject validity, personal scope, and group
 * whitelist intersection. Complements authorization.test.ts by exercising the IM
 * resolver path end to end.
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
import { removeAccount } from '../auth/index.js'
import type { Conn } from '../../transport/handler-registry.js'
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
import { chatContextFor, resolveCallScope } from './call-scope.js'

let dir: string

function mockConn(subject: string): Conn {
  return {
    send: () => {},
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
    authed: true,
    authToken: 'tok',
    subject,
  }
}

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

function bootRobot(): { robotId: string; ns: string } {
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
  return { robotId: robot.id, ns: accountNamespaceOf('feishu', 'cli_app') }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-call-scope-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = dir
  useConfigDb(dir)
  resetDbForTests()
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  resetWorkspaceScopeStoreForTests()
})

afterEach(() => {
  releaseConfigDb()
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  resetWorkspaceScopeStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveCallScope — subject validity', () => {
  it('returns empty detail workspaces after a bound account is removed from the roster', () => {
    useBasicAuth('root', 'bob')
    const alpha = makeWorkspace('alpha')
    putWorkspaceScope('bob', 'selected', [alpha], 1)
    const { robotId, ns } = bootRobot()
    seedBindingForTests({ accountNamespace: ns, senderId: 'ou_bob', subject: 'bob' })

    const before = resolveCallScope({
      robotId,
      senderId: 'ou_bob',
      chat: chatContextFor('feishu', 'cli_app', 'p2p', 'ou_bob'),
    })
    expect(before.ok).toBe(true)
    if (before.ok) {
      expect(before.scope.detailWorkspaces.map((w) => w.name)).toEqual([alpha])
    }

    removeAccount({} as never, mockConn('root'), { type: 'remove_account', username: 'bob' })

    const after = resolveCallScope({
      robotId,
      senderId: 'ou_bob',
      chat: chatContextFor('feishu', 'cli_app', 'p2p', 'ou_bob'),
    })
    expect(after.ok).toBe(true)
    if (after.ok) {
      expect(after.scope.detailWorkspaces).toEqual([])
      expect(after.scope.personalWorkspaces).toEqual([])
    }
  })
})

describe('resolveCallScope — personal scope modes', () => {
  it('honours selected and all modes for a bound subject', () => {
    useBasicAuth('root', 'alice')
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    putWorkspaceScope('alice', 'selected', [alpha], 1)
    const { robotId, ns } = bootRobot()
    seedBindingForTests({ accountNamespace: ns, senderId: 'ou_alice', subject: 'alice' })
    const chat = chatContextFor('feishu', 'cli_app', 'p2p', 'ou_alice')

    const selected = resolveCallScope({ robotId, senderId: 'ou_alice', chat })
    expect(selected.ok && selected.scope.detailWorkspaces.map((w) => w.name)).toEqual([alpha])

    putWorkspaceScope('alice', 'all', [], 2)
    const all = resolveCallScope({ robotId, senderId: 'ou_alice', chat })
    expect(all.ok && all.scope.detailWorkspaces.map((w) => w.name).sort()).toEqual(
      [alpha, beta].sort(),
    )

    putWorkspaceScope('alice', 'selected', [], 3)
    const empty = resolveCallScope({ robotId, senderId: 'ou_alice', chat })
    expect(empty.ok && empty.scope.detailWorkspaces).toEqual([])
  })
})

describe('resolveCallScope — group whitelist intersection', () => {
  it('returns only workspaces in both personal scope and the group whitelist', () => {
    useBasicAuth('root', 'alice')
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    putWorkspaceScope('alice', 'all', [], 1)
    const { robotId, ns } = bootRobot()
    seedBindingForTests({ accountNamespace: ns, senderId: 'ou_alice', subject: 'alice' })
    setGroupWorkspaceScopes('root', 'feishu', 'cli_app', 'oc_group', [alpha])

    const scope = resolveCallScope({
      robotId,
      senderId: 'ou_alice',
      chat: chatContextFor('feishu', 'cli_app', 'group', 'oc_group'),
    })
    expect(scope.ok).toBe(true)
    if (scope.ok) {
      expect(scope.scope.personalWorkspaces.map((w) => w.name).sort()).toEqual([alpha, beta].sort())
      expect(scope.scope.detailWorkspaces.map((w) => w.name)).toEqual([alpha])
    }
  })
})
