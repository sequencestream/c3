import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// In isolation these synthetic paths are unregistered, so use them as opaque names.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  workspaceNameFor: (value: string) => value,
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  resetStoreForTests,
  createAutomation,
  updateAutomation,
  getAutomation,
  getAutomationDetail,
  listAutomations,
  getDueAutomations,
  getEventAutomations,
  getWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
  appendExecutionLog,
  listExecutionLogs,
  updateExecutionLog,
  getExecutionLog,
  deleteAutomation,
  runningAutomationIdsForWorkspace,
  reconcileStuckRunningExecutions,
  RESTART_INTERRUPTED_ERROR,
} from './store.js'

let dir: string
const proj = '/abs/workspace-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sch-db-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('createAutomation next_run_at backfill', () => {
  it('persists maxWallClockMs independently of task config and supports clearing it', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      maxWallClockMs: 120_000,
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.maxWallClockMs).toBe(120_000)
    expect((sch.config as Record<string, unknown>).maxWallClockMs).toBeUndefined()

    updateAutomation(sch.id, { maxWallClockMs: null })
    expect(getAutomation(sch.id)!.maxWallClockMs).toBeNull()
  })

  it('backfills next_run_at on create so the first run is dispatchable', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.nextRunAt).not.toBeNull()
    expect(sch.nextRunAt!).toBeGreaterThan(Date.now())

    // A tick far enough in the future must see this automation as due.
    const due = getDueAutomations(sch.nextRunAt!)
    expect(due.map((s) => s.id)).toContain(sch.id)
  })

  it('leaves next_run_at null for an invalid cron rather than throwing', () => {
    const sch = createAutomation({
      type: 'command',
      config: {},
      workspaceName: proj,
      cronExpression: 'not a cron',
      mode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.nextRunAt).toBeNull()
  })

  it('writes the server-supplied name into config and drops client name/description', () => {
    const sch = createAutomation(
      {
        type: 'command',
        config: { command: 'echo hi', name: 'client name', description: 'should be dropped' },
        workspaceName: proj,
        cronExpression: '*/5 * * * *',
        mode: 'read-only',
        vendor: 'claude',
      },
      'Generated Name',
    )
    const cfg = sch.config as Record<string, unknown>
    expect(cfg.name).toBe('Generated Name')
    expect(cfg.description).toBeUndefined()
    expect(cfg.command).toBe('echo hi')
  })

  it('falls back to a non-empty name when none is supplied', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'pnpm build' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    })
    expect((sch.config as Record<string, unknown>).name).toBe('pnpm build')
  })

  it('recomputes next_run_at when the cron expression is updated', () => {
    const sch = createAutomation({
      type: 'command',
      config: {},
      workspaceName: proj,
      cronExpression: '0 0 1 1 *', // yearly, far away
      mode: 'read-only',
      vendor: 'claude',
    })
    const before = getAutomation(sch.id)!.nextRunAt!

    updateAutomation(sch.id, { cronExpression: '*/5 * * * *' })
    const after = getAutomation(sch.id)!.nextRunAt!
    expect(after).toBeLessThan(before)
    expect(after).toBeGreaterThan(Date.now())
  })
})

describe('vendor field', () => {
  it('persists the vendor specified on create', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'codex',
    })
    expect(sch.vendor).toBe('codex')

    const fetched = getAutomation(sch.id)
    expect(fetched!.vendor).toBe('codex')
  })

  it('accepts all vendor values', () => {
    for (const v of ['claude', 'codex'] as const) {
      const sch = createAutomation({
        type: 'command',
        config: {},
        workspaceName: proj,
        cronExpression: '* * * * *',
        mode: 'read-only',
        vendor: v,
      })
      expect(getAutomation(sch.id)!.vendor).toBe(v)
    }
  })

  it('updates vendor via updateAutomation', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.vendor).toBe('claude')

    updateAutomation(sch.id, { vendor: 'codex' })
    expect(getAutomation(sch.id)!.vendor).toBe('codex')
  })
})

describe('updateAutomation — display name management', () => {
  function makeCmd(name?: string) {
    return createAutomation(
      {
        type: 'command',
        config: { command: 'echo hi' },
        workspaceName: proj,
        cronExpression: '*/5 * * * *',
        mode: 'read-only',
        vendor: 'claude',
      },
      name,
    )
  }

  it('create leaves nameSource unset (auto by default)', () => {
    const cfg = makeCmd('Auto Name').config as Record<string, unknown>
    expect(cfg.name).toBe('Auto Name')
    expect(cfg.nameSource).toBeUndefined()
  })

  it('a user nameOverride is persisted with nameSource=user', () => {
    const sch = makeCmd('Auto Name')
    updateAutomation(
      sch.id,
      { config: { command: 'echo hi' } },
      { name: 'My Title', source: 'user' },
    )
    const cfg = getAutomation(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('My Title')
    expect(cfg.nameSource).toBe('user')
  })

  it('a user-set name is sticky across a later body-only update (no re-derivation)', () => {
    const sch = makeCmd('Auto Name')
    updateAutomation(
      sch.id,
      { config: { command: 'echo hi' } },
      { name: 'My Title', source: 'user' },
    )
    // A subsequent body-only update carries no nameOverride → name + provenance preserved.
    updateAutomation(sch.id, { config: { command: 'echo changed' } })
    const cfg = getAutomation(sch.id)!.config as Record<string, unknown>
    expect(cfg.command).toBe('echo changed')
    expect(cfg.name).toBe('My Title')
    expect(cfg.nameSource).toBe('user')
  })

  it('an auto nameOverride reverts the name and clears the user marker', () => {
    const sch = makeCmd('Auto Name')
    updateAutomation(
      sch.id,
      { config: { command: 'echo hi' } },
      { name: 'My Title', source: 'user' },
    )
    updateAutomation(
      sch.id,
      { config: { command: 'echo hi' } },
      { name: 'Regenerated', source: 'auto' },
    )
    const cfg = getAutomation(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('Regenerated')
    expect(cfg.nameSource).toBeUndefined()
  })

  it('strips a client-injected name/nameSource when no override is given', () => {
    const sch = makeCmd('Auto Name')
    // Client tries to sneak a sticky marker + name in via config — both ignored.
    updateAutomation(sch.id, { config: { command: 'echo hi', name: 'sneaky', nameSource: 'user' } })
    const cfg = getAutomation(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('Auto Name') // existing preserved, not the client value
    expect(cfg.nameSource).toBeUndefined()
  })
})

describe('workspace_mcp_configs', () => {
  it('returns empty default when not set', () => {
    const config = getWorkspaceMcpConfig(proj)
    expect(config).toEqual({ mcpServers: {}, denylist: [] })
  })

  it('saves and reads back a config (upsert)', () => {
    saveWorkspaceMcpConfig(proj, {
      mcpServers: { c3: { command: 'node', args: ['s.js'] } },
      denylist: ['Bash'],
    })
    const config = getWorkspaceMcpConfig(proj)
    expect(config.mcpServers.c3).toEqual({ command: 'node', args: ['s.js'] })
    expect(config.denylist).toEqual(['Bash'])

    // Upsert overwrites
    saveWorkspaceMcpConfig(proj, { mcpServers: {}, denylist: ['Write'] })
    const updated = getWorkspaceMcpConfig(proj)
    expect(updated.mcpServers).toEqual({})
    expect(updated.denylist).toEqual(['Write'])
  })
})

describe('listExecutionLogs', () => {
  function makeAutomation() {
    return createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    })
  }

  it('returns a automation logs most-recently-started first', () => {
    const sch = makeAutomation()
    // Insert out of chronological order to prove DESC ordering is by started_at.
    appendExecutionLog({
      automationId: sch.id,
      startedAt: 2_000,
      finishedAt: 2_500,
      exitCode: 0,
      output: 'second',
      error: null,
      status: 'success',
    })
    appendExecutionLog({
      automationId: sch.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 0,
      output: 'first',
      error: null,
      status: 'success',
    })
    appendExecutionLog({
      automationId: sch.id,
      startedAt: 3_000,
      finishedAt: null,
      exitCode: null,
      output: 'third',
      error: null,
      status: 'running',
    })

    const logs = listExecutionLogs(sch.id)
    expect(logs).toHaveLength(3)
    expect(logs.map((l) => l.startedAt)).toEqual([3_000, 2_000, 1_000])
    expect(logs[0].status).toBe('running')
    expect(logs[0].finishedAt).toBeNull()
  })

  it('filters by automationId — other automations logs are excluded', () => {
    const a = makeAutomation()
    const b = makeAutomation()
    appendExecutionLog({
      automationId: a.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 0,
      output: 'a',
      error: null,
      status: 'success',
    })
    appendExecutionLog({
      automationId: b.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 1,
      output: 'b',
      error: 'boom',
      status: 'failed',
    })

    const logsA = listExecutionLogs(a.id)
    expect(logsA).toHaveLength(1)
    expect(logsA[0].output).toBe('a')
    expect(logsA[0].automationId).toBe(a.id)
  })

  it('returns an empty array for a automation with no logs', () => {
    const sch = makeAutomation()
    expect(listExecutionLogs(sch.id)).toEqual([])
  })

  it('round-trips sessionId: defaults null, persists on append, updatable later', () => {
    const sch = makeAutomation()

    // Default: append without sessionId → null.
    const a = appendExecutionLog({
      automationId: sch.id,
      startedAt: 1_000,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
    })
    expect(a.sessionId).toBeNull()
    expect(getExecutionLog(a.id)?.sessionId).toBeNull()

    // Append with sessionId → persisted and readable back.
    const b = appendExecutionLog({
      automationId: sch.id,
      startedAt: 2_000,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      sessionId: 'sess-append',
    })
    expect(b.sessionId).toBe('sess-append')
    expect(getExecutionLog(b.id)?.sessionId).toBe('sess-append')

    // updateExecutionLog can set sessionId after the fact (dispatcher path).
    updateExecutionLog(a.id, { sessionId: 'sess-later' })
    expect(getExecutionLog(a.id)?.sessionId).toBe('sess-later')
  })

  it('getExecutionLog returns null for an unknown id', () => {
    expect(getExecutionLog('nope')).toBeNull()
  })
})

describe('deleteAutomation', () => {
  function makeAutomation() {
    return createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    })
  }

  it('removes the automation and cascades its execution logs (hard delete)', () => {
    const sch = makeAutomation()
    appendExecutionLog({
      automationId: sch.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 0,
      output: 'ran',
      error: null,
      status: 'success',
    })
    appendExecutionLog({
      automationId: sch.id,
      startedAt: 2_000,
      finishedAt: null,
      exitCode: null,
      output: '',
      error: null,
      status: 'running',
    })
    expect(listExecutionLogs(sch.id)).toHaveLength(2)

    deleteAutomation(sch.id)

    expect(getAutomation(sch.id)).toBeNull()
    expect(listExecutionLogs(sch.id)).toEqual([])
  })

  it('only deletes the target automation — sibling automations and their logs survive', () => {
    const a = makeAutomation()
    const b = makeAutomation()
    appendExecutionLog({
      automationId: b.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 0,
      output: 'b',
      error: null,
      status: 'success',
    })

    deleteAutomation(a.id)

    expect(getAutomation(a.id)).toBeNull()
    expect(getAutomation(b.id)).not.toBeNull()
    expect(listExecutionLogs(b.id)).toHaveLength(1)
  })

  it('is a no-op for an unknown id', () => {
    expect(() => deleteAutomation('nope')).not.toThrow()
  })
})

describe('createAutomation import extensions (initialStatus / initialName)', () => {
  it('lands the automation paused in the same insert when initialStatus is paused', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      initialStatus: 'paused',
    })
    expect(sch.status).toBe('paused')
    // A paused cron automation is never returned as due even past its next_run_at.
    const due = getDueAutomations((sch.nextRunAt ?? Date.now()) + 60_000)
    expect(due.find((d) => d.id === sch.id)).toBeUndefined()
  })

  it('defaults to active when initialStatus is omitted', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.status).toBe('active')
  })

  it('preserves a supplied initialName as a sticky user-set config.name', () => {
    const sch = createAutomation(
      {
        type: 'command',
        config: { command: 'echo hi' },
        workspaceName: proj,
        cronExpression: '*/5 * * * *',
        mode: 'read-only',
        vendor: 'claude',
        initialName: 'My imported task',
      },
      'My imported task',
    )
    const cfg = sch.config as Record<string, unknown>
    expect(cfg.name).toBe('My imported task')
    expect(cfg.nameSource).toBe('user')
  })

  it('assigns a fresh id and the current workspace, ignoring any exported instance state', () => {
    const a = createAutomation({
      type: 'command',
      config: { command: 'echo a' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      initialStatus: 'paused',
      initialName: 'Imported A',
    })
    expect(a.id).toBeTruthy()
    expect(a.workspaceName).toBe(proj)
    expect(a.status).toBe('paused')
  })

  it('a paused event automation is not returned to the event dispatcher until enabled', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceName: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilters: [{ type: 'run:settled' }],
      eventSessionKindFilter: ['work'],
      mode: 'read-only',
      vendor: 'claude',
      initialStatus: 'paused',
    })
    // Paused ⇒ the event bus lookup ignores it, so no execution can fire.
    expect(getEventAutomations('run:settled').find((s) => s.id === sch.id)).toBeUndefined()
    // Manually enabling it makes it eligible for the existing dispatch path.
    updateAutomation(sch.id, { status: 'active' })
    expect(getEventAutomations('run:settled').find((s) => s.id === sch.id)).toBeDefined()
  })
})

describe('embedEventContext save boundary', () => {
  const readEmbed = (id: string): unknown =>
    (getAutomation(id)!.config as Record<string, unknown>).embedEventContext

  it('persists the flag for an event-triggered LLM task', () => {
    const s = createAutomation({
      type: 'llm',
      config: { prompt: 'go', embedEventContext: true },
      workspaceName: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilters: [{ type: 'run:settled' }],
      eventSessionKindFilter: ['work'],
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'a1',
    })
    expect(readEmbed(s.id)).toBe(true)
  })

  it('drops the flag for a command task even when the client sends true', () => {
    const s = createAutomation({
      type: 'command',
      config: { command: 'echo hi', embedEventContext: true },
      workspaceName: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilters: [{ type: 'run:settled' }],
      eventSessionKindFilter: ['work'],
      mode: 'read-only',
      vendor: 'claude',
    })
    expect(readEmbed(s.id)).toBeUndefined()
  })

  it('drops the flag for a cron-triggered LLM task', () => {
    const s = createAutomation({
      type: 'llm',
      config: { prompt: 'go', embedEventContext: true },
      workspaceName: proj,
      cronExpression: '0 8 * * *',
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'a1',
    })
    expect(readEmbed(s.id)).toBeUndefined()
  })

  it('coerces a non-strict-true value to off', () => {
    const s = createAutomation({
      type: 'llm',
      config: { prompt: 'go', embedEventContext: 'yes' } as unknown as Record<string, unknown>,
      workspaceName: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilters: [{ type: 'run:settled' }],
      eventSessionKindFilter: ['work'],
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'a1',
    })
    expect(readEmbed(s.id)).toBeUndefined()
  })

  it('drops a previously-enabled flag when an update switches the trigger to cron', () => {
    const s = createAutomation({
      type: 'llm',
      config: { prompt: 'go', embedEventContext: true },
      workspaceName: proj,
      triggerType: 'event',
      cronExpression: '',
      eventFilters: [{ type: 'run:settled' }],
      eventSessionKindFilter: ['work'],
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'a1',
    })
    expect(readEmbed(s.id)).toBe(true)
    // The form re-sends config together with the new trigger type on save.
    updateAutomation(s.id, {
      config: { prompt: 'go', embedEventContext: true },
      triggerType: 'cron',
      cronExpression: '0 8 * * *',
    })
    expect(readEmbed(s.id)).toBeUndefined()
  })
})

describe('runningSessionId derivation', () => {
  function makeAutomation(type: 'llm' | 'command') {
    return createAutomation({
      type,
      config: type === 'llm' ? { prompt: 'review' } : { command: 'echo hi' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      ...(type === 'llm' ? { agentId: 'agent-1' } : {}),
    })
  }

  function log(
    automationId: string,
    over: { startedAt?: number; status?: string; sessionId?: string | null; finishedAt?: number },
  ) {
    return appendExecutionLog({
      automationId,
      startedAt: over.startedAt ?? 1_000,
      finishedAt: over.finishedAt ?? null,
      exitCode: null,
      output: '',
      error: null,
      status: over.status ?? 'running',
      sessionId: over.sessionId ?? null,
    })
  }

  it('an LLM automation with a running log carrying a session id reports that id', () => {
    const s = makeAutomation('llm')
    log(s.id, { sessionId: 'sess-live' })
    expect(getAutomation(s.id)!.runningSessionId).toBe('sess-live')
    expect(listAutomations(proj)[0].runningSessionId).toBe('sess-live')
    expect(getAutomationDetail(s.id).automation!.runningSessionId).toBe('sess-live')
  })

  it('no running log at all → null', () => {
    const s = makeAutomation('llm')
    expect(getAutomation(s.id)!.runningSessionId).toBeNull()
    expect(listAutomations(proj)[0].runningSessionId).toBeNull()
  })

  it('a running log without a bound session id → null (empty string included)', () => {
    const s = makeAutomation('llm')
    log(s.id, { sessionId: null })
    log(s.id, { startedAt: 2_000, sessionId: '' })
    expect(getAutomation(s.id)!.runningSessionId).toBeNull()
  })

  it('a terminal log keeps the indicator dark even though it has a session id', () => {
    const s = makeAutomation('llm')
    log(s.id, { status: 'success', finishedAt: 1_500, sessionId: 'sess-done' })
    expect(getAutomation(s.id)!.runningSessionId).toBeNull()
  })

  it('a command automation never reports a session — only LLM tasks do', () => {
    const s = makeAutomation('command')
    log(s.id, { sessionId: 'sess-cmd' })
    expect(getAutomation(s.id)!.runningSessionId).toBeNull()
    expect(listAutomations(proj)[0].runningSessionId).toBeNull()
  })

  it('several running logs → the newest started_at wins, deterministically', () => {
    const s = makeAutomation('llm')
    log(s.id, { startedAt: 1_000, sessionId: 'sess-old' })
    log(s.id, { startedAt: 3_000, sessionId: 'sess-new' })
    log(s.id, { startedAt: 2_000, sessionId: 'sess-mid' })
    expect(getAutomation(s.id)!.runningSessionId).toBe('sess-new')
    expect(listAutomations(proj)[0].runningSessionId).toBe('sess-new')
  })

  it('the running session of one automation never leaks into a sibling row', () => {
    const running = makeAutomation('llm')
    const idle = makeAutomation('llm')
    log(running.id, { sessionId: 'sess-live' })
    const byId = new Map(listAutomations(proj).map((a) => [a.id, a.runningSessionId]))
    expect(byId.get(running.id)).toBe('sess-live')
    expect(byId.get(idle.id)).toBeNull()
  })
})

// 列表绿点(runningSessionId)与顶部角标(runningAutomationIdsForWorkspace)必须
// 从同一份数据库快照派生同一批「进行中」自动化 —— 逐场景断言两者严格一致。
describe('runningAutomationIdsForWorkspace mirrors runningSessionId', () => {
  function makeAutomation(type: 'llm' | 'command', workspaceName = proj) {
    return createAutomation({
      type,
      config: type === 'llm' ? { prompt: 'review' } : { command: 'echo hi' },
      workspaceName,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      ...(type === 'llm' ? { agentId: 'agent-1' } : {}),
    })
  }

  function log(
    automationId: string,
    over: { startedAt?: number; status?: string; sessionId?: string | null; finishedAt?: number },
  ) {
    return appendExecutionLog({
      automationId,
      startedAt: over.startedAt ?? 1_000,
      finishedAt: over.finishedAt ?? null,
      exitCode: null,
      output: '',
      error: null,
      status: over.status ?? 'running',
      sessionId: over.sessionId ?? null,
    })
  }

  it('两处口径对同一批数据逐条一致(llm/command/未绑定/终态/跨 workspace)', () => {
    const other = '/abs/workspace-b'
    const llmRunning = makeAutomation('llm')
    const cmdRunning = makeAutomation('command')
    const llmUnbound = makeAutomation('llm')
    const llmTerminal = makeAutomation('llm')
    const llmOtherWs = makeAutomation('llm', other)

    log(llmRunning.id, { sessionId: 'sess-live' })
    log(cmdRunning.id, { sessionId: 'sess-cmd' }) // command → 不亮
    log(llmUnbound.id, { sessionId: '' }) // 未绑定 session → 不亮
    log(llmTerminal.id, { status: 'success', finishedAt: 1_500, sessionId: 'sess-done' })
    log(llmOtherWs.id, { sessionId: 'sess-other' })

    // 唯一「进行中」自动化:proj 下的 llmRunning。
    expect(runningAutomationIdsForWorkspace(proj)).toEqual([llmRunning.id])

    // 对每个 automation,「角标包含它」严格等价于「它的 runningSessionId 非空」。
    const badge = new Set(runningAutomationIdsForWorkspace(proj))
    for (const a of listAutomations(proj)) {
      expect(badge.has(a.id)).toBe(a.runningSessionId !== null)
    }
    // 跨 workspace 不串位:other 的角标里是 llmOtherWs。
    expect(runningAutomationIdsForWorkspace(other)).toEqual([llmOtherWs.id])
  })

  it('去重:同一 llm 自动化的多条 running 日志仅计一次', () => {
    const s = makeAutomation('llm')
    log(s.id, { startedAt: 1_000, sessionId: 'sess-a' })
    log(s.id, { startedAt: 2_000, sessionId: 'sess-b' })
    expect(runningAutomationIdsForWorkspace(proj)).toEqual([s.id])
  })
})

// 崩溃/重启后遗留的 running 执行必须被幂等收尾为 failed,不再无限期卡在「进行中」。
describe('reconcileStuckRunningExecutions', () => {
  function makeAutomation() {
    return createAutomation({
      type: 'llm',
      config: { prompt: 'review' },
      workspaceName: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      agentId: 'agent-1',
    })
  }

  it('仅遗留 running 行转 failed 并写入 finished_at + 重启标识,终态行不动,第二次调用幂等', () => {
    const s = makeAutomation()
    const stuck = appendExecutionLog({
      automationId: s.id,
      startedAt: 1_000,
      finishedAt: null,
      exitCode: null,
      output: 'partial output',
      error: null,
      status: 'running',
      sessionId: 'sess-live',
    })
    const done = appendExecutionLog({
      automationId: s.id,
      startedAt: 2_000,
      finishedAt: 2_500,
      exitCode: 0,
      output: 'ok',
      error: null,
      status: 'success',
      sessionId: 'sess-done',
    })
    const alreadyFailed = appendExecutionLog({
      automationId: s.id,
      startedAt: 3_000,
      finishedAt: 3_500,
      exitCode: 1,
      output: 'boom',
      error: 'real failure',
      status: 'failed',
      sessionId: 'sess-fail',
    })

    const startTime = 9_999
    expect(reconcileStuckRunningExecutions(startTime)).toBe(1)

    const reconciled = getExecutionLog(stuck.id)!
    expect(reconciled.status).toBe('failed')
    expect(reconciled.finishedAt).toBe(startTime)
    expect(reconciled.error).toBe(RESTART_INTERRUPTED_ERROR)
    // 输出与会话 id 不改写。
    expect(reconciled.output).toBe('partial output')
    expect(reconciled.sessionId).toBe('sess-live')

    // 已终态记录及其字段原样保留。
    const doneAfter = getExecutionLog(done.id)!
    expect(doneAfter.status).toBe('success')
    expect(doneAfter.finishedAt).toBe(2_500)
    expect(doneAfter.exitCode).toBe(0)
    const failedAfter = getExecutionLog(alreadyFailed.id)!
    expect(failedAfter.status).toBe('failed')
    expect(failedAfter.error).toBe('real failure')
    expect(failedAfter.finishedAt).toBe(3_500)

    // 第二次调用不再改动任何行。
    expect(reconcileStuckRunningExecutions(startTime + 1)).toBe(0)
    expect(getExecutionLog(stuck.id)!.finishedAt).toBe(startTime)
  })

  it('无遗留 running 行时返回 0', () => {
    const s = makeAutomation()
    appendExecutionLog({
      automationId: s.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 0,
      output: 'ok',
      error: null,
      status: 'success',
      sessionId: 'sess-done',
    })
    expect(reconcileStuckRunningExecutions(9_999)).toBe(0)
  })
})
