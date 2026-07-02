import type { Intent, IntentPrStatus } from '@ccc/shared/protocol'
import type { KernelContext } from '../../kernel/types.js'
import { getForgeOverride } from '../../kernel/config/index.js'
import { getForgePrStatus } from '../../git.js'
import { pathToId } from '../../state.js'
import { getIntent, listIntents, safeInsertIntentLog, setPrStatus } from './store.js'

export interface IntentPrSyncResult {
  ok: boolean
  intentId: string
  prStatus?: IntentPrStatus
  changed: boolean
  message?: string
  error?: string
}

function isSyncable(intent: Intent): boolean {
  return intent.status === 'done' && !!intent.prId && intent.prStatus === 'reviewing'
}

function notSyncableResult(intent: Intent): IntentPrSyncResult {
  if (!intent.prId) {
    return { ok: false, intentId: intent.id, changed: false, error: '意图没有关联 PR/MR' }
  }
  if (intent.status !== 'done') {
    return {
      ok: false,
      intentId: intent.id,
      changed: false,
      error: `意图状态为 ${intent.status},需要 done`,
    }
  }
  if (intent.prStatus !== 'reviewing') {
    return {
      ok: false,
      intentId: intent.id,
      prStatus: intent.prStatus ?? undefined,
      changed: false,
      message: intent.prStatus ? `PR/MR 状态已是 ${intent.prStatus}` : '意图 PR/MR 状态不可同步',
    }
  }
  return { ok: false, intentId: intent.id, changed: false, error: '意图不可同步' }
}

export async function syncIntentPrStatus(input: {
  workspacePath: string
  intentId: string
  broadcastIntents?: (workspacePath: string) => void
}): Promise<IntentPrSyncResult> {
  const intent = getIntent(input.intentId)
  if (!intent) {
    return { ok: false, intentId: input.intentId, changed: false, error: '意图不存在' }
  }
  if (intent.workspaceId !== pathToId(input.workspacePath)) {
    return {
      ok: false,
      intentId: input.intentId,
      changed: false,
      error: '意图不属于当前 workspace',
    }
  }
  if (!isSyncable(intent)) return notSyncableResult(intent)

  const status = await getForgePrStatus(
    input.workspacePath,
    intent.prId as string,
    getForgeOverride(input.workspacePath),
  )
  if (!status.ok || !status.status) {
    return {
      ok: false,
      intentId: intent.id,
      changed: false,
      error: status.error ?? 'PR/MR 状态获取失败',
    }
  }

  if (status.status === 'merged' || status.status === 'closed') {
    setPrStatus(intent.id, status.status)
    // Forge-side terminal state observed by the sync, not a user action.
    safeInsertIntentLog(
      intent.id,
      status.status === 'merged' ? 'pr_merged' : 'pr_closed',
      status.status === 'merged' ? `PR #${intent.prId} 已合并` : `PR #${intent.prId} 已关闭`,
      'automation',
    )
    input.broadcastIntents?.(input.workspacePath)
    return {
      ok: true,
      intentId: intent.id,
      prStatus: status.status,
      changed: true,
      message: status.status === 'merged' ? 'PR/MR 已合并' : 'PR/MR 已关闭',
    }
  }

  return {
    ok: true,
    intentId: intent.id,
    prStatus: status.status,
    changed: false,
    message: 'PR/MR 仍在审核中',
  }
}

export function depsWithUnconfirmedPr(dependsOn: string[], intents: Intent[]): Intent[] {
  const byId = new Map(intents.map((intent) => [intent.id, intent]))
  return dependsOn
    .map((id) => byId.get(id))
    .filter(
      (dep): dep is Intent =>
        !!dep && dep.status === 'done' && !!dep.prId && dep.prStatus !== 'merged',
    )
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
    .then(() => {
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
