/**
 * `reset_intent_session` / `reset_spec_session` handlers — start a FRESH session
 * seeded with the user's new input concatenated with the intent's current content
 * (intent session) or the current spec document content (spec session), replacing
 * the prior linked session id on first bind.
 *
 * Covers (per acceptance): the prompt CONCATENATION (new input + intent/spec
 * content) via the pure builders, and the linked-session-id REFRESH wiring — the
 * handler registers the new pending session against the intent so the resident
 * `run:bound` subscription re-links `intent_session_id` / `spec_session_id` to the
 * real session on first bind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { getRuntime, removeRuntime } from '../../runs.js'
import { getIntent, insertIntents, resetStoreForTests, setSpecPath } from './store.js'
import { buildResetIntentPrompt, resetIntentSession } from './index.js'
import { buildResetSpecPrompt, resetSpecSessionHandler } from './spec.js'
import { resetForTests as resetIntentLink, takePendingIntentLink } from './intent-link.js'
import { resetForTests as resetSpecLink, takePendingSpecLink } from './spec-link.js'

let dir: string
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-reset-session-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  resetIntentLink()
  resetSpecLink()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  resetIntentLink()
  resetSpecLink()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(over: Partial<Conn> = {}): { conn: Conn; sent: ServerToClient[] } {
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
    ...over,
  } as Conn
  return { conn, sent }
}

function selectedSessionId(sent: ServerToClient[]): string {
  const m = sent.find((x) => x.type === 'session_selected')
  expect(m && m.type === 'session_selected').toBeTruthy()
  return m && m.type === 'session_selected' ? m.sessionId : ''
}

describe('buildResetIntentPrompt', () => {
  it('concatenates the new user input with the intent content + id', () => {
    const intent = {
      id: 'int-1',
      title: 'Cached endpoint',
      content: '原始意图内容 ABC',
      status: 'todo',
    } as ReturnType<typeof getIntent> & object
    const prompt = buildResetIntentPrompt(intent as never, '请改成只缓存 GET 请求 XYZ')
    expect(prompt).toContain('请改成只缓存 GET 请求 XYZ')
    expect(prompt).toContain('原始意图内容 ABC')
    expect(prompt).toContain('int-1')
  })

  it('omits the input block when the user input is blank', () => {
    const intent = { id: 'i', title: 't', content: 'C', status: 'todo' } as never
    const prompt = buildResetIntentPrompt(intent, '   ')
    expect(prompt).not.toContain('我的新输入')
    expect(prompt).toContain('C')
  })
})

describe('buildResetSpecPrompt', () => {
  it('concatenates the new user input with the current spec content + file path', () => {
    const intent = { id: 'int-2', title: 'Spec it', content: '' } as never
    const prompt = buildResetSpecPrompt(
      intent,
      '.specs/x/spec.md',
      '# Spec body LMN',
      'tighten the scope DEF',
    )
    expect(prompt).toContain('tighten the scope DEF')
    expect(prompt).toContain('# Spec body LMN')
    expect(prompt).toContain('.specs/x/spec.md')
  })
})

describe('resetIntentSession', () => {
  it('launches a fresh comm session with input+content and registers the id-refresh link', async () => {
    const [r] = insertIntents(proj, [
      { title: 'Refine me', shortEnTitle: 'refine', content: 'CONTENT_TOKEN', priority: 'P1' },
    ])
    const launchRun = vi.fn().mockResolvedValue(undefined)
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await resetIntentSession(ctx, conn, {
      type: 'reset_intent_session',
      workspaceId,
      intentId: r.id,
      userInput: 'INPUT_TOKEN',
    })

    // A fresh session was started and the connection switched to it.
    const sid = selectedSessionId(sent)
    expect(sid).toBeTruthy()
    expect(conn.viewing).toBe(sid)

    // The launch prompt concatenates the new input with the intent content.
    expect(launchRun).toHaveBeenCalledTimes(1)
    const prompt = launchRun.mock.calls[0][1] as string
    expect(prompt).toContain('INPUT_TOKEN')
    expect(prompt).toContain('CONTENT_TOKEN')

    // The new session is linked to this intent so `run:bound` refreshes
    // intent_session_id to the real id on first bind.
    expect(takePendingIntentLink(sid)).toBe(r.id)

    removeRuntime(sid)
  })

  it('rejects an unknown intent id', async () => {
    const launchRun = vi.fn()
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    await resetIntentSession(ctx, conn, {
      type: 'reset_intent_session',
      workspaceId,
      intentId: 'nope',
      userInput: 'x',
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
    expect(launchRun).not.toHaveBeenCalled()
  })
})

describe('resetSpecSessionHandler', () => {
  it('launches a fresh spec session with input+spec content and registers the id-refresh link', () => {
    const [r] = insertIntents(proj, [
      { title: 'Spec me', shortEnTitle: 'spec', content: '', priority: 'P1' },
    ])
    const specRel = '.specs/2026/06/18/2026-06-18-001-spec/spec.md'
    setSpecPath(r.id, specRel)
    const fileAbs = join(proj, specRel)
    mkdirSync(dirname(fileAbs), { recursive: true })
    writeFileSync(fileAbs, '# Spec body SPEC_TOKEN', 'utf8')

    const launchRun = vi.fn().mockResolvedValue(undefined)
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    resetSpecSessionHandler(ctx, conn, {
      type: 'reset_spec_session',
      workspaceId,
      intentId: r.id,
      userInput: 'SPEC_INPUT',
    })

    const sid = selectedSessionId(sent)
    expect(sid).toBeTruthy()
    expect(conn.viewing).toBe(sid)
    // Fresh spec runtime is write-confined to the existing spec directory.
    expect(getRuntime(sid)?.specDir).toBe(dirname(fileAbs))

    expect(launchRun).toHaveBeenCalledTimes(1)
    const prompt = launchRun.mock.calls[0][1] as string
    expect(prompt).toContain('SPEC_INPUT')
    expect(prompt).toContain('SPEC_TOKEN')

    expect(takePendingSpecLink(sid)).toBe(r.id)

    removeRuntime(sid)
  })

  it('rejects when no spec has been written (no specPath)', () => {
    const [r] = insertIntents(proj, [
      { title: 'No spec', shortEnTitle: 'nospec', content: '', priority: 'P2' },
    ])
    const launchRun = vi.fn()
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    resetSpecSessionHandler(ctx, conn, {
      type: 'reset_spec_session',
      workspaceId,
      intentId: r.id,
      userInput: 'x',
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.specNotWritten' } }])
    expect(launchRun).not.toHaveBeenCalled()
    expect(getIntent(r.id)?.specSessionId).toBeNull()
  })

  it('rejects an unknown intent id', () => {
    const launchRun = vi.fn()
    const ctx = { launchRun } as unknown as KernelContext
    const { conn, sent } = fakeConn()

    resetSpecSessionHandler(ctx, conn, {
      type: 'reset_spec_session',
      workspaceId,
      intentId: 'nope',
      userInput: 'x',
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'intent.notFound' } }])
    expect(launchRun).not.toHaveBeenCalled()
  })
})
