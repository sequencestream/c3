/**
 * Automation execution surfaces its real agent session as `running` in the shared
 * `session_status` snapshot for the duration of the run, then clears it on every
 * terminal path (success, thrown error). This is the server half of the 「自动化」tab
 * running-dot feature: the dispatcher runs off the kernel run bus, so it registers a
 * lightweight running flag (`runs.ts`) instead of a full `SessionRuntime`.
 *
 * The real `runs.ts` registry is used (NOT mocked) so we can assert its effect on
 * `listStatuses()`; everything the dispatcher touches around the SDK/driver is mocked
 * so no network / child process is spawned.
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

import type { Automation } from '@ccc/shared/protocol'
import { execute } from './dispatcher.js'
import { listStatuses, setOnStatusChange, clearAutomationRunning } from '../../runs.js'

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
  clearAutomationRunning(SID)
})

function sawRunning(): boolean {
  return snapshots.some((snap) => snap[SID] === 'running')
}

describe('automation dispatcher — running-status broadcast (claude)', () => {
  it('broadcasts running mid-run and clears it on success', async () => {
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
    // Terminal state reached success, and the running flag is cleared afterwards.
    expect(updates.at(-1)?.status).toBe('success')
    expect(listStatuses().some((s) => s.sessionId === SID)).toBe(false)
  })

  it('clears the running flag when the run throws after binding a session', async () => {
    queryImpl.fn = () =>
      (async function* () {
        yield { type: 'system', session_id: SID }
        throw new Error('sdk blew up')
      })()

    const updates: Record<string, unknown>[] = []
    await execute(claudeAutomation(), 'log-2', (_id, patch) => updates.push(patch))

    expect(sawRunning()).toBe(true)
    expect(updates.at(-1)?.status).toBe('failed')
    expect(listStatuses().some((s) => s.sessionId === SID)).toBe(false)
  })
})

describe('automation dispatcher — running-status broadcast (codex)', () => {
  it('broadcasts running mid-run and clears it on success', async () => {
    codexStart.fn = () =>
      Promise.resolve({
        sessionId: async () => SID,
        messages: async function* () {
          yield { blocks: [{ type: 'text', text: 'codex done' }] }
        },
      })

    const auto = claudeAutomation({
      vendor: 'codex',
      agentId: 'agent-codex',
      mode: { sandboxMode: 'read-only', approvalPolicy: 'never' },
    })
    const updates: Record<string, unknown>[] = []
    await execute(auto, 'log-3', (_id, patch) => updates.push(patch))

    expect(sawRunning()).toBe(true)
    expect(updates.at(-1)?.status).toBe('success')
    expect(listStatuses().some((s) => s.sessionId === SID)).toBe(false)
  })
})
