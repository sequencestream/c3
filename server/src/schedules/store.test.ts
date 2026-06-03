import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../db.js'
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
    })
    const before = getSchedule(sch.id)!.nextRunAt!

    updateSchedule(sch.id, { cronExpression: '*/5 * * * *' })
    const after = getSchedule(sch.id)!.nextRunAt!
    expect(after).toBeLessThan(before)
    expect(after).toBeGreaterThan(Date.now())
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
