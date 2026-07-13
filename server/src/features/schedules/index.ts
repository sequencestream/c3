/**
 * Time-schedule trigger — the fixed-interval (10s) tick loop that fires
 * cron-based automations when they come due.
 *
 * A tick queries the store for due automations and dispatches each via the shared
 * execution engine (`../automations/engine`), which enforces serial execution per
 * automation (SCH-R7) and publishes run lifecycle events. Event-triggered
 * automations are skipped here — they fire from `../triggers` instead.
 *
 * A workspace-level automation gate (`WorkspaceSetting.automationEnabled`) short-
 * circuits due items before the grace-window check and dispatch: when closed, the
 * tick re-arms the cron `nextRunAt` from the current time and moves on — no
 * dispatch, no missed-window log (a deliberate mute is not a system miss), and no
 * catch-up on re-open.
 */

import type { Automation } from '@ccc/shared/protocol'
import { getAutomationEnabled, getTimezone } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { isAgentQuotaRecoveryAutomation } from '../automations/store.js'
import { computeNextRunAt, dispatchAndTrack, getStore, inFlight } from '../automations/engine.js'

export { computeNextRunAt }

export interface AutomationScheduler {
  start(): void
  stop(timeoutMs?: number): Promise<void>
  triggerRunNow(automationId: string): Promise<void>
  cancelInFlight(automationId: string): void
  cancelAllForWorkspace(workspacePath: string): void
}

const GRACE_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_TICK_MS = 10_000 // 10 seconds

let timer: ReturnType<typeof setInterval> | null = null

/** Start the tick loop. No-op if no store is configured or already running. */
export function startScheduler(tickMs = DEFAULT_TICK_MS): void {
  if (timer !== null || !getStore()) return
  console.log('[scheduler] starting tick loop every %dms', tickMs)
  timer = setInterval(() => {
    tick().catch((err) => console.error('[scheduler] tick error:', err))
  }, tickMs)
}

/** Stop the tick loop and await in-flight executions. */
export async function stopScheduler(_timeoutMs = 30_000): Promise<void> {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
    console.log('[scheduler] tick loop stopped')
  }
  if (inFlight.size === 0) return
  console.log('[scheduler] waiting for %d in-flight executions...', inFlight.size)
  const results = await Promise.allSettled([...inFlight.values()].map((p) => p.catch(() => {})))
  const _timedOut = results.filter((r) => r.status === 'fulfilled' && r.value === undefined)
  console.log('[scheduler] %d executions settled', inFlight.size)
  inFlight.clear()
}

async function tick(): Promise<void> {
  const store = getStore()
  if (!store) return
  const now = Date.now()
  const due: Automation[] = []

  try {
    const rows = store.getDueAutomations(now)
    for (const s of rows) {
      if (s.status !== 'active') continue
      if (s.triggerType === 'event') continue // event automations never fire from the tick loop
      if (inFlight.has(s.id)) continue // SCH-R7: serial execution
      due.push(s)
    }
  } catch (err) {
    console.error('[scheduler] getDueAutomations failed:', err)
    return
  }

  // Cache the per-workspace gate for this tick so a workspace with many due
  // automations reads its config once, not once per automation.
  const gateCache = new Map<string, boolean>()
  const gateOpen = (workspacePath: string): boolean => {
    const cached = gateCache.get(workspacePath)
    if (cached !== undefined) return cached
    const open = getAutomationEnabled(workspacePath)
    gateCache.set(workspacePath, open)
    return open
  }

  for (const automation of due) {
    // Workspace automation gate: when closed, drop this due window without any
    // dispatch, missed-window log, or error. Re-arm the cron `nextRunAt` from the
    // current tick so the same stale instant is not reported next tick and so a
    // re-open only waits for the next future trigger (no catch-up). A failed
    // re-arm logs a scheduler diagnostic only — never a business execution log —
    // and the gate stays short-circuited so a re-arm fault cannot run the task.
    const workspacePath = resolveWorkspaceRoot(automation.workspaceId)
    if (workspacePath && !gateOpen(workspacePath)) {
      try {
        const next = computeNextRunAt(automation.cronExpression, now, getTimezone())
        store.updateNextRunAt(automation.id, next)
      } catch (rearmErr) {
        console.error('[scheduler] gate-closed re-arm failed for %s:', automation.id, rearmErr)
      }
      continue
    }

    // Grace window check
    if (
      automation.nextRunAt !== null &&
      automation.nextRunAt < now - GRACE_WINDOW_MS &&
      !isAgentQuotaRecoveryAutomation(automation)
    ) {
      console.warn(
        '[scheduler] automation %s missed trigger window (next_run_at=%d, now=%d)',
        automation.id,
        automation.nextRunAt,
        now,
      )
      try {
        store.appendExecutionLog({
          automationId: automation.id,
          startedAt: now,
          finishedAt: now,
          exitCode: null,
          output: '',
          error: 'missed_trigger_window',
        })
        // A delayed tick must not disable a recurring automation. Record the
        // missed occurrence, then re-arm it from the current time so that the
        // same stale instant cannot be reported on every following tick.
        const next = computeNextRunAt(automation.cronExpression, now, getTimezone())
        store.updateNextRunAt(automation.id, next)
      } catch (logErr) {
        console.error('[scheduler] failed to record missed trigger for %s:', automation.id, logErr)
      }
      continue
    }

    dispatchAndTrack(automation)
  }
}
