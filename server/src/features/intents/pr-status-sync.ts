import type { Intent, IntentPr, IntentPrStatus } from '@ccc/shared/protocol'
import { deriveIntentPrAggregate } from '@ccc/shared'
import type { KernelContext } from '../../kernel/types.js'
import { getForgeOverride } from '../../kernel/config/index.js'
import { getForgePrStatus } from '../../git.js'
import { pathToName } from '../../state.js'
import {
  getIntent,
  listIntentPrs,
  listIntents,
  listReviewingIntentPrs,
  safeInsertIntentLog,
  upsertIntentPr,
} from './store.js'

export interface IntentPrSyncResult {
  ok: boolean
  intentId: string
  /** The intent's AGGREGATE PR status after the pass; absent when it owns no PR. */
  prStatus?: IntentPrStatus
  /** True when at least one PR row moved to a terminal state. */
  changed: boolean
  message?: string
  error?: string
}

/**
 * Sync one intent's still-under-review PRs against their forge.
 *
 * The gate is the PR ROW, not the intent: any row sitting at `reviewing` is
 * syncable regardless of whether its intent is `todo`, `in_progress` or `done`.
 * The old `status === 'done' && prId && prStatus === 'reviewing'` test was an
 * artefact of the one-PR-per-intent model — a PR's lifecycle is its own, and an
 * intent that was reopened after its PR went up must not lose the ability to
 * learn that the PR merged.
 *
 * Every `reviewing` row is queried; a row that reached `merged` / `closed` is
 * persisted through the single write entry point and logged. A row whose query
 * fails does not stop the others — the failures are reported together, and the
 * successes are already durable.
 */
export async function syncIntentPrStatus(input: {
  workspacePath: string
  intentId: string
  broadcastIntents?: (workspacePath: string) => void
}): Promise<IntentPrSyncResult> {
  const intent = getIntent(input.intentId)
  if (!intent) {
    return { ok: false, intentId: input.intentId, changed: false, error: '意图不存在' }
  }
  if (intent.workspaceName !== pathToName(input.workspacePath)) {
    return {
      ok: false,
      intentId: input.intentId,
      changed: false,
      error: '意图不属于当前 workspace',
    }
  }

  const reviewing = listReviewingIntentPrs(intent.id)
  if (reviewing.length === 0) {
    const aggregate = deriveIntentPrAggregate(intent.prs)
    if (aggregate === null) {
      return { ok: false, intentId: intent.id, changed: false, error: '意图没有关联 PR/MR' }
    }
    return {
      ok: false,
      intentId: intent.id,
      prStatus: aggregate,
      changed: false,
      message: `没有处于 reviewing 的 PR/MR(当前为 ${aggregate})`,
    }
  }

  const errors: string[] = []
  let changed = false
  for (const pr of reviewing) {
    // Prefer the forge recorded ON the row: it is the PR's own origin, whereas
    // the workspace override is only a fallback for rows that predate it.
    const status = await getForgePrStatus(
      input.workspacePath,
      pr.number,
      pr.forge ?? getForgeOverride(input.workspacePath),
    )
    if (!status.ok || !status.status) {
      errors.push(`#${pr.number}: ${status.error ?? 'PR/MR 状态获取失败'}`)
      continue
    }
    if (status.status !== 'merged' && status.status !== 'closed') continue
    persistTerminalPrStatus(pr, status.status)
    changed = true
  }

  const aggregate = deriveIntentPrAggregate(listIntentPrs(intent.id)) ?? undefined
  if (changed) input.broadcastIntents?.(input.workspacePath)

  if (errors.length > 0 && !changed) {
    return {
      ok: false,
      intentId: intent.id,
      prStatus: aggregate,
      changed: false,
      error: errors.join('; '),
    }
  }
  return {
    ok: errors.length === 0,
    intentId: intent.id,
    prStatus: aggregate,
    changed,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    message: changed ? 'PR/MR 状态已更新' : 'PR/MR 仍在审核中',
  }
}

/** Persist one PR's forge-observed terminal state and record it on the intent's log. */
function persistTerminalPrStatus(pr: IntentPr, status: 'merged' | 'closed'): void {
  upsertIntentPr({
    intentId: pr.intentId,
    deliveryId: pr.deliveryId,
    forge: pr.forge,
    repo: pr.repo,
    number: pr.number,
    status,
  })
  // Forge-side terminal state observed by the sync, not a user action.
  safeInsertIntentLog(
    pr.intentId,
    status === 'merged' ? 'pr_merged' : 'pr_closed',
    status === 'merged' ? `PR #${pr.number} 已合并` : `PR #${pr.number} 已关闭`,
    'automation',
  )
}

/**
 * Dependencies that still hold an unsettled PR, i.e. at least one row sitting at
 * `reviewing`. Iterates the PR ROWS rather than the aggregate, and — like the sync
 * gate above — ignores the dependency intent's own status: "has the dep's PR
 * landed yet" is a question about the PR, and asking the forge once before a gate
 * decision is exactly what this exists for.
 */
export function depsWithUnconfirmedPr(dependsOn: string[], intents: Intent[]): Intent[] {
  const byId = new Map(intents.map((intent) => [intent.id, intent]))
  return dependsOn
    .map((id) => byId.get(id))
    .filter((dep): dep is Intent => !!dep && dep.prs.some((pr) => pr.status === 'reviewing'))
}

export function syncUnconfirmedDependencyPrsInBackground(input: {
  ctx: Pick<KernelContext, 'broadcastIntents'>
  workspacePath: string
  dependsOn: string[]
  onComplete?: () => void
}): void {
  const deps = depsWithUnconfirmedPr(input.dependsOn, listIntents(input.workspacePath))
  if (deps.length === 0) return
  void Promise.allSettled(
    deps.map((dep) =>
      syncIntentPrStatus({
        workspacePath: input.workspacePath,
        intentId: dep.id,
        broadcastIntents: input.ctx.broadcastIntents,
      }),
    ),
  )
    .then((results) => {
      // Only a forge state that actually MOVED justifies waking the caller. A
      // dependency PR the forge still reports as open re-derives the identical
      // "unmerged" verdict on the next pass, which asks for the same sync again:
      // signalling completion unconditionally turns that into a self-feeding
      // loop that never yields to the tick. No change means no new fact, so the
      // fixed cadence is the right place to look again.
      const changed = results.some((r) => r.status === 'fulfilled' && r.value.changed)
      if (!changed) return
      input.ctx.broadcastIntents?.(input.workspacePath)
      input.onComplete?.()
    })
    .catch((err: unknown) => {
      console.warn(
        `[c3:intents] background PR status sync failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
}
