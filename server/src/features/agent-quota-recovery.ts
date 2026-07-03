import { parseQuotaResetAt, setAgentEnabled, resolveAgent } from '../kernel/agent-config/index.js'
import { getTimezone } from '../kernel/config/index.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import {
  createAgentQuotaRecoveryAutomation,
  isStoreAvailable as isAutomationStoreAvailable,
} from './automations/store.js'

export interface AgentQuotaRecoveryResult {
  handled: boolean
  resetAt: number | null
  disabled: boolean
  automationId: string | null
}

export function handleAgentQuotaError(input: {
  agentId: string
  workspacePath: string
  error: string
  now?: number
}): AgentQuotaRecoveryResult {
  const resetAt = parseQuotaResetAt(input.error, getTimezone(), input.now)
  if (resetAt === null) {
    return { handled: false, resetAt, disabled: false, automationId: null }
  }

  const disabled = setAgentEnabled(input.agentId, false)
  if (!disabled) {
    console.warn(
      '[agent-quota-recovery] agent %s not found; skip recovery automation',
      input.agentId,
    )
    return { handled: true, resetAt, disabled: false, automationId: null }
  }

  if (!isAutomationStoreAvailable()) {
    console.warn(
      '[agent-quota-recovery] automation store unavailable; agent disabled without recovery',
    )
    return { handled: true, resetAt, disabled: true, automationId: null }
  }

  try {
    const automation = createAgentQuotaRecoveryAutomation({
      workspacePath: input.workspacePath,
      agentId: input.agentId,
      resetAt,
    })
    const agent = resolveAgent(input.agentId)
    console.warn(
      '[agent-quota-recovery] disabled agent %s (%s) until %s via automation %s',
      agent.id,
      agent.displayName,
      new Date(resetAt).toISOString(),
      automation.id,
    )
    return { handled: true, resetAt, disabled: true, automationId: automation.id }
  } catch (err) {
    console.warn('[agent-quota-recovery] failed to create recovery automation:', err)
    return { handled: true, resetAt, disabled: true, automationId: null }
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
