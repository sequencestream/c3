import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptItem } from '@ccc/shared/protocol'

// Mock the sessions layer so the read path is tested without the Agent SDK /
// on-disk transcripts. The store below is the real db-backed one.
const loadHistory = vi.fn<(dir: string, sessionId: string) => Promise<TranscriptItem[]>>()
vi.mock('../../sessions.js', () => ({ loadHistory: (d: string, s: string) => loadHistory(d, s) }))

import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetStoreForTests, createSchedule, appendExecutionLog } from './store.js'
import { readExecutionTranscript } from './transcript.js'

let dir: string
const proj = '/abs/workspace-t'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-tr-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  loadHistory.mockReset()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function makeLlmSchedule() {
  return createSchedule({
    type: 'llm',
    config: { prompt: 'hi' },
    workspacePath: proj,
    cronExpression: '* * * * *',
    mcpMode: 'read-only',
    vendor: 'claude',
  })
}

describe('readExecutionTranscript', () => {
  it('loads the transcript for an llm execution with a sessionId', async () => {
    const sch = makeLlmSchedule()
    const log = appendExecutionLog({
      scheduleId: sch.id,
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
    // resolves to the owning schedule's workspace, resolved path.
    expect(loadHistory).toHaveBeenCalledWith(sch.workspacePath, 'sess-1')
  })

  it('returns empty items without loading history when the execution has no sessionId', async () => {
    const sch = makeLlmSchedule()
    const log = appendExecutionLog({
      scheduleId: sch.id,
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
    const sch = makeLlmSchedule()
    const log = appendExecutionLog({
      scheduleId: sch.id,
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
