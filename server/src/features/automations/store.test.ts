import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The store maps `workspace_path` <-> opaque `workspaceId` through the registry;
// in isolation these synthetic paths are unregistered, so stub resolve/pathToId
// as identity — fixtures use the path itself as the id and round-trip cleanly.
vi.mock('../../state.js', () => ({
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
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
  getDueAutomations,
  getEventAutomations,
  getWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
  appendExecutionLog,
  listExecutionLogs,
  updateExecutionLog,
  getExecutionLog,
  deleteAutomation,
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
      workspaceId: proj,
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
      workspaceId: proj,
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
      workspaceId: proj,
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
        workspaceId: proj,
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
      workspaceId: proj,
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
      workspaceId: proj,
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
      workspaceId: proj,
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
        workspaceId: proj,
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
      workspaceId: proj,
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
        workspaceId: proj,
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
      workspaceId: proj,
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
      workspaceId: proj,
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
      workspaceId: proj,
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
      workspaceId: proj,
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
        workspaceId: proj,
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
      workspaceId: proj,
      cronExpression: '*/5 * * * *',
      mode: 'read-only',
      vendor: 'claude',
      initialStatus: 'paused',
      initialName: 'Imported A',
    })
    expect(a.id).toBeTruthy()
    expect(a.workspaceId).toBe(proj)
    expect(a.status).toBe('paused')
  })

  it('a paused event automation is not returned to the event dispatcher until enabled', () => {
    const sch = createAutomation({
      type: 'command',
      config: { command: 'echo hi' },
      workspaceId: proj,
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
