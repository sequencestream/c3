/**
 * `restart_work_session` handler — hand a spent work session off to a NEW one.
 *
 * Covers the two branches that matter:
 *  - IDLE old session (the primary case): no stop, no settle wait, straight to
 *    the launcher — a wait here would always time out and break the feature.
 *  - LIVE old session: abort, wait for `run:settled`, and only then create the
 *    new run, so two live work sessions never overlap.
 *
 * Plus the refusals the handler owns: terminal intent, no bound session, empty
 * prompt, and a live session that never settles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import type { SessionRuntime } from '../../runs.js'
import { EventBus } from '../../kernel/events/event-bus.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { ensureRuntime, getRuntime, isRunning, removeRuntimesForWorkspace } from '../../runs.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setLastWorkSession,
  updateStatus,
} from './store.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import {
  resetForTests as resetDevLink,
  isSessionRestarting,
  takePendingDevLink,
} from './dev-link.js'
import { restartWorkSession } from './index.js'
import { initTestGitRepo } from '../../../test/git-repo.js'

let dir: string
let workspaceName: string
let proj: string
let eb: EventBus

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-restart-work-session-'))
  initTestGitRepo(dir)
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetDevLink()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
  proj = resolveWorkspaceRoot(workspaceName)!
  saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: false })
  eb = new EventBus()
})

afterEach(() => {
  eb.clear()
  removeRuntimesForWorkspace(proj)
  resetDbForTests()
  resetSessionMetadata()
  resetDevLink()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
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
  } as Conn
  return { conn, sent }
}

function ctxWith(launchRun: unknown): KernelContext {
  return {
    launchRun,
    broadcastIntents: vi.fn(),
    eventBus: eb,
  } as unknown as KernelContext
}

/** An intent in `status` bound to a work session with a runtime (no run yet). */
function boundIntent(status: 'in_progress' | 'reviewing' | 'done', sessionId: string): string {
  const [intent] = insertIntents(proj, [
    { title: 'Restart target', shortEnTitle: 'restart-target', content: 'BODY', priority: 'P1' },
  ])
  updateStatus(intent.id, status, 'test')
  setLastWorkSession(intent.id, sessionId)
  ensureRuntime(sessionId, proj, 'default', [], 'work')
  return intent.id
}

function markRunning(sessionId: string): AbortController {
  const rt = getRuntime(sessionId)!
  const abort = new AbortController()
  rt.run = { abort, handle: null } as SessionRuntime['run']
  return abort
}

function errorCodes(sent: ServerToClient[]): string[] {
  return sent
    .filter((m) => m.type === 'error')
    .map((m) => (m as { error: { code: string } }).error.code)
}

describe('restartWorkSession — refusals before anything is stopped or created', () => {
  it('refuses a terminal (done) intent', async () => {
    const id = boundIntent('done', 'sess-done')
    const launchRun = vi.fn()
    const { conn, sent } = fakeConn()
    await restartWorkSession(ctxWith(launchRun), conn, {
      type: 'restart_work_session',
      workspaceName,
      intentId: id,
      prompt: 'go',
    })
    expect(errorCodes(sent)).toEqual(['intent.cannotStartDev'])
    expect(launchRun).not.toHaveBeenCalled()
  })

  it('refuses an intent with no bound work session', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'No session', shortEnTitle: 'no-session', content: '', priority: 'P1' },
    ])
    updateStatus(intent.id, 'in_progress', 'test')
    const launchRun = vi.fn()
    const { conn, sent } = fakeConn()
    await restartWorkSession(ctxWith(launchRun), conn, {
      type: 'restart_work_session',
      workspaceName,
      intentId: intent.id,
      prompt: 'go',
    })
    expect(errorCodes(sent)).toEqual(['intent.restartNoWorkSession'])
    expect(launchRun).not.toHaveBeenCalled()
  })

  it('refuses an empty/whitespace prompt', async () => {
    const id = boundIntent('in_progress', 'sess-blank')
    const launchRun = vi.fn()
    const { conn, sent } = fakeConn()
    await restartWorkSession(ctxWith(launchRun), conn, {
      type: 'restart_work_session',
      workspaceName,
      intentId: id,
      prompt: '   ',
    })
    expect(errorCodes(sent)).toEqual(['intent.restartPromptRequired'])
    expect(launchRun).not.toHaveBeenCalled()
  })
})

describe('restartWorkSession — idle old session (primary case)', () => {
  it('does not stop or wait: creates the new session straight away', async () => {
    const id = boundIntent('in_progress', 'sess-idle-h')
    expect(isRunning('sess-idle-h')).toBe(false)
    const launchRun = vi.fn().mockResolvedValue(undefined)
    const { conn, sent } = fakeConn()

    await restartWorkSession(ctxWith(launchRun), conn, {
      type: 'restart_work_session',
      workspaceName,
      intentId: id,
      prompt: 'PICK UP FROM HERE',
    })

    // A new pending session was launched with the prompt; no restart marker was
    // ever set (nothing was aborted).
    expect(launchRun).toHaveBeenCalledTimes(1)
    const newId = launchRun.mock.calls[0]![0].sessionId as string
    expect(newId).toContain(PENDING_SESSION_PREFIX)
    expect(newId).not.toBe('sess-idle-h')
    expect(launchRun.mock.calls[0]![1]).toBe('PICK UP FROM HERE')
    expect(takePendingDevLink(newId)?.intentId).toBe(id)
    expect(isSessionRestarting('sess-idle-h')).toBe(false)
    expect(errorCodes(sent)).toEqual([])
    // The old session's binding is untouched until the new one binds.
    expect(getIntent(id)?.lastWorkSessionId).toBe('sess-idle-h')
  })
})

describe('restartWorkSession — live old session', () => {
  it('aborts, waits for the settle, then launches the new session', async () => {
    const id = boundIntent('in_progress', 'sess-live-h')
    const abort = markRunning('sess-live-h')
    const launchRun = vi.fn().mockResolvedValue(undefined)
    const { conn, sent } = fakeConn()

    const pending = restartWorkSession(ctxWith(launchRun), conn, {
      type: 'restart_work_session',
      workspaceName,
      intentId: id,
      prompt: 'HAND OFF',
    })

    // Let the handler reach the settle wait: aborted, marker set, new run NOT
    // created yet — two live work sessions never overlap.
    await vi.waitFor(() => {
      expect(abort.signal.aborted).toBe(true)
    })
    expect(isSessionRestarting('sess-live-h')).toBe(true)
    expect(launchRun).not.toHaveBeenCalled()

    eb.publish('run:settled', {
      sessionId: 'sess-live-h',
      workspacePath: proj,
      reason: 'aborted',
      sessionKind: 'work',
      runKind: 'interactive',
    })
    await pending

    expect(launchRun).toHaveBeenCalledTimes(1)
    expect(launchRun.mock.calls[0]![1]).toBe('HAND OFF')
    expect(errorCodes(sent)).toEqual([])
  })

  it('refuses and creates nothing when the live session never settles', async () => {
    vi.useFakeTimers()
    try {
      const id = boundIntent('in_progress', 'sess-stuck')
      const abort = markRunning('sess-stuck')
      const launchRun = vi.fn()
      const { conn, sent } = fakeConn()

      const pending = restartWorkSession(ctxWith(launchRun), conn, {
        type: 'restart_work_session',
        workspaceName,
        intentId: id,
        prompt: 'go',
      })
      await Promise.resolve()
      expect(abort.signal.aborted).toBe(true)

      await vi.advanceTimersByTimeAsync(31_000)
      await pending

      expect(errorCodes(sent)).toEqual(['intent.restartSettleTimeout'])
      expect(launchRun).not.toHaveBeenCalled()
      // The refused restart releases the marker so the eventual settle runs its
      // normal cleanup.
      expect(isSessionRestarting('sess-stuck')).toBe(false)
      expect(getIntent(id)?.lastWorkSessionId).toBe('sess-stuck')
    } finally {
      vi.useRealTimers()
    }
  })
})
