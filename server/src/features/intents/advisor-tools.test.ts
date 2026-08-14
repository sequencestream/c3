/**
 * The advisor tool group — belt two.
 *
 * Every assertion here calls a tool DIRECTLY, bypassing the proposal validator
 * entirely. That is the point: if the second belt only worked when the first one
 * ran, it would not be a second belt. So each write tool is asserted to refuse
 * an out-of-scope session, a withheld status, an exhausted chain, or a denied
 * approval on its own — and to leave nothing written behind when it refuses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { ensureRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import { resetStoreForTests as resetUserInvolveStore } from '../user-involve/store.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setLastWorkSession,
  updateStatus,
} from './store.js'
import {
  ADVISOR_CONFIRMED_TOOL_NAMES,
  ADVISOR_C3_TOOL_NAMES,
  ADVISOR_SHARED_WITH_AUTOMATION_TOOL_NAMES,
  buildAdvisorC3Tools,
  redactAndTail,
  TRANSCRIPT_TAIL_LIMIT,
  type AdvisorScopeBinding,
  type AdvisorTool,
  type AdvisorToolDeps,
  type AdvisorToolResult,
} from './advisor-tools.js'
import { ADVISOR_MAX_CHAIN_DEPTH } from './advisor-validate.js'
import { AUTOMATION_C3_TOOL_NAMES } from '../automations/c3-tools.js'

let dir: string
let proj: string
let intentId: string

/** Tracks whether the write-approval queue was consulted, and what it was told. */
let approvals: Array<{ toolName: string; intentId: string }>
let approvalAnswer: boolean

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-advisor-tools-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetUserInvolveStore()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  proj = resolveWorkspaceRoot(pathToName(dir)!)!
  const [intent] = insertIntents(proj, [
    { title: '被顾问诊断的意图', shortEnTitle: 'advised', content: '内容', priority: 'P1' },
  ])
  intentId = intent.id
  updateStatus(intentId, 'in_progress', 'test')
  setLastWorkSession(intentId, 'sess-work')
  ensureRuntime('sess-work', proj, 'default', [], 'work')
  approvals = []
  approvalAnswer = true
})

afterEach(() => {
  removeRuntimesForWorkspace(proj)
  resetDbForTests()
  resetSessionMetadata()
  resetUserInvolveStore()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

function deps(): AdvisorToolDeps {
  return {
    broadcastIntents: vi.fn(),
    broadcastWaitUserEvents: vi.fn(),
    launchRun: vi.fn().mockResolvedValue(undefined) as unknown as AdvisorToolDeps['launchRun'],
    normalizeEvent: () => ({ ok: false, reason: 'not used' }),
    publishEvent: vi.fn(),
    publishStatusChanged: vi.fn(),
    requestWriteApproval: async (input) => {
      approvals.push({ toolName: input.toolName, intentId: input.intentId })
      return approvalAnswer
    },
  }
}

function tools(over: Partial<AdvisorScopeBinding> = {}): AdvisorTool[] {
  return buildAdvisorC3Tools(
    { workspacePath: proj, intentId, chainDepth: 0, sessionId: 'sess-advisor', ...over },
    deps(),
  )
}

function tool(name: string, over: Partial<AdvisorScopeBinding> = {}): AdvisorTool {
  return tools(over).find((t) => t.name === name)!
}

/** Parse a tool result's single JSON text block. */
function payload(r: AdvisorToolResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>
}

// ---------------------------------------------------------------------------

describe('advisor tool group — surface', () => {
  it('offers exactly the designed tools, and never approve_spec', () => {
    expect([...ADVISOR_C3_TOOL_NAMES].sort()).toEqual([
      'create_pr',
      'get_run_status',
      'list_sessions',
      'raise_user_todo',
      'read_session_transcript',
      'reset_intent_session',
      'reset_spec_session',
      'stop_run',
      'sync_intent_pr_status',
      'update_intent_status',
    ])
    expect(ADVISOR_C3_TOOL_NAMES).not.toContain('approve_spec')
  })

  it('does NOT leak into the ordinary automation tool set, beyond the one shared trigger', () => {
    for (const name of ADVISOR_C3_TOOL_NAMES) {
      if (ADVISOR_SHARED_WITH_AUTOMATION_TOOL_NAMES.includes(name)) continue
      expect(AUTOMATION_C3_TOOL_NAMES).not.toContain(name)
    }
    // The declared overlap is not a free pass: every name on it must really be
    // registered on BOTH surfaces, so a stale entry cannot silently excuse a leak.
    for (const name of ADVISOR_SHARED_WITH_AUTOMATION_TOOL_NAMES) {
      expect(ADVISOR_C3_TOOL_NAMES).toContain(name)
      expect(AUTOMATION_C3_TOOL_NAMES).toContain(name)
    }
  })

  it('never accepts a workspacePath or intentId argument — scope is closure-bound', () => {
    for (const t of tools()) {
      expect(Object.keys(t.inputSchema)).not.toContain('workspacePath')
      expect(Object.keys(t.inputSchema)).not.toContain('intentId')
    }
  })

  it('classifies destructive and outward-facing tools as confirmation-required', () => {
    expect([...ADVISOR_CONFIRMED_TOOL_NAMES].sort()).toEqual([
      'create_pr',
      'reset_intent_session',
      'reset_spec_session',
      'sync_intent_pr_status',
      'update_intent_status',
    ])
  })

  it('leaves reads, stop_run and raise_user_todo unconfirmed', () => {
    for (const name of [
      'read_session_transcript',
      'get_run_status',
      'list_sessions',
      'stop_run',
      'raise_user_todo',
    ]) {
      expect(tool(name).requiresConfirmation).toBe(false)
    }
  })
})

describe('advisor tool group — server-side re-validation (validator bypassed)', () => {
  it('refuses a session the bound intent does not own, and does not answer with a blank', async () => {
    const r = await tool('read_session_transcript').handler({ sessionId: 'sess-other-intent' })
    expect(r.isError).toBe(true)
    expect(payload(r).reason).toBe('session_scope_mismatch')
    expect(payload(r)).not.toHaveProperty('transcript')
  })

  it('refuses stop_run on someone else session', async () => {
    const r = await tool('stop_run').handler({ sessionId: 'sess-other-intent' })
    expect(r.isError).toBe(true)
    expect(payload(r).reason).toBe('session_scope_mismatch')
  })

  it('refuses update_intent_status to done even though the schema already forbids it', async () => {
    const r = await tool('update_intent_status').handler({ status: 'done' })
    expect(r.isError).toBe(true)
    expect(payload(r).reason).toBe('target_status_done_forbidden')
    // Nothing written, and the approval queue was never even consulted.
    expect(getIntent(intentId)?.status).toBe('in_progress')
    expect(approvals).toHaveLength(0)
  })

  it('refuses an illegal transition after approval, leaving the status untouched', async () => {
    updateStatus(intentId, 'cancelled', 'test')
    const r = await tool('update_intent_status').handler({ status: 'todo' })
    expect(r.isError).toBe(true)
    expect(payload(r).reason).toBe('illegal_status_transition')
    expect(getIntent(intentId)?.status).toBe('cancelled')
  })

  it('refuses every tool once the chain depth is exceeded', async () => {
    const over = { chainDepth: ADVISOR_MAX_CHAIN_DEPTH + 1 }
    for (const t of tools(over)) {
      const r = await t.handler({
        sessionId: 'sess-work',
        status: 'blocked',
        userInput: 'x',
        reasonCode: 'r',
        detail: 'd',
      })
      expect(r.isError).toBe(true)
      expect(payload(r).reason).toBe('chain_depth_exceeded')
    }
    expect(approvals).toHaveLength(0)
  })
})

describe('advisor tool group — the write-approval queue', () => {
  it('routes a confirmed tool through approval before it writes', async () => {
    const r = await tool('update_intent_status').handler({ status: 'blocked' })
    expect(r.isError).toBeUndefined()
    expect(approvals).toEqual([{ toolName: 'update_intent_status', intentId }])
    expect(getIntent(intentId)?.status).toBe('blocked')
  })

  it('writes nothing when approval is denied', async () => {
    approvalAnswer = false
    const r = await tool('update_intent_status').handler({ status: 'blocked' })
    expect(r.isError).toBe(true)
    expect(payload(r).reason).toBe('approval_denied')
    expect(getIntent(intentId)?.status).toBe('in_progress')
  })

  it('does not send unconfirmed tools through approval at all', async () => {
    await tool('stop_run').handler({ sessionId: 'sess-work' })
    await tool('raise_user_todo').handler({ reasonCode: 'needs_human', detail: '需要人看一下' })
    expect(approvals).toHaveLength(0)
  })
})

describe('advisor tool group — reads', () => {
  it('lists only the bound intent sessions', async () => {
    const r = await tool('list_sessions').handler({})
    expect(payload(r)).toMatchObject({ intentId })
    const sessions = payload(r).sessions as Array<{ sessionId: string }>
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-work'])
  })

  it('reports run status for an owned session', async () => {
    const r = await tool('get_run_status').handler({ sessionId: 'sess-work' })
    expect(payload(r)).toMatchObject({ sessionId: 'sess-work', running: false })
  })
})

describe('advisor tool group — raise_user_todo', () => {
  it('deduplicates on intent + reason code', async () => {
    const first = await tool('raise_user_todo').handler({ reasonCode: 'stuck', detail: '卡住了' })
    const second = await tool('raise_user_todo').handler({ reasonCode: 'stuck', detail: '还卡着' })
    expect(payload(first).created).toBe(true)
    expect(payload(second).created).toBe(false)
    expect(payload(second).reason).toBe('duplicate')
  })
})

describe('redactAndTail', () => {
  it('redacts BEFORE truncating so a sliced token cannot escape', () => {
    const secret = 'ghp_0123456789012345678901234567890123456789'
    const out = redactAndTail(`${secret}\n${'x'.repeat(50)}`, 20)
    expect(out).not.toContain('0123456789012345678901234567890123456789')
  })

  it('keeps the tail — the newest turns are what a diagnosis needs', () => {
    const out = redactAndTail(`${'a'.repeat(100)}TAIL`, 10)
    expect(out).toContain('TAIL')
    expect(out).toContain('已截断')
  })

  it('passes short content through untouched', () => {
    expect(redactAndTail('短内容')).toBe('短内容')
    expect(TRANSCRIPT_TAIL_LIMIT).toBeGreaterThan(0)
  })
})
