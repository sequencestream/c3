import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  isStoreAvailable,
  resetStoreForTests,
  createSchedule,
  updateSchedule,
  getSchedule,
  getDueSchedules,
  createWriteApproval,
  getWriteApproval,
  listPendingWriteApprovals,
  listExpiredPendingApprovals,
  resolveWriteApproval,
  getWorkspaceMcpConfig,
  saveWorkspaceMcpConfig,
  appendExecutionLog,
  listExecutionLogs,
  updateExecutionLog,
  getExecutionLog,
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

describe('write_approvals CRUD', () => {
  it('creates a pending approval and reads it back', () => {
    expect(isStoreAvailable()).toBe(true)
    const created = createWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: { filePath: '/a.txt', content: 'hi' },
      diffPreview: 'File: /a.txt',
      expiresAt: Date.now() + 60_000,
    })
    expect(created.status).toBe('pending')
    expect(created.toolName).toBe('Write')

    const fetched = getWriteApproval(created.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.scheduleId).toBe('sch-1')
    expect(fetched!.toolInput).toEqual({ filePath: '/a.txt', content: 'hi' })
  })

  it('lists pending approvals for a workspace (resolved excluded)', () => {
    const a = createWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: {},
      diffPreview: '',
      expiresAt: Date.now() + 60_000,
    })
    createWriteApproval({
      scheduleId: 'sch-2',
      workspacePath: proj,
      toolName: 'Edit',
      toolInput: {},
      diffPreview: '',
      expiresAt: Date.now() + 60_000,
    })

    expect(listPendingWriteApprovals(proj)).toHaveLength(2)

    resolveWriteApproval(a.id, 'approved', 'owner')
    const pending = listPendingWriteApprovals(proj)
    expect(pending).toHaveLength(1)
    expect(pending[0].toolName).toBe('Edit')
  })

  it('resolveWriteApproval is idempotent — second resolve returns false', () => {
    const a = createWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: {},
      diffPreview: '',
      expiresAt: Date.now() + 60_000,
    })
    expect(resolveWriteApproval(a.id, 'approved', 'owner')).toBe(true)
    expect(resolveWriteApproval(a.id, 'rejected', 'owner')).toBe(false)

    const fetched = getWriteApproval(a.id)
    expect(fetched!.status).toBe('approved')
    expect(fetched!.resolvedBy).toBe('owner')
  })

  it('listExpiredPendingApprovals returns only past-due pending entries', () => {
    // Already-expired pending entry
    createWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: {},
      diffPreview: '',
      expiresAt: Date.now() - 1_000,
    })
    // Future entry — not expired
    createWriteApproval({
      scheduleId: 'sch-2',
      workspacePath: proj,
      toolName: 'Edit',
      toolInput: {},
      diffPreview: '',
      expiresAt: Date.now() + 60_000,
    })

    const expired = listExpiredPendingApprovals()
    expect(expired).toHaveLength(1)
    expect(expired[0].scheduleId).toBe('sch-1')
  })
})

describe('createSchedule next_run_at backfill', () => {
  it('backfills next_run_at on create so the first run is dispatchable', () => {
    const sch = createSchedule({
      type: 'command',
      config: { command: 'echo hi' },
      workspacePath: proj,
      cronExpression: '*/5 * * * *',
      mcpMode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.nextRunAt).not.toBeNull()
    expect(sch.nextRunAt!).toBeGreaterThan(Date.now())

    // A tick far enough in the future must see this schedule as due.
    const due = getDueSchedules(sch.nextRunAt!)
    expect(due.map((s) => s.id)).toContain(sch.id)
  })

  it('leaves next_run_at null for an invalid cron rather than throwing', () => {
    const sch = createSchedule({
      type: 'command',
      config: {},
      workspacePath: proj,
      cronExpression: 'not a cron',
      mcpMode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.nextRunAt).toBeNull()
  })

  it('writes the server-supplied name into config and drops client name/description', () => {
    const sch = createSchedule(
      {
        type: 'command',
        config: { command: 'echo hi', name: 'client name', description: 'should be dropped' },
        workspacePath: proj,
        cronExpression: '*/5 * * * *',
        mcpMode: 'read-only',
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
    const sch = createSchedule({
      type: 'command',
      config: { command: 'pnpm build' },
      workspacePath: proj,
      cronExpression: '*/5 * * * *',
      mcpMode: 'read-only',
      vendor: 'claude',
    })
    expect((sch.config as Record<string, unknown>).name).toBe('pnpm build')
  })

  it('recomputes next_run_at when the cron expression is updated', () => {
    const sch = createSchedule({
      type: 'command',
      config: {},
      workspacePath: proj,
      cronExpression: '0 0 1 1 *', // yearly, far away
      mcpMode: 'read-only',
      vendor: 'claude',
    })
    const before = getSchedule(sch.id)!.nextRunAt!

    updateSchedule(sch.id, { cronExpression: '*/5 * * * *' })
    const after = getSchedule(sch.id)!.nextRunAt!
    expect(after).toBeLessThan(before)
    expect(after).toBeGreaterThan(Date.now())
  })
})

describe('vendor field', () => {
  it('persists the vendor specified on create', () => {
    const sch = createSchedule({
      type: 'command',
      config: { command: 'echo hi' },
      workspacePath: proj,
      cronExpression: '*/5 * * * *',
      mcpMode: 'read-only',
      vendor: 'codex',
    })
    expect(sch.vendor).toBe('codex')

    const fetched = getSchedule(sch.id)
    expect(fetched!.vendor).toBe('codex')
  })

  it('accepts all vendor values', () => {
    for (const v of ['claude', 'codex', 'opencode'] as const) {
      const sch = createSchedule({
        type: 'command',
        config: {},
        workspacePath: proj,
        cronExpression: '* * * * *',
        mcpMode: 'read-only',
        vendor: v,
      })
      expect(getSchedule(sch.id)!.vendor).toBe(v)
    }
  })

  it('updates vendor via updateSchedule', () => {
    const sch = createSchedule({
      type: 'command',
      config: { command: 'echo hi' },
      workspacePath: proj,
      cronExpression: '*/5 * * * *',
      mcpMode: 'read-only',
      vendor: 'claude',
    })
    expect(sch.vendor).toBe('claude')

    updateSchedule(sch.id, { vendor: 'opencode' })
    expect(getSchedule(sch.id)!.vendor).toBe('opencode')
  })
})

describe('updateSchedule — display name management', () => {
  function makeCmd(name?: string) {
    return createSchedule(
      {
        type: 'command',
        config: { command: 'echo hi' },
        workspacePath: proj,
        cronExpression: '*/5 * * * *',
        mcpMode: 'read-only',
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
    updateSchedule(sch.id, { config: { command: 'echo hi' } }, { name: 'My Title', source: 'user' })
    const cfg = getSchedule(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('My Title')
    expect(cfg.nameSource).toBe('user')
  })

  it('a user-set name is sticky across a later body-only update (no re-derivation)', () => {
    const sch = makeCmd('Auto Name')
    updateSchedule(sch.id, { config: { command: 'echo hi' } }, { name: 'My Title', source: 'user' })
    // A subsequent body-only update carries no nameOverride → name + provenance preserved.
    updateSchedule(sch.id, { config: { command: 'echo changed' } })
    const cfg = getSchedule(sch.id)!.config as Record<string, unknown>
    expect(cfg.command).toBe('echo changed')
    expect(cfg.name).toBe('My Title')
    expect(cfg.nameSource).toBe('user')
  })

  it('an auto nameOverride reverts the name and clears the user marker', () => {
    const sch = makeCmd('Auto Name')
    updateSchedule(sch.id, { config: { command: 'echo hi' } }, { name: 'My Title', source: 'user' })
    updateSchedule(
      sch.id,
      { config: { command: 'echo hi' } },
      { name: 'Regenerated', source: 'auto' },
    )
    const cfg = getSchedule(sch.id)!.config as Record<string, unknown>
    expect(cfg.name).toBe('Regenerated')
    expect(cfg.nameSource).toBeUndefined()
  })

  it('strips a client-injected name/nameSource when no override is given', () => {
    const sch = makeCmd('Auto Name')
    // Client tries to sneak a sticky marker + name in via config — both ignored.
    updateSchedule(sch.id, { config: { command: 'echo hi', name: 'sneaky', nameSource: 'user' } })
    const cfg = getSchedule(sch.id)!.config as Record<string, unknown>
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
  function makeSchedule() {
    return createSchedule({
      type: 'command',
      config: { command: 'echo hi' },
      workspacePath: proj,
      cronExpression: '*/5 * * * *',
      mcpMode: 'read-only',
      vendor: 'claude',
    })
  }

  it('returns a schedule logs most-recently-started first', () => {
    const sch = makeSchedule()
    // Insert out of chronological order to prove DESC ordering is by started_at.
    appendExecutionLog({
      scheduleId: sch.id,
      startedAt: 2_000,
      finishedAt: 2_500,
      exitCode: 0,
      output: 'second',
      error: null,
      status: 'success',
    })
    appendExecutionLog({
      scheduleId: sch.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 0,
      output: 'first',
      error: null,
      status: 'success',
    })
    appendExecutionLog({
      scheduleId: sch.id,
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

  it('filters by scheduleId — other schedules logs are excluded', () => {
    const a = makeSchedule()
    const b = makeSchedule()
    appendExecutionLog({
      scheduleId: a.id,
      startedAt: 1_000,
      finishedAt: 1_500,
      exitCode: 0,
      output: 'a',
      error: null,
      status: 'success',
    })
    appendExecutionLog({
      scheduleId: b.id,
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
    expect(logsA[0].scheduleId).toBe(a.id)
  })

  it('returns an empty array for a schedule with no logs', () => {
    const sch = makeSchedule()
    expect(listExecutionLogs(sch.id)).toEqual([])
  })

  it('round-trips sessionId: defaults null, persists on append, updatable later', () => {
    const sch = makeSchedule()

    // Default: append without sessionId → null.
    const a = appendExecutionLog({
      scheduleId: sch.id,
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
      scheduleId: sch.id,
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
