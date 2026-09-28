/**
 * The dispatcher's workspace gate and session projection, as the PR relay meets them.
 *
 * The relay is an INTERNAL caller: it holds the intent's workspace PATH and hands
 * that straight to `execute` as `automation.workspaceName`, while a saved automation
 * persists a NAME. Two things must therefore hold, and neither is visible from the
 * automation side of the product:
 *
 *  - the gate accepts EITHER form, so a relay turn is not refused with
 *    `automation_workspace_not_found` before it ever launches;
 *  - an execution that declared a projection writes THAT row (intent-owned, work
 *    kind, phase title) rather than the automation execution row — otherwise the
 *    review / fix session is filed under 「自动化」 and vanishes from the intent's
 *    own session list.
 *
 * The real `state.js` resolver is used with a REAL registry (a temp dir registered
 * as a workspace), because the whole failure was a resolution rule and a mocked
 * resolver would assert the mock. Everything the vendor would touch is faked: no
 * network, no child process, no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => ({ agents: [{ id: 'agent-1', enabled: true, vendor: 'claude' }] }),
  resetSettingsCacheForTests: () => {},
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  launchForAgent: () => ({ model: 'test-model', envOverrides: {} }),
  isModelProviderPausedError: () => false,
  setAgentEnabled: () => true,
  bindClaudeRelay: () => null,
  unbindRelay: () => {},
  freezeSessionAgent: () => undefined,
}))
vi.mock('../../kernel/infra/child-env.js', () => ({
  buildChildEnv: () => ({}),
  findClaudeExecutable: () => undefined,
}))
vi.mock('./store.js', () => ({
  getWorkspaceMcpConfig: () => ({ mcpServers: {} }),
  isAgentQuotaRecoveryConfig: () => false,
}))

const upsertBoundRow = vi.hoisted(() => ({ fn: vi.fn() }))
const upsertAutomationExecutionRow = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../sessions/session-metadata-store.js', () => ({
  upsertBoundRow: (input: unknown) => upsertBoundRow.fn(input),
  upsertAutomationExecutionRow: (input: unknown) => upsertAutomationExecutionRow.fn(input),
}))

const queryImpl = vi.hoisted(() => ({
  fn: (_o: unknown): AsyncIterable<unknown> => emptyGen(),
}))
async function* emptyGen(): AsyncGenerator<unknown> {
  /* replaced per test */
}
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (o: unknown) => queryImpl.fn(o) }))

import type { Automation } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'
import { execute, type RelaySessionProjection } from './dispatcher.js'

const SID = 'relay-agent-session'
const INTENT_ID = 'intent-relay-1'

let dir: string
let proj: string
let workspaceName: string
let prevC3Dir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-relay-ws-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
  proj = dir
  upsertBoundRow.fn.mockClear()
  upsertAutomationExecutionRow.fn.mockClear()
  // One SDK frame carrying a session id is all the bind path needs.
  queryImpl.fn = () =>
    (async function* () {
      yield { type: 'system', session_id: SID }
      yield { type: 'result' }
    })()
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  vi.clearAllMocks()
  delete process.env.C3_DB_PATH
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  rmSync(dir, { recursive: true, force: true })
})

/** A relay-shaped execution: an in-memory record naming a workspace by EITHER form. */
function relayExecution(workspaceNameOrPath: string): Automation {
  return {
    id: 'relay:exec-1',
    type: 'llm',
    config: { prompt: 'review the PR' },
    maxWallClockMs: 60_000,
    workspaceName: workspaceNameOrPath,
    triggerType: 'event',
    cronExpression: '',
    nextRunAt: null,
    eventFilters: null,
    eventSessionKindFilter: null,
    metadata: {},
    runningSessionId: null,
    status: 'active',
    mode: 'bypassPermissions',
    toolAllowlist: [],
    toolDenylist: [],
    vendor: 'claude',
    agentId: 'agent-1',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as Automation
}

const projection: RelaySessionProjection = {
  intentId: INTENT_ID,
  title: 'PR 评审:接力目标',
  sessionKind: 'work',
}

async function run(over: {
  workspaceNameOrPath: string
  projection?: RelaySessionProjection
  cwd?: string
}): Promise<Record<string, unknown>[]> {
  const patches: Record<string, unknown>[] = []
  await execute(
    relayExecution(over.workspaceNameOrPath),
    'log-1',
    (_id, patch) => patches.push(patch),
    undefined,
    {
      cwd: over.cwd,
      ...(over.projection ? { sessionProjection: over.projection } : {}),
    },
  )
  return patches
}

describe('relay execution — the workspace gate accepts a name OR a registered path', () => {
  it('binds a session when the relay passes the registered NAME', async () => {
    const patches = await run({ workspaceNameOrPath: workspaceName })
    expect(patches.map((p) => p.error)).not.toContain('automation_workspace_not_found')
    expect(patches.some((p) => p.sessionId === SID)).toBe(true)
  })

  it('binds a session when the relay passes the registered PATH (the real relay shape)', async () => {
    // The relay holds `RelayPhaseEnv.workspacePath`, an absolute path, and hands it
    // over unchanged. This is the form that used to fail the gate outright.
    const patches = await run({ workspaceNameOrPath: proj })
    expect(patches.map((p) => p.error)).not.toContain('automation_workspace_not_found')
    expect(patches.some((p) => p.sessionId === SID)).toBe(true)
  })

  it('still refuses an UNREGISTERED workspace — the gate is not loosened, only widened', async () => {
    const patches = await run({ workspaceNameOrPath: join(dir, 'never-registered') })
    expect(patches).toContainEqual(
      expect.objectContaining({ status: 'failed', error: 'automation_workspace_not_found' }),
    )
  })
})

describe('relay execution — the session projection belongs to the INTENT', () => {
  it('writes the declared row, never an automation execution row', async () => {
    await run({ workspaceNameOrPath: proj, projection, cwd: join(proj, 'wt', INTENT_ID) })
    expect(upsertAutomationExecutionRow.fn).not.toHaveBeenCalled()
    expect(upsertBoundRow.fn).toHaveBeenCalledTimes(1)
    expect(upsertBoundRow.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SID,
        workspacePath: proj,
        vendor: 'claude',
        agentId: 'agent-1',
        title: 'PR 评审:接力目标',
        sessionKind: 'work',
        ownerKind: 'intent',
        ownerId: INTENT_ID,
      }),
    )
  })

  it('leaves the automation execution row alone for a saved automation that declared nothing', async () => {
    await run({ workspaceNameOrPath: workspaceName })
    expect(upsertBoundRow.fn).not.toHaveBeenCalled()
    expect(upsertAutomationExecutionRow.fn).toHaveBeenCalledTimes(1)
  })
})
