import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Stub only the registry id↔path mapping (identity): the test's synthetic
// workspace is unregistered, so resolve/pathToId would otherwise return null.
vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import type { AgentConfig, SystemSettings } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { resetDbForTests } from '../kernel/infra/db.js'
import { loadSettings, resetSettingsCacheForTests, saveSettings } from '../kernel/config/index.js'
import {
  appendExecutionLog,
  getDueSchedules,
  getEventSchedules,
  getSchedule,
  listSchedules,
  resetStoreForTests,
  updateExecutionLog,
  updateNextRunAt,
  updateSchedule,
} from './schedules/store.js'
import { handleAgentQuotaError } from './agent-quota-recovery.js'
import { setExecutionStore, stopScheduler, triggerRunNow } from './schedules/scheduler.js'

let dir: string
let prevHome: string | undefined
const workspacePath = '/tmp/c3-agent-quota-recovery-workspace'

const systemAgent: AgentConfig = {
  id: SYSTEM_AGENT_ID,
  vendor: 'claude',
  configMode: 'system',
  displayName: 'System',
  enabled: true,
  order_seq: 0,
  config: { baseUrl: '', apiKey: '', model: '' },
}

const quotaAgent: AgentConfig = {
  id: 'quota-agent',
  vendor: 'claude',
  configMode: 'custom',
  displayName: 'Quota Agent',
  enabled: true,
  order_seq: 1,
  config: { baseUrl: 'https://example.test', apiKey: 'k', model: 'm' },
}

function saveBaselineSettings(): void {
  saveSettings({
    agents: [systemAgent, quotaAgent],
    defaultAgentId: quotaAgent.id,
    toolAgentId: quotaAgent.id,
    timezone: 'Asia/Shanghai',
  } as SystemSettings)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-agent-quota-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetSettingsCacheForTests()
  resetDbForTests()
  resetStoreForTests()
  saveBaselineSettings()
})

afterEach(async () => {
  await stopScheduler()
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  delete process.env.C3_DB_PATH
  resetSettingsCacheForTests()
  resetDbForTests()
  resetStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

function wireRealScheduleStore(): void {
  setExecutionStore({
    getDueSchedules,
    getEventSchedules,
    getSchedule,
    updateNextRunAt,
    updateSchedule: (id, patch) => {
      updateSchedule(id, {
        status: patch.status as import('@ccc/shared/protocol').ScheduleStatus | undefined,
      })
    },
    appendExecutionLog: (input) =>
      appendExecutionLog({
        scheduleId: input.scheduleId,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        exitCode: input.exitCode,
        output: input.output,
        error: input.error,
        status: 'running',
      }),
    updateExecutionLog,
  })
}

async function waitForScheduleIdle(scheduleId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const schedule = getSchedule(scheduleId)
    if (schedule?.status === 'paused') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('agent quota recovery', () => {
  it('disables the agent and creates a one-shot recovery schedule', () => {
    const now = Date.UTC(2026, 5, 15, 13, 0)
    const result = handleAgentQuotaError({
      agentId: quotaAgent.id,
      workspacePath,
      error: "You've hit your session limit · resets 10:40pm (Asia/Shanghai)",
      now,
    })

    expect(result.handled).toBe(true)
    expect(result.disabled).toBe(true)
    expect(result.resetAt).toBe(Date.UTC(2026, 5, 15, 14, 40))
    expect(result.scheduleId).toEqual(expect.any(String))

    const settings = loadSettings()
    expect(settings.agents.find((agent) => agent.id === quotaAgent.id)?.enabled).toBe(false)
    expect(settings.defaultAgentId).toBe(SYSTEM_AGENT_ID)
    expect(settings.toolAgentId).toBe(SYSTEM_AGENT_ID)

    const schedules = listSchedules(workspacePath)
    expect(schedules).toHaveLength(1)
    expect(schedules[0].nextRunAt).toBe(result.resetAt)
  })

  it('does nothing when reset time cannot be parsed', () => {
    const result = handleAgentQuotaError({
      agentId: quotaAgent.id,
      workspacePath,
      error: "You've hit your session limit",
    })

    expect(result).toEqual({ handled: false, resetAt: null, disabled: false, scheduleId: null })
    expect(loadSettings().agents.find((agent) => agent.id === quotaAgent.id)?.enabled).toBe(true)
    expect(listSchedules(workspacePath)).toHaveLength(0)
  })

  it('re-enables the agent when the recovery schedule fires and then pauses itself', async () => {
    const now = Date.UTC(2026, 5, 15, 13, 0)
    const result = handleAgentQuotaError({
      agentId: quotaAgent.id,
      workspacePath,
      error: "You've hit your session limit · resets 10:40pm (Asia/Shanghai)",
      now,
    })
    expect(result.scheduleId).toEqual(expect.any(String))
    const scheduleId = result.scheduleId!
    updateNextRunAt(scheduleId, Date.now() - 10)

    wireRealScheduleStore()
    await triggerRunNow(scheduleId)
    await waitForScheduleIdle(scheduleId)

    const settings = loadSettings()
    expect(settings.agents.find((agent) => agent.id === quotaAgent.id)?.enabled).toBe(true)
    const schedule = getSchedule(scheduleId)!
    expect(schedule.status).toBe('paused')
    expect(schedule.nextRunAt).toBeNull()
  })
})
