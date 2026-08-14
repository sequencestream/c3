import { parseQuotaResetAt, setAgentEnabled, resolveAgent } from '../kernel/agent-config/index.js'
import { getTimezone } from '../kernel/config/index.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'
import {
  createAgentQuotaRecoveryAutomation,
  findAgentQuotaRecoveryAutomation,
  isAgentQuotaRecoveryConfig,
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
    // Dedup: concurrent quota errors for the same agent (parallel sessions each
    // hitting a usage/session limit, or rapid repeats) would otherwise create one
    // recovery automation per error — all pointing at the same reset moment, all
    // doing the same re-enable. Reuse a still-existing recovery automation and
    // keep the first resetAt; the row is gone once it fires and self-deletes, so
    // the next error then creates a fresh one.
    const existing = findAgentQuotaRecoveryAutomation(input.workspacePath, input.agentId)
    if (existing) {
      const agent = resolveAgent(input.agentId)
      // The reused row already recorded the first authoritative resetAt; return
      // that, not this parse (a repeat error may carry a different reset moment).
      const authoritativeResetAt = isAgentQuotaRecoveryConfig(existing.config)
        ? existing.config.resetAt
        : resetAt
      console.warn(
        '[agent-quota-recovery] agent %s (%s) already has a pending recovery automation %s; reuse it',
        agent.id,
        agent.displayName,
        existing.id,
      )
      return {
        handled: true,
        resetAt: authoritativeResetAt,
        disabled: true,
        automationId: existing.id,
      }
    }
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
