/**
 * Automation `llm` execution registers a real {@link SessionRuntime} for its agent
 * session and translates the SDK/canonical stream into c3 wire events, so a viewer
 * on the works page sees `running` mid-run + a live transcript, and `idle` + the
 * final frame when it ends. The runtime is KEPT after the run (same as an ordinary
 * session) so the session replays from its buffer when selected later.
 *
 * The real `runs.ts` registry is used (NOT mocked) so we can assert its effect on
 * `listStatuses()` and the runtime buffer; everything the dispatcher touches around
 * the SDK/driver is mocked so no network / child process is spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))

const queryImpl = vi.hoisted(() => ({ fn: (_opts: unknown): AsyncIterable<unknown> => emptyGen() }))
async function* emptyGen(): AsyncGenerator<unknown> {
  /* replaced per-test */
}
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (o: unknown) => queryImpl.fn(o) }))

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => ({
    agents: [
      { id: 'agent-1', enabled: true, vendor: 'claude' },
      { id: 'agent-codex', enabled: true, vendor: 'codex' },
    ],
  }),
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  launchForAgent: () => ({ model: 'test-model', envOverrides: {} }),
  setAgentEnabled: () => true,
  bindClaudeRelay: () => null,
  unbindRelay: () => {},
}))
vi.mock('../../kernel/infra/child-env.js', () => ({
  buildChildEnv: () => ({}),
  findClaudeExecutable: () => undefined,
}))
vi.mock('./store.js', () => ({
  getWorkspaceMcpConfig: () => ({ mcpServers: {} }),
  isAgentQuotaRecoveryConfig: () => false,
}))
vi.mock('../sessions/session-metadata-store.js', () => ({
  upsertAutomationExecutionRow: () => undefined,
}))

const codexStart = vi.hoisted(() => ({
  fn: (_o: unknown): Promise<unknown> => Promise.resolve({}),
}))
vi.mock('../../kernel/agent/adapters/codex/index.js', () => ({
  createCodexAdapter: () => ({ driver: { start: (o: unknown) => codexStart.fn(o) } }),
}))

import type { Automation, ServerToClient } from '@ccc/shared/protocol'
import { execute } from './dispatcher.js'
import {
  addViewer,
  getRuntime,
  listStatuses,
  removeRuntime,
  setOnStatusChange,
} from '../../runs.js'

const SID = 'automation-agent-session'

/** Base claude LLM automation; override per test. */
function claudeAutomation(over: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    type: 'llm',
    workspaceId: '/ws',
    agentId: 'agent-1',
    vendor: 'claude',
    mode: 'default',
    config: { prompt: 'do a thing' },
    ...over,
  } as unknown as Automation
}

/** Snapshots captured every time the status hook fires (i.e. every broadcast). */
let snapshots: Record<string, string>[]

beforeEach(() => {
  snapshots = []
  setOnStatusChange(() => {
    snapshots.push(Object.fromEntries(listStatuses().map((s) => [s.sessionId, s.status])))
  })
})

afterEach(() => {
  setOnStatusChange(null)
  removeRuntime(SID)
})

function sawRunning(): boolean {
  return snapshots.some((snap) => snap[SID] === 'running')
}

function statusOf(): string | undefined {
  return listStatuses().find((s) => s.sessionId === SID)?.status
}

describe('automation dispatcher — viewer runtime (claude)', () => {
  it('registers a runtime, broadcasts running mid-run, settles idle on success', async () => {
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'system', session_id: SID }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }
        yield { type: 'result' }
      })()

    const updates: Record<string, unknown>[] = []
    await execute(claudeAutomation(), 'log-1', (_id, patch) => updates.push(patch))

    // A broadcast during the run carried running for the real session id.
    expect(sawRunning()).toBe(true)
    // Terminal state reached success, and the runtime is kept and settled to idle.
    expect(updates.at(-1)?.status).toBe('success')
    expect(statusOf()).toBe('idle')
  })

  it('translates the SDK stream into wire events on the runtime buffer', async () => {
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'system', session_id: SID }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } }
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } }],
          },
        }
        yield {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }],
          },
        }
        yield { type: 'result' }
      })()

    await execute(claudeAutomation(), 'log-2', () => undefined)

    const buffer = getRuntime(SID)?.buffer ?? []
    const types = buffer.map((e) => e.type)
    expect(types).toEqual(['assistant_text', 'tool_use', 'tool_result', 'turn_end'])
    const toolUse = buffer.find((e) => e.type === 'tool_use') as Extract<
      ServerToClient,
      { type: 'tool_use' }
    >
    expect(toolUse.toolName).toBe('Read')
    expect((buffer.at(-1) as { reason?: string }).reason).toBe('complete')
  })

  it('flushes pre-session-id events to a viewer that selects mid-run', async () => {
    // The assistant text arrives on the SAME frame that first carries the session
    // id here; the buffer flush guarantees the viewer still receives it.
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'system', session_id: SID }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }
        yield { type: 'result' }
      })()

    // Attach a viewer the moment the runtime goes running, then assert it saw the
    // full stream via the buffer replay any later viewer would also get.
    const received: ServerToClient[] = []
    setOnStatusChange(() => {
      snapshots.push(Object.fromEntries(listStatuses().map((s) => [s.sessionId, s.status])))
      if (getRuntime(SID)) addViewer(SID, (e) => received.push(e))
    })

    await execute(claudeAutomation(), 'log-3', () => undefined)

    // The buffer holds the complete stream a mid-run viewer replays on select.
    const buffer = getRuntime(SID)?.buffer ?? []
    expect(buffer.map((e) => e.type)).toContain('assistant_text')
    expect(buffer.map((e) => e.type)).toContain('turn_end')
  })

  it('keeps the runtime and settles idle when the run throws after binding', async () => {
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'system', session_id: SID }
        throw new Error('sdk blew up')
      })()

    const updates: Record<string, unknown>[] = []
    await execute(claudeAutomation(), 'log-4', (_id, patch) => updates.push(patch))

    expect(sawRunning()).toBe(true)
    expect(updates.at(-1)?.status).toBe('failed')
    expect(statusOf()).toBe('idle')
    // The viewer gets a terminal turn_end carrying the error.
    const last = getRuntime(SID)?.buffer.at(-1) as { type?: string; reason?: string }
    expect(last?.type).toBe('turn_end')
    expect(last?.reason).toBe('error')
  })
})

describe('automation dispatcher — viewer runtime (codex)', () => {
  it('registers a runtime, broadcasts running, settles idle on success', async () => {
    codexStart.fn = () =>
      Promise.resolve({
        sessionId: async () => SID,
        messages: async function* () {
          yield {
            vendor: 'codex',
            sessionId: SID,
            role: 'assistant',
            ts: 0,
            blocks: [{ type: 'text', text: 'codex done' }],
          }
        },
      })

    const auto = claudeAutomation({
      vendor: 'codex',
      agentId: 'agent-codex',
      mode: { sandboxMode: 'read-only', approvalPolicy: 'never' },
    })
    const updates: Record<string, unknown>[] = []
    await execute(auto, 'log-5', (_id, patch) => updates.push(patch))

    expect(sawRunning()).toBe(true)
    expect(updates.at(-1)?.status).toBe('success')
    expect(statusOf()).toBe('idle')
    // Codex text diffs into an assistant_text wire event on the buffer.
    const buffer = getRuntime(SID)?.buffer ?? []
    expect(buffer.map((e) => e.type)).toEqual(['assistant_text', 'turn_end'])
  })
})
