import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthConfig } from '@ccc/shared/protocol'
import { initTestGitRepo } from '../../../test/git-repo.js'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import {
  loadSettings,
  resetSettingsCacheForTests,
  saveSettings,
  saveWorkspaceSetting,
} from '../../kernel/config/index.js'
import { registerWorkspace } from '../../kernel/config/workspace-store.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { removeRuntimesForWorkspace } from '../../runs.js'
import { resetStateCacheForTests } from '../../state.js'
import { hashPassword } from '../auth/password.js'
import { putWorkspaceScope, resetWorkspaceScopeStoreForTests } from '../auth/scope-store.js'
import {
  createDiscussion,
  resetStoreForTests as resetDiscussionStoreForTests,
} from '../discussions/store.js'
import {
  findIntents,
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecPath,
} from '../intents/store.js'
import {
  accountNamespaceOf,
  resetIdentityStoreForTests,
  seedBindingForTests,
  setGroupWorkspaceScopes,
} from './identity-store.js'
import { chatContextFor, NOT_VISIBLE_RESULT, resolveCallScope } from './call-scope.js'
import { createRobot, resetRobotStoreForTests } from './robot-store.js'
import type { RobotL1AuthContext } from './robot-l1-tools.js'
import {
  buildRobotWriteTools,
  ROBOT_WRITE_TOOL_NAMES,
  type RobotWriteMcpDeps,
} from './robot-write-tools.js'

let dir: string
let alphaName: string
let betaName: string
let alphaPath: string
let betaPath: string

function useBasicAuth(...usernames: string[]): void {
  const auth: AuthConfig = {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: usernames.map((username) => ({ username, passwordHash: hashPassword('pw') })),
      adminUsername: usernames[0],
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
  }
  saveSettings({ ...loadSettings(), auth })
}

function makeWorkspace(name: string): { name: string; path: string } {
  const path = join(dir, name)
  mkdirSync(path, { recursive: true })
  initTestGitRepo(path)
  return { name: registerWorkspace(path, name, Date.now()).name, path }
}

function setupAuth(chatType: 'group' | 'p2p' = 'p2p'): {
  auth: RobotL1AuthContext
  robotId: string
} {
  const robot = createRobot({
    name: 'helper',
    platform: 'feishu',
    appId: 'cli_app',
    appSecret: 'secret',
    vendor: 'claude',
    agentId: 'agent-1',
  })
  const senderId = 'ou_alice'
  const chatId = chatType === 'group' ? 'oc_group' : senderId
  const binding = seedBindingForTests({
    accountNamespace: accountNamespaceOf('feishu', 'cli_app'),
    senderId,
    subject: 'alice',
  })
  const chat = chatContextFor('feishu', 'cli_app', chatType, chatId)
  const scope = resolveCallScope({ robotId: robot.id, senderId, chat })
  expect(scope.ok).toBe(true)
  if (!scope.ok) throw new Error('scope setup failed')
  return {
    robotId: robot.id,
    auth: {
      robotId: robot.id,
      senderId,
      chat,
      expectedBindingId: binding.id,
      turnStartScopeHash: scope.scope.scopeHash,
    },
  }
}

function deps(): RobotWriteMcpDeps & {
  broadcastIntents: ReturnType<typeof vi.fn>
  broadcastDiscussions: ReturnType<typeof vi.fn>
  broadcastDiscussionMessage: ReturnType<typeof vi.fn>
  startDiscussionRun: ReturnType<typeof vi.fn>
  launchRun: ReturnType<typeof vi.fn>
} {
  return {
    broadcastIntents: vi.fn(),
    broadcastDiscussions: vi.fn(),
    broadcastDiscussionMessage: vi.fn(),
    startDiscussionRun: vi.fn(),
    launchRun: vi.fn().mockResolvedValue(undefined),
  }
}

function toolArgs(
  name: (typeof ROBOT_WRITE_TOOL_NAMES)[number],
  ids: {
    intentId: string
    discussionId: string
  },
): Record<string, unknown> {
  switch (name) {
    case 'save_intents':
      return {
        workspaceName: betaName,
        intents: [{ title: 'x', shortEnTitle: 'x', content: 'x', priority: 'P2' }],
      }
    case 'save_intent_directly':
      return {
        workspaceName: betaName,
        intents: [{ title: 'x', shortEnTitle: 'x', content: 'x', priority: 'P2' }],
      }
    case 'submit_spec_review':
      return { intentId: ids.intentId, verdict: 'pass', reason: 'ok' }
    case 'start_session_for_intent':
      return { intentId: ids.intentId, sessionType: 'work' }
    case 'start_discussion':
      return { discussionId: ids.discussionId }
    case 'continue_discussion':
      return { discussionId: ids.discussionId, text: 'again' }
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-robot-write-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3-home')
  useConfigDb(dir)
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  resetWorkspaceScopeStoreForTests()
  resetStoreForTests()
  resetDiscussionStoreForTests()
  useBasicAuth('root', 'alice')
  ;({ name: alphaName, path: alphaPath } = makeWorkspace('alpha'))
  ;({ name: betaName, path: betaPath } = makeWorkspace('beta'))
})

afterEach(() => {
  removeRuntimesForWorkspace(alphaPath)
  removeRuntimesForWorkspace(betaPath)
  releaseConfigDb()
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  resetWorkspaceScopeStoreForTests()
  resetStoreForTests()
  resetDiscussionStoreForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('buildRobotWriteTools — visible targets', () => {
  it('saves confirmed intents and drafts only in the explicit registered workspace', async () => {
    putWorkspaceScope('alice', 'selected', [alphaName], 1)
    const { auth } = setupAuth()
    const callbacks = deps()
    const tools = buildRobotWriteTools(
      auth,
      () => 'robot-run-1',
      () => callbacks,
    )
    const saveTool = tools.find((t) => t.name === 'save_intents')!
    const directTool = tools.find((t) => t.name === 'save_intent_directly')!
    expect(saveTool.description).toContain('Why')
    expect(saveTool.description).toContain('Acceptance')
    expect(saveTool.description).toContain('须明示旧值→新值并获得用户文字明确确认')
    expect(saveTool.description).not.toContain('可用 intentSessionId 把它回链')
    expect(saveTool.inputSchema).toHaveProperty('workspaceName')
    expect(JSON.stringify(saveTool.inputSchema)).toContain('status')
    expect(JSON.stringify(saveTool.inputSchema)).toContain('automate')
    expect(directTool.description).toContain('Trade-offs / Non-goals')
    expect(JSON.stringify(directTool.inputSchema)).not.toContain('status')
    expect(JSON.stringify(directTool.inputSchema)).not.toContain('automate')

    const saved = await saveTool.handler({
      workspaceName: alphaName,
      intents: [
        {
          title: 'Confirmed',
          shortEnTitle: 'confirmed',
          content: 'body',
          priority: 'P1',
          intentSessionId: 'forged-session-link',
          status: 'todo',
          automate: true,
        },
      ],
    })
    const drafted = await directTool.handler({
      workspaceName: alphaName,
      intents: [
        {
          title: 'Drafted',
          shortEnTitle: 'drafted',
          content: 'body',
          priority: 'P2',
          status: 'todo',
          automate: true,
        },
      ],
    })

    expect(saved.isError).not.toBe(true)
    expect(drafted.isError).not.toBe(true)
    expect(JSON.stringify([saved, drafted])).not.toContain('web_only')
    const alphaRows = findIntents(alphaPath, {})
    expect(alphaRows.map((row) => row.status).sort()).toEqual(['draft', 'todo'])
    expect(alphaRows.find((row) => row.title === 'Confirmed')?.automate).toBe(true)
    expect(alphaRows.find((row) => row.title === 'Drafted')?.automate).toBe(false)
    expect(alphaRows.find((row) => row.title === 'Confirmed')?.intentSessionId).toBeNull()
    expect(findIntents(betaPath, {})).toEqual([])
    expect(callbacks.broadcastIntents).toHaveBeenCalledTimes(2)
    expect(callbacks.broadcastIntents).toHaveBeenCalledWith(alphaPath)
    expect(callbacks.broadcastIntents).not.toHaveBeenCalledWith(join(dir, 'robots', 'helper'))
  })

  it('reaches the real spec-review, session-launch and discussion handlers', async () => {
    putWorkspaceScope('alice', 'selected', [alphaName], 1)
    saveWorkspaceSetting(alphaPath, { gitBranchMode: 'current-branch', sddEnabled: false })
    const { auth } = setupAuth()
    const callbacks = deps()
    const tools = buildRobotWriteTools(
      auth,
      () => 'robot-run-live',
      () => callbacks,
    )
    const [reviewIntent, launchIntent] = insertIntents(alphaPath, [
      { title: 'Review', shortEnTitle: 'review', content: 'body', priority: 'P1' },
      { title: 'Launch', shortEnTitle: 'launch', content: 'body', priority: 'P1' },
    ])
    const specFile = join(dir, 'review.md')
    writeFileSync(specFile, '# reviewed spec', 'utf8')
    setSpecPath(reviewIntent.id, specFile)
    const draft = createDiscussion({ workspacePath: alphaPath, title: 'draft', type: 'design' })
    const hanging = createDiscussion({
      workspacePath: alphaPath,
      title: 'hanging',
      type: 'design',
      status: 'in_progress',
    })

    const review = await tools
      .find((t) => t.name === 'submit_spec_review')!
      .handler({
        intentId: reviewIntent.id,
        verdict: 'pass',
        reason: 'matches the implementation',
      })
    const launch = await tools
      .find((t) => t.name === 'start_session_for_intent')!
      .handler({
        intentId: launchIntent.id,
        sessionType: 'work',
      })
    const start = await tools
      .find((t) => t.name === 'start_discussion')!
      .handler({ discussionId: draft.id })
    const continued = await tools
      .find((t) => t.name === 'continue_discussion')!
      .handler({ discussionId: hanging.id })

    for (const result of [review, launch, start, continued]) {
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result)).not.toContain('web_only')
    }
    expect(getIntent(reviewIntent.id)?.specReviewSessionId).toBe('robot-run-live')
    expect(getIntent(reviewIntent.id)?.specReviewVerdict).toBe('pass')
    expect(callbacks.launchRun).toHaveBeenCalledTimes(1)
    expect(callbacks.startDiscussionRun).toHaveBeenCalledTimes(2)
  })

  it('rejects a spec review when the spec changes between the robot read and core commit', async () => {
    putWorkspaceScope('alice', 'selected', [alphaName], 1)
    const { auth } = setupAuth()
    const callbacks = deps()
    const [intent] = insertIntents(alphaPath, [
      { title: 'Review', shortEnTitle: 'review', content: 'body', priority: 'P1' },
    ])
    const specFile = join(dir, 'stale-review.md')
    writeFileSync(specFile, 'v1', 'utf8')
    setSpecPath(intent.id, specFile)
    const tools = buildRobotWriteTools(
      auth,
      () => {
        writeFileSync(specFile, 'v2 changed during submit', 'utf8')
        return 'robot-run-stale'
      },
      () => callbacks,
    )

    const result = await tools
      .find((t) => t.name === 'submit_spec_review')!
      .handler({
        intentId: intent.id,
        verdict: 'pass',
        reason: 'judged v1',
      })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('已被改写')
    const after = getIntent(intent.id)!
    expect(after.specReviewVerdict).toBeNull()
    expect(after.specReviewReason).toBeNull()
    expect(after.specReviewSessionId).toBeNull()
    expect(after.specReviewReworkRounds).toBe(0)
  })
})

describe('buildRobotWriteTools — call-level scope', () => {
  it('fails closed when composition dependencies are not ready', async () => {
    putWorkspaceScope('alice', 'selected', [alphaName], 1)
    const { auth } = setupAuth()
    const save = buildRobotWriteTools(
      auth,
      () => 'run',
      () => null,
    ).find((tool) => tool.name === 'save_intents')!

    const result = await save.handler({ workspaceName: alphaName, intents: [] })

    expect(JSON.parse(result.content[0]!.text!)).toEqual({ code: 'robot_mcp_not_ready' })
    expect(result.isError).toBe(true)
    expect(findIntents(alphaPath, {})).toEqual([])
  })

  it('rejects cross-workspace upserts and dependency edges atomically', async () => {
    putWorkspaceScope('alice', 'selected', [alphaName], 1)
    const { auth } = setupAuth()
    const callbacks = deps()
    const tools = buildRobotWriteTools(
      auth,
      () => 'run',
      () => callbacks,
    )
    const [foreign] = insertIntents(betaPath, [
      { title: 'foreign', shortEnTitle: 'foreign', content: 'body', priority: 'P2' },
    ])

    for (const [name, intents] of [
      [
        'save_intents',
        [
          {
            id: foreign.id,
            title: 'rewrite',
            shortEnTitle: 'rewrite',
            content: 'x',
            priority: 'P2',
          },
          { title: 'partial', shortEnTitle: 'partial', content: 'x', priority: 'P2' },
        ],
      ],
      [
        'save_intent_directly',
        [
          {
            title: 'foreign edge',
            shortEnTitle: 'foreign-edge',
            content: 'x',
            priority: 'P2',
            dependsOn: [foreign.id],
          },
        ],
      ],
    ] as const) {
      const result = await tools
        .find((t) => t.name === name)!
        .handler({
          workspaceName: alphaName,
          intents,
        })
      expect(JSON.parse(result.content[0]!.text!)).toEqual(NOT_VISIBLE_RESULT)
    }
    expect(findIntents(alphaPath, {})).toEqual([])
    expect(getIntent(foreign.id)?.title).toBe('foreign')
    expect(callbacks.broadcastIntents).not.toHaveBeenCalled()
  })

  it('rejects all six tools outside the group detail intersection before side effects', async () => {
    putWorkspaceScope('alice', 'all', [], 1)
    setGroupWorkspaceScopes('root', 'feishu', 'cli_app', 'oc_group', [alphaName])
    const { auth } = setupAuth('group')
    const callbacks = deps()
    const tools = buildRobotWriteTools(
      auth,
      () => 'run',
      () => callbacks,
    )
    const [foreignIntent] = insertIntents(betaPath, [
      { title: 'foreign', shortEnTitle: 'foreign', content: 'body', priority: 'P2' },
    ])
    const foreignDiscussion = createDiscussion({
      workspacePath: betaPath,
      title: 'foreign',
      type: 'design',
      status: 'in_progress',
    })

    for (const name of ROBOT_WRITE_TOOL_NAMES) {
      const result = await tools
        .find((tool) => tool.name === name)!
        .handler(toolArgs(name, { intentId: foreignIntent.id, discussionId: foreignDiscussion.id }))
      expect(JSON.parse(result.content[0]!.text!)).toEqual(NOT_VISIBLE_RESULT)
      expect(JSON.stringify(result)).not.toContain('web_only')
    }
    expect(findIntents(betaPath, {})).toHaveLength(1)
    expect(callbacks.broadcastIntents).not.toHaveBeenCalled()
    expect(callbacks.broadcastDiscussions).not.toHaveBeenCalled()
    expect(callbacks.broadcastDiscussionMessage).not.toHaveBeenCalled()
    expect(callbacks.startDiscussionRun).not.toHaveBeenCalled()
    expect(callbacks.launchRun).not.toHaveBeenCalled()
  })

  it('returns scope_changed for all six tools after policy changes and writes nothing', async () => {
    putWorkspaceScope('alice', 'selected', [alphaName], 1)
    const { auth } = setupAuth()
    const callbacks = deps()
    const tools = buildRobotWriteTools(
      auth,
      () => 'run',
      () => callbacks,
    )
    const [intent] = insertIntents(alphaPath, [
      { title: 'intent', shortEnTitle: 'intent', content: 'body', priority: 'P2' },
    ])
    const discussion = createDiscussion({ workspacePath: alphaPath, title: 'd', type: 'design' })
    putWorkspaceScope('alice', 'selected', [betaName], 2)

    for (const name of ROBOT_WRITE_TOOL_NAMES) {
      const args = toolArgs(name, { intentId: intent.id, discussionId: discussion.id })
      if ('workspaceName' in args) args.workspaceName = alphaName
      const result = await tools.find((tool) => tool.name === name)!.handler(args)
      expect(JSON.parse(result.content[0]!.text!)).toEqual({ code: 'scope_changed' })
      expect(result.isError).toBe(true)
    }
    expect(findIntents(alphaPath, {})).toHaveLength(1)
    expect(callbacks.broadcastIntents).not.toHaveBeenCalled()
    expect(callbacks.startDiscussionRun).not.toHaveBeenCalled()
    expect(callbacks.launchRun).not.toHaveBeenCalled()
  })
})
