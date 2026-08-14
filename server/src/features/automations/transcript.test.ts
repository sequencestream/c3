import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The store maps `workspace_name` <-> opaque `workspaceName` through the registry;
// in isolation these synthetic paths are unregistered, so stub resolve/pathToName
// as identity — fixtures use the path itself as the id and round-trip cleanly.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToName: (p: string) => p,
  workspaceNameFor: (value: string) => value,
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@ccc/shared/protocol'

// Mock the sessions layer so the read path is tested without the Agent SDK /
// on-disk transcripts. The store below is the real db-backed one.
const loadHistory = vi.fn<(dir: string, sessionId: string) => Promise<TranscriptItem[]>>()
vi.mock('../../sessions.js', () => ({ loadHistory: (d: string, s: string) => loadHistory(d, s) }))

// Only the frozen store scope is stubbed; the rest of agent-config stays real so
// the codex root ordering under test is the production one.
const storeScope = vi.fn<() => StoreScope>(() => 'host')
vi.mock('../../kernel/agent-config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../kernel/agent-config/index.js')>()),
  resolveSessionStoreScope: () => storeScope(),
}))

import type { CanonicalMessage, StoreScope, VendorId } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { CodexSessionStore } from '../../kernel/agent/adapters/codex/index.js'
import { hostCodexHome, relayCodexHome } from '../../kernel/config/workspace-path.js'
import { resetStoreForTests, createAutomation, appendExecutionLog } from './store.js'
import { readExecutionTranscript } from './transcript.js'

let dir: string
const proj = '/abs/workspace-t'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-tr-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  loadHistory.mockReset()
  storeScope.mockReturnValue('host')
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function makeLlmAutomation(vendor: VendorId = 'claude') {
  return createAutomation({
    type: 'llm',
    config: { prompt: 'hi' },
    workspaceName: proj,
    cronExpression: '* * * * *',
    mode: 'read-only',
    vendor,
  })
}

/** Register an llm execution with a session id and return its log id. */
function makeExecution(automationId: string, sessionId: string | undefined) {
  return appendExecutionLog({
    automationId,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    output: '',
    error: null,
    sessionId,
  }).id
}

describe('readExecutionTranscript', () => {
  it('loads the transcript for an llm execution with a sessionId', async () => {
    const sch = makeLlmAutomation()
    const log = appendExecutionLog({
      automationId: sch.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      sessionId: 'sess-1',
    })
    const items: TranscriptItem[] = [
      { kind: 'assistant', text: 'hello' },
      { kind: 'tool_use', toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', toolUseId: 't1', content: 'file.txt', isError: false },
    ]
    loadHistory.mockResolvedValue(items)

    const result = await readExecutionTranscript(log.id)

    expect(result).toEqual({ sessionId: 'sess-1', items })
    // resolves to the owning automation's workspace, resolved path.
    expect(loadHistory).toHaveBeenCalledWith(sch.workspaceName, 'sess-1')
  })

  it('returns empty items without loading history when the execution has no sessionId', async () => {
    const sch = makeLlmAutomation()
    const log = appendExecutionLog({
      automationId: sch.id,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      exitCode: 0,
      output: 'done',
      error: null,
      // no sessionId — e.g. a command run or a session that never started
    })

    const result = await readExecutionTranscript(log.id)

    expect(result).toEqual({ sessionId: null, items: [] })
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('returns null for a non-existent execution id', async () => {
    const result = await readExecutionTranscript('does-not-exist')
    expect(result).toBeNull()
    expect(loadHistory).not.toHaveBeenCalled()
  })

  it('degrades to empty items when the transcript is unreadable', async () => {
    const sch = makeLlmAutomation()
    const log = appendExecutionLog({
      automationId: sch.id,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      sessionId: 'sess-gone',
    })
    loadHistory.mockRejectedValue(new Error('ENOENT'))

    const result = await readExecutionTranscript(log.id)

    expect(result).toEqual({ sessionId: 'sess-gone', items: [] })
  })
})

describe('readExecutionTranscript — codex executions', () => {
  const codexHistory: CanonicalMessage[] = [
    {
      vendor: 'codex',
      sessionId: 'codex-exec-1',
      role: 'user',
      blocks: [{ type: 'text', id: 'u1', text: 'run the nightly check' }],
      ts: 1,
    },
    {
      vendor: 'codex',
      sessionId: 'codex-exec-1',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_use',
          id: 'cmd-1',
          name: 'shell',
          input: { command: 'pnpm test' },
          result: { content: 'ok', isError: false },
        },
      ],
      ts: 2,
    },
  ]

  it('reads from the codex session store, not the claude-only reader', async () => {
    const sch = makeLlmAutomation('codex')
    const logId = makeExecution(sch.id, 'codex-exec-1')
    const read = vi.spyOn(CodexSessionStore.prototype, 'read').mockResolvedValue(codexHistory)

    const result = await readExecutionTranscript(logId)

    expect(loadHistory).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith('codex-exec-1', {
      cwd: proj,
      storeRoots: [hostCodexHome(), relayCodexHome()],
    })
    expect(result).toEqual({
      sessionId: 'codex-exec-1',
      items: [
        { kind: 'user', text: 'run the nightly check' },
        {
          kind: 'tool_use',
          toolUseId: 'cmd-1',
          toolName: 'shell',
          input: { command: 'pnpm test' },
        },
        { kind: 'tool_result', toolUseId: 'cmd-1', content: 'ok', isError: false },
      ],
    })
  })

  it('scans the frozen store scope root first, keeping the other as a fallback', async () => {
    const sch = makeLlmAutomation('codex')
    const logId = makeExecution(sch.id, 'codex-exec-sandbox')
    storeScope.mockReturnValue('sandbox')
    const read = vi.spyOn(CodexSessionStore.prototype, 'read').mockResolvedValue([])

    await readExecutionTranscript(logId)

    expect(read).toHaveBeenCalledWith('codex-exec-sandbox', {
      cwd: proj,
      storeRoots: [relayCodexHome(), hostCodexHome()],
    })
  })

  it('degrades to empty items when the codex session is not on disk', async () => {
    const sch = makeLlmAutomation('codex')
    const logId = makeExecution(sch.id, 'codex-exec-gone')
    vi.spyOn(CodexSessionStore.prototype, 'read').mockRejectedValue(new Error('ENOENT'))

    expect(await readExecutionTranscript(logId)).toEqual({
      sessionId: 'codex-exec-gone',
      items: [],
    })
  })

  it('does not touch any session store when a codex execution has no sessionId', async () => {
    const sch = makeLlmAutomation('codex')
    const logId = makeExecution(sch.id, undefined)
    const read = vi.spyOn(CodexSessionStore.prototype, 'read')

    expect(await readExecutionTranscript(logId)).toEqual({ sessionId: null, items: [] })
    expect(read).not.toHaveBeenCalled()
    expect(loadHistory).not.toHaveBeenCalled()
  })
})
