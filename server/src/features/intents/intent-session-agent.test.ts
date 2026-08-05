/**
 * Intent-communication sessions run on the **intent agent**, not the default one.
 *
 * The contract has two halves, and the four layers that describe a session — the
 * binding fact, the `session_metadata` projection, the `session_selected` title-bar
 * payload, and the resolved launch — must always agree on ONE of them:
 *  - a session created here (add intent / open with none / refine / reset /
 *    discussion→intent) adopts the CURRENT `intentAgentId` (empty ⇒ follow the
 *    default agent);
 *  - a session that already carries a binding RESUMES on it — reopening is not a
 *    re-binding, so changing `intentAgentId` never re-targets a live conversation,
 *    cross-vendor or same-vendor. An explicit reset is how the new config is adopted.
 *
 * Also pins the non-goal: default / tool / spec / spec-review routing is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, ServerToClient, SystemSettings } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { removeRuntime } from '../../runs.js'
import {
  bindSessionAgent,
  getSessionAgentId,
  resetSettingsCacheForTests,
  saveSettings,
} from '../../kernel/config/index.js'
import {
  resolveSessionLaunch,
  resolveSpecAgent,
  resolveSpecReviewAgent,
  resolveToolAgent,
  resolveAgent,
} from '../../kernel/agent-config/index.js'
import {
  listAll,
  resetStoreForTests as resetSessionMetadataStoreForTests,
} from '../sessions/session-metadata-store.js'
import {
  createDiscussion,
  resetStoreForTests as resetDiscussionStoreForTests,
  setConclusion,
} from '../discussions/store.js'
import { resetStoreForTests as resetUserInvolveStoreForTests } from '../user-involve/store.js'
import {
  discussionToIntent,
  newIntentSession,
  openIntentSession,
  openSpecSession,
  refineIntent,
  resetIntentSession,
  startIntentSession,
} from './index.js'
import {
  insertIntents,
  resetStoreForTests,
  setChatSession,
  setSpecPath,
  setSpecSessionId,
} from './store.js'
import { resetForTests as resetIntentLink } from './intent-link.js'

const CLAUDE_A = 'claude-a'
const CLAUDE_B = 'claude-b'
const CURSOR = 'cursor-1'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string
/** Every session id a test opened, so the runtime registry is left clean. */
let opened: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-intent-session-agent-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetDiscussionStoreForTests()
  // The action-descriptor projection reads the wait-user store, so its
  // "schema ensured" flag must follow the recreated db too.
  resetUserInvolveStoreForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
  opened = []
})

afterEach(() => {
  for (const id of opened) removeRuntime(id)
  resetDbForTests()
  resetSessionMetadataStoreForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  resetIntentLink()
  delete process.env.CLAUDE_CONFIG_DIR
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function claudeAgent(id: string, displayName: string, order: number): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'system',
    displayName,
    config: { baseUrl: '', apiKey: '', model: '' },
    enabled: true,
    order_seq: order,
  }
}

function cursorAgent(id: string, order: number): AgentConfig {
  return {
    id,
    vendor: 'cursor',
    configMode: 'system',
    displayName: 'Cursor',
    config: { apiKey: '', model: '' },
    enabled: true,
    order_seq: order,
  }
}

/**
 * `defaultAgentId` = Claude A, plus whatever routing the case under test needs.
 * The reported failure shape — intent agent Cursor, default agent Claude — is the
 * default here, so a regression shows up as "the intent session landed on Claude".
 */
function configure(over: Partial<SystemSettings> = {}): void {
  saveSettings({
    agents: [
      claudeAgent(CLAUDE_A, 'Claude A', 0),
      claudeAgent(CLAUDE_B, 'Claude B', 1),
      cursorAgent(CURSOR, 2),
    ],
    defaultAgentId: CLAUDE_A,
    toolAgentId: '',
    intentAgentId: CURSOR,
    specAgentId: '',
    specReviewAgentId: '',
    ...over,
  } as SystemSettings)
  resetSettingsCacheForTests()
}

function harness(launchRun = vi.fn().mockResolvedValue(undefined)) {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: 'alice',
    authed: true,
    authToken: null,
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
  } as unknown as Conn
  const ctx = { launchRun, broadcastIntents: vi.fn() } as unknown as KernelContext
  return { sent, conn, ctx, launchRun }
}

function selected(sent: ServerToClient[]) {
  const m = sent.find((x) => x.type === 'session_selected')
  expect(m && m.type === 'session_selected').toBeTruthy()
  return m as Extract<ServerToClient, { type: 'session_selected' }>
}

/** The `session_metadata` row projected for a session id, or undefined. */
function projectedRow(sessionId: string) {
  return listAll().find((r) => r.vendorSessionId === sessionId)
}

/**
 * Assert all four layers describe the SAME agent: the binding fact, the projection
 * row (`agent_id` AND `vendor` — a split row is exactly the bug this pins), the
 * title-bar payload, and what a run would actually launch.
 */
function expectAllLayersAgree(
  sent: ServerToClient[],
  sessionId: string,
  agentId: string,
  vendor: 'claude' | 'codex' | 'cursor',
): void {
  expect(getSessionAgentId(sessionId)).toBe(agentId)
  expect(projectedRow(sessionId)).toMatchObject({ agentId, vendor })
  const msg = selected(sent)
  expect(msg.sessionId).toBe(sessionId)
  expect(msg.vendor).toBe(vendor)
  expect(msg.agentSwitch?.current.id).toBe(agentId)
  expect(resolveSessionLaunch(sessionId).agentId).toBe(agentId)
}

describe('new intent comm sessions adopt the configured intent agent', () => {
  it('add intent (start_intent_session) binds, projects, displays and launches Cursor', async () => {
    configure()
    const [intent] = insertIntents(proj, [
      { title: 'Cache it', shortEnTitle: 'cache', content: 'C', priority: 'P1' },
    ])
    const h = harness()

    await startIntentSession(h.ctx, h.conn, {
      type: 'start_intent_session',
      workspaceId,
      intentId: intent.id,
      text: 'do it',
    })

    const sid = selected(h.sent).sessionId
    opened.push(sid)
    expectAllLayersAgree(h.sent, sid, CURSOR, 'cursor')
    expect(h.launchRun).toHaveBeenCalledTimes(1)
  })

  it('new_intent_session binds the intent agent, not the default one', () => {
    configure()
    const h = harness()

    newIntentSession(h.ctx, h.conn, { type: 'new_intent_session', workspaceId })

    const sid = selected(h.sent).sessionId
    opened.push(sid)
    expectAllLayersAgree(h.sent, sid, CURSOR, 'cursor')
  })

  it('open_intent_session with no existing comm session creates one on the intent agent', async () => {
    configure()
    const h = harness()

    await openIntentSession(h.ctx, h.conn, { type: 'open_intent_session', workspaceId })

    const sid = selected(h.sent).sessionId
    opened.push(sid)
    expectAllLayersAgree(h.sent, sid, CURSOR, 'cursor')
  })

  it('refine_intent starts the fresh session on the intent agent', async () => {
    configure()
    const [intent] = insertIntents(proj, [
      { title: 'Refine me', shortEnTitle: 'refine', content: 'C', priority: 'P1' },
    ])
    const h = harness()

    await refineIntent(h.ctx, h.conn, { type: 'refine_intent', workspaceId, intentId: intent.id })

    const sid = selected(h.sent).sessionId
    opened.push(sid)
    expectAllLayersAgree(h.sent, sid, CURSOR, 'cursor')
  })

  it('reset_intent_session starts the fresh session on the intent agent', async () => {
    configure()
    const [intent] = insertIntents(proj, [
      { title: 'Reset me', shortEnTitle: 'reset', content: 'C', priority: 'P1' },
    ])
    const h = harness()

    await resetIntentSession(h.ctx, h.conn, {
      type: 'reset_intent_session',
      workspaceId,
      intentId: intent.id,
      userInput: 'again',
    })

    const sid = selected(h.sent).sessionId
    opened.push(sid)
    expectAllLayersAgree(h.sent, sid, CURSOR, 'cursor')
  })

  it('discussion_to_intent binds its intent-owned session to the intent agent', async () => {
    configure()
    const d = createDiscussion({
      workspacePath: proj,
      title: 'A discussion',
      type: 'design',
      goal: 'g',
      status: 'completed',
    })
    setConclusion(d.id, 'CONCLUSION')
    const h = harness()

    await discussionToIntent(h.ctx, h.conn, { type: 'discussion_to_intent', discussionId: d.id })

    const sid = selected(h.sent).sessionId
    opened.push(sid)
    expectAllLayersAgree(h.sent, sid, CURSOR, 'cursor')
  })

  it('an empty intentAgentId keeps the existing "follow the default agent" semantics', () => {
    configure({ intentAgentId: '' })
    const h = harness()

    newIntentSession(h.ctx, h.conn, { type: 'new_intent_session', workspaceId })

    const sid = selected(h.sent).sessionId
    opened.push(sid)
    expectAllLayersAgree(h.sent, sid, CLAUDE_A, 'claude')
  })
})

describe('reopening a bound intent comm session resumes its frozen binding', () => {
  /** A comm session that already ran on Claude A — a real id with a frozen fact. */
  function historicalClaudeSession(sessionId = 'real-claude-comm'): string {
    setChatSession(proj, sessionId, 'Old conversation')
    bindSessionAgent(`pending:${sessionId}`, sessionId, CLAUDE_A, 'claude', 'host')
    return sessionId
  }

  it('a Claude-bound session reopens on Claude even after intentAgentId became Cursor', async () => {
    configure()
    const sid = historicalClaudeSession()
    const h = harness()

    await openIntentSession(h.ctx, h.conn, {
      type: 'open_intent_session',
      workspaceId,
      sessionId: sid,
    })
    opened.push(sid)

    // No cross-vendor re-bind, and — the split-row regression — the projection
    // must never pair the configured Cursor agent with the frozen claude vendor.
    expectAllLayersAgree(h.sent, sid, CLAUDE_A, 'claude')
    expect(projectedRow(sid)?.agentId).not.toBe(CURSOR)
  })

  it('a same-vendor intentAgentId change does not silently re-target a bound session', async () => {
    configure({ intentAgentId: CLAUDE_B })
    const sid = historicalClaudeSession()
    const h = harness()

    await openIntentSession(h.ctx, h.conn, {
      type: 'open_intent_session',
      workspaceId,
      sessionId: sid,
    })
    opened.push(sid)

    expectAllLayersAgree(h.sent, sid, CLAUDE_A, 'claude')
  })

  it('an explicit reset — not a reopen — is what adopts the newly-configured agent', async () => {
    configure({ intentAgentId: CLAUDE_B })
    historicalClaudeSession()
    const [intent] = insertIntents(proj, [
      { title: 'Move me', shortEnTitle: 'move', content: 'C', priority: 'P1' },
    ])
    const h = harness()

    await resetIntentSession(h.ctx, h.conn, {
      type: 'reset_intent_session',
      workspaceId,
      intentId: intent.id,
      userInput: 'start over',
    })

    const fresh = selected(h.sent).sessionId
    opened.push(fresh)
    expectAllLayersAgree(h.sent, fresh, CLAUDE_B, 'claude')
  })

  it('a real session with no binding fact is bound before session_selected / launch', async () => {
    configure()
    const sid = 'real-unbound-comm'
    setChatSession(proj, sid, 'Never ran')
    const h = harness()

    await openIntentSession(h.ctx, h.conn, {
      type: 'open_intent_session',
      workspaceId,
      sessionId: sid,
    })
    opened.push(sid)

    expectAllLayersAgree(h.sent, sid, CURSOR, 'cursor')
  })

  it('a pending session reopened after a runtime drop keeps the agent it was created with', async () => {
    configure()
    const h1 = harness()
    newIntentSession(h1.ctx, h1.conn, { type: 'new_intent_session', workspaceId })
    const sid = selected(h1.sent).sessionId
    opened.push(sid)
    // The runtime is gone (process restart / GC) and the config changed meanwhile.
    removeRuntime(sid)
    configure({ intentAgentId: CLAUDE_B })

    const h2 = harness()
    await openIntentSession(h2.ctx, h2.conn, { type: 'open_intent_session', workspaceId })

    expect(selected(h2.sent).sessionId).toBe(sid)
    expectAllLayersAgree(h2.sent, sid, CURSOR, 'cursor')
  })
})

describe('other session kinds keep their own routing (non-goal)', () => {
  it('default / tool / spec / spec-review resolution ignores intentAgentId', () => {
    configure({ specAgentId: CLAUDE_B })

    expect(resolveAgent(null).id).toBe(CLAUDE_A)
    expect(resolveToolAgent().id).toBe(CLAUDE_A)
    expect(resolveSpecAgent().id).toBe(CLAUDE_B)
    expect(resolveSpecReviewAgent().id).toBe(CLAUDE_A)
  })

  it('a spec session still pins the spec agent, not the intent agent', async () => {
    configure({ specAgentId: CLAUDE_B })
    const [intent] = insertIntents(proj, [
      { title: 'Spec me', shortEnTitle: 'spec', content: '', priority: 'P1' },
    ])
    setSpecPath(intent.id, join(proj, '.specs/2026/08/05/spec.md'))
    const specId = 'real-spec-session'
    setSpecSessionId(intent.id, specId)
    const h = harness()

    await openSpecSession(h.ctx, h.conn, {
      type: 'open_spec_session',
      workspaceId,
      intentId: intent.id,
    })
    opened.push(specId)

    const msg = selected(h.sent)
    expect(msg.sessionId).toBe(specId)
    expect(getSessionAgentId(specId)).toBe(CLAUDE_B)
    expect(msg.vendor).toBe('claude')
  })
})
