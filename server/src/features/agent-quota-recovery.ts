import { parseQuotaResetAt, setAgentEnabled, resolveAgent } from '../kernel/agent-config/index.js'
import { getTimezone } from '../kernel/config/index.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import {
  createAgentQuotaRecoverySchedule,
  isStoreAvailable as isScheduleStoreAvailable,
} from './schedules/store.js'

export interface AgentQuotaRecoveryResult {
  handled: boolean
  resetAt: number | null
  disabled: boolean
  scheduleId: string | null
}

export function handleAgentQuotaError(input: {
  agentId: string
  workspacePath: string
  error: string
  now?: number
}): AgentQuotaRecoveryResult {
  const resetAt = parseQuotaResetAt(input.error, getTimezone(), input.now)
  if (resetAt === null) {
    return { handled: false, resetAt, disabled: false, scheduleId: null }
  }

  const disabled = setAgentEnabled(input.agentId, false)
  if (!disabled) {
    console.warn('[agent-quota-recovery] agent %s not found; skip recovery schedule', input.agentId)
    return { handled: true, resetAt, disabled: false, scheduleId: null }
  }

  if (!isScheduleStoreAvailable()) {
    console.warn(
      '[agent-quota-recovery] schedule store unavailable; agent disabled without recovery',
    )
    return { handled: true, resetAt, disabled: true, scheduleId: null }
  }

  try {
    const schedule = createAgentQuotaRecoverySchedule({
      workspacePath: input.workspacePath,
      agentId: input.agentId,
      resetAt,
    })
    const agent = resolveAgent(input.agentId)
    console.warn(
      '[agent-quota-recovery] disabled agent %s (%s) until %s via schedule %s',
      agent.id,
      agent.displayName,
      new Date(resetAt).toISOString(),
      schedule.id,
    )
    return { handled: true, resetAt, disabled: true, scheduleId: schedule.id }
  } catch (err) {
    console.warn('[agent-quota-recovery] failed to create recovery schedule:', err)
    return { handled: true, resetAt, disabled: true, scheduleId: null }
  }
}

export function registerAgentQuotaRecovery(deps: { eventBus: EventBus<EventBusEvents> }): void {
  deps.eventBus.subscribe('agent:error', (event) => {
    handleAgentQuotaError({
      agentId: event.agentId,
      workspacePath: event.workspacePath,
      error: event.error,
    })
  })
}
