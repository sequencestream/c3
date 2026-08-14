/**
 * Event trigger — dispatches event-triggered automations in response to any
 * generic event: a run lifecycle event (2026-06-08), a model-published PR
 * operation event (2026-06-20), an intent lifecycle event, or a future event
 * type that no code here mentions by name.
 *
 * Wired to the kernel event bus in the composition root: an event arrives already
 * projected onto the trusted minimal {@link TriggerEventView}, and every active
 * event-trigger automation that matches is executed via the SAME path as a cron
 * run (the shared execution engine's `dispatchAndTrack`), reusing the three-tier
 * MCP security model and the write-approval queue.
 *
 * The per-automation match decision is a single generic filter (type + statuses +
 * metadata) evaluated by the pure {@link evaluateAutomationTriggerMatch}, which
 * layers the optional run-lifecycle `eventSessionKindFilter` (a non-empty
 * whitelist; absent/empty = every session kind) on top of the shared
 * `genericEventFilterMatches`. There are no per-type branches: a new
 * event type triggers automations by publishing a registered generic event and
 * configuring string filter values — no protocol enum, dispatch branch, or form
 * panel required.
 *
 * A workspace-level automation gate (`WorkspaceSetting.automationEnabled`) is
 * checked first: when the event's target workspace has the gate closed, the whole
 * dispatch returns before any candidate matching or execution, and the event is
 * dropped (not queued).
 */

import { resolve } from 'node:path'
import type { Automation, SessionKind } from '@ccc/shared/protocol'
import type { GenericEvent } from '@ccc/shared'
import { hasRunLifecycleEventFilter } from '@ccc/shared'
import {
  genericEventFiltersMatch,
  type GenericEventFilterBreakdownItem,
} from '../../kernel/events/event-match.js'
import { getAutomationEnabled } from '../../kernel/config/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { dispatchAndTrack, getStore, inFlight } from '../automations/engine.js'

/**
 * The trusted minimal view a matcher reads for one incoming event. `workspacePath`
 * + `event` come straight off the bus envelope (the model cannot forge another
 * workspace). `sessionKind` is present ONLY for run-lifecycle events — it is the
 * input a non-empty `eventSessionKindFilter` whitelist is checked against, and is
 * absent for PR / intent / any other event type (which carry no session origin).
 */
export interface TriggerEventView {
  workspacePath: string
  event: GenericEvent
  sessionKind?: SessionKind
}

/** One dimension's pass/fail in a trigger-match breakdown. */
export type TriggerMatchBreakdownItem =
  { name: 'sessionKind'; passed: boolean } | GenericEventFilterBreakdownItem

/** The full result of a trigger match: overall verdict + per-dimension breakdown. */
export interface TriggerMatchResult {
  matched: boolean
  breakdown: TriggerMatchBreakdownItem[]
}

/**
 * 只在**显式白名单**下才参与自动化触发的会话场景。
 *
 * 一次性 advisor 调用(共识投票、判定、编排者笔记)也会发 run 生命周期事件,好让
 * 它们在日志与审计里可见;但它们的频次远高于用户可见的 run,且几乎从不是用户想
 * 触发自动化的那种「run」。若让它们落进「空过滤器 = 所有场景」的默认语义,一个既
 * 有的 `run:settled` 订阅会突然被每一次投票唤醒。因此这类场景反过来:必须由
 * `eventSessionKindFilter` 点名,才会参与匹配。
 */
const OPT_IN_ONLY_SESSION_KINDS: readonly SessionKind[] = ['tool']

/**
 * Pure evaluator: does `view` match any of `automation`'s subscription rows? When
 * any row subscribes a run-lifecycle type (`run:started` / `run:settled` /
 * `run:*`) AND the automation has a NON-EMPTY `eventSessionKindFilter`, it FIRST
 * applies that filter as an exact whitelist — an event whose `sessionKind` is not
 * in it (or that carries no session origin) fails — then the shared generic match
 * (any row: workspace + type + status + metadata). An absent/empty filter means
 * "every session kind" and skips the sessionKind dimension entirely, EXCEPT for
 * the opt-in-only kinds in {@link OPT_IN_ONLY_SESSION_KINDS}, which an empty
 * filter never matches. For every other type only the generic match runs (a PR /
 * intent event carries no sessionKind). The breakdown reports the sessionKind
 * dimension (only when it applied) followed by the generic dimensions of the
 * matching (or last evaluated) row under their vendor-neutral names.
 */
export function evaluateAutomationTriggerMatch(
  automation: Automation,
  view: TriggerEventView,
): TriggerMatchResult {
  const filters = automation.eventFilters ?? null
  const breakdown: TriggerMatchBreakdownItem[] = []

  const skf = automation.eventSessionKindFilter
  const isRunLifecycle = hasRunLifecycleEventFilter(filters) && view.event.type.startsWith('run:')
  const whitelist = skf && skf.length > 0 ? skf : null
  if (
    isRunLifecycle &&
    !whitelist &&
    !!view.sessionKind &&
    OPT_IN_ONLY_SESSION_KINDS.includes(view.sessionKind)
  ) {
    // 空过滤器对这些场景不再意味着「全都要」—— 没点名就是不匹配。
    breakdown.push({ name: 'sessionKind', passed: false })
  } else if (isRunLifecycle && whitelist) {
    // The sessionKind filter is optional: an absent/empty filter means "every
    // session kind" and skips this dimension entirely (including events with no
    // session origin). Only a NON-EMPTY filter is enforced, as an exact
    // whitelist — the event's `sessionKind` must be a member, so an event with no
    // session origin never matches a non-empty filter. It runs BEFORE the generic
    // match so a generic metadata filter can never widen the run-source scope.
    // With multi-row subscriptions the gate applies exactly to incoming RUN events
    // on an automation that subscribes run lifecycle — a pr/intent event on the
    // same automation is matched by its own non-run row and carries no sessionKind.
    breakdown.push({
      name: 'sessionKind',
      passed: !!view.sessionKind && whitelist.includes(view.sessionKind),
    })
  }

  const generic = genericEventFiltersMatch(
    resolveWorkspaceRoot(automation.workspaceName)!,
    filters,
    {
      workspacePath: resolve(view.workspacePath),
      event: view.event,
    },
  )
  breakdown.push(...generic.breakdown)

  return { matched: breakdown.every((b) => b.passed), breakdown }
}

/**
 * Dispatch event-triggered automations for one incoming event.
 *
 * The workspace automation gate is checked first (a closed gate drops the whole
 * dispatch, no queueing). Every active event-trigger automation is then matched
 * via the shared {@link evaluateAutomationTriggerMatch}; a single candidate whose
 * evaluation throws fails closed (logged by id, skipped) without affecting the
 * others. A matched automation with no in-flight execution is dispatched; SCH-R7
 * serial execution doubles as event-storm throttling.
 */
export function dispatchEventTriggers(view: TriggerEventView): void {
  const store = getStore()
  if (!store) return

  // Workspace automation gate: resolve the event's target workspace and, when the
  // gate is closed, drop the whole dispatch before any candidate matching, in-flight
  // warning, or execution log. Suppressed events are not queued — a re-open only
  // acts on newly arriving events, never a backlog.
  const workspacePath = resolve(view.workspacePath)
  if (!getAutomationEnabled(workspacePath)) return

  let candidates: Automation[]
  try {
    candidates = store.getEventAutomations(view.event.type)
  } catch (err) {
    console.error('[scheduler] getEventAutomations failed for %s:', view.event.type, err)
    return
  }

  for (const automation of candidates) {
    if (automation.status !== 'active') continue
    let matched: boolean
    try {
      matched = evaluateAutomationTriggerMatch(automation, view).matched
    } catch (err) {
      // Fail closed on a single bad candidate — never let it block other candidates
      // for the same event. Log the automation id (never the raw event) for triage.
      console.error('[scheduler] trigger match failed for automation %s:', automation.id, err)
      continue
    }
    if (!matched) continue
    // SCH-R7 / event-storm throttle: one in-flight execution per automation.
    if (inFlight.has(automation.id)) {
      console.warn(
        '[scheduler] event %s: automation %s already in flight, skipping',
        view.event.type,
        automation.id,
      )
      continue
    }
    // Hand the matched normalized event to the dispatcher as this execution's
    // immutable trigger context (an opted-in LLM task embeds it in its prompt).
    dispatchAndTrack(automation, view.event)
  }
}
