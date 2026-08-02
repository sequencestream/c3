/**
 * Queue action family: the spec phase.
 *
 * Executes `launch_spec` (authoring, first pass or rework), `launch_spec_review`
 * (a read-only review of one fingerprinted spec) and `machine_approve_spec`.
 * Both session actions go through the SAME shared launchers a human button uses,
 * so a queue-started spec session is byte-for-byte a manual one — including the
 * read-only / write-confined profile locks.
 *
 * Two guards live here and nowhere else:
 * - a refused launch is one failed attempt for THAT intent, so a spec that can
 *   never be authored backs off and parks instead of spinning at tick speed;
 * - a machine approval re-reads the live spec file and the workspace opt-in at
 *   write time, so a spec edited or an approval revoked since the kernel's
 *   snapshot approves nothing. A rejected write is the guard working, not a
 *   failure, and never counts against the intent.
 *
 * Deliberately not here: spec in-flight bookkeeping and the cooldown pre-write
 * (the controller owns both), and any decision about WHETHER a spec may be
 * authored, reviewed or approved (the kernel owns that).
 */
import type { Intent } from '@ccc/shared/protocol'
import { MACHINE_SPEC_APPROVER } from '@ccc/shared/protocol'
import type { GenericEvent } from '@ccc/shared'
import type { QueueAction } from '../../kernel/queue/index.js'
import { QUEUE_ACTOR, type QueueActionContext } from './queue-action-context.js'
import { recordFailure, recordSuccess } from './queue-outcome-actions.js'
import { getIntent, machineApproveSpec } from './store.js'
import { launchSpecReviewSession, launchSpecSession } from './session-launcher.js'
import { readSpecFingerprint } from './spec-review.js'
import { applySpecApproval } from './spec.js'

/**
 * Run ONE spec-phase session (authoring or review) to its launch verdict.
 *
 * The cooldown IS shared with development — it is a per-intent self-excitation
 * guard, and an intent in its spec phase is blocked from development anyway.
 * The in-flight tracking is NOT shared: a spec session must never enter the work
 * liveness set, or it would read as development to the concurrency gate.
 */
export async function runSpecPhase(
  ctx: QueueActionContext,
  action: Extract<QueueAction, { kind: 'launch_spec' | 'launch_spec_review' }>,
  req: Intent,
): Promise<void> {
  const deps = {
    launchRun: ctx.hooks.launchSpecRun,
    broadcastIntents: ctx.hooks.broadcastIntents,
  }
  const result =
    action.kind === 'launch_spec'
      ? await launchSpecSession(ctx.workspacePath, req.id, deps, undefined, QUEUE_ACTOR, {
          ...(action.rework
            ? {
                reworkReason: req.specReviewReason ?? '(审核未给出理由)',
                reworkRound: action.reworkRound,
              }
            : {}),
        })
      : await launchSpecReviewSession(ctx.workspacePath, req.id, deps, undefined, QUEUE_ACTOR)

  if (!result.success) {
    // A refused launch is a failed attempt for THIS intent only: it backs off
    // and eventually parks, exactly like a failed dev turn, so a permanently
    // un-authorable spec can never spin the queue.
    recordFailure(
      ctx,
      req.id,
      'launch_failed',
      `${action.kind === 'launch_spec' ? 'spec 撰写' : 'spec 审核'}会话启动被拒绝(${result.code})`,
    )
    return
  }
  recordSuccess(ctx, req.id)
  ctx.hooks.broadcastIntents(ctx.workspacePath)
}

/**
 * Execute a machine approval. The kernel decided on a snapshot; this re-checks
 * every fact transactionally at write time (`machineApproveSpec`), including a
 * fresh read of the spec file itself — the snapshot fingerprint alone would
 * agree with the equally old stored conclusion and approve a document edited
 * since. So a spec edited or an approval revoked in the meantime approves
 * nothing and the next reconcile simply re-derives. A rejected write is NOT a
 * failure — it is the guard doing its job — so it never counts against the
 * intent.
 */
export function executeMachineApproveSpec(
  ctx: QueueActionContext,
  action: Extract<QueueAction, { kind: 'machine_approve_spec' }>,
): void {
  const req = getIntent(action.intentId)
  if (!req) return
  const readLive = (specPath: string): string | null =>
    readSpecFingerprint(ctx.workspacePath, specPath)
  if (!machineApproveSpec(action.intentId, action.fingerprint, MACHINE_SPEC_APPROVER, readLive)) {
    console.log(`[c3:queue]「${req.title}」机器批准的前置事实已变化,本轮不批准`)
    ctx.requestPass()
    return
  }
  applySpecApproval({
    workspacePath: ctx.workspacePath,
    intent: req,
    approver: MACHINE_SPEC_APPROVER,
    broadcastIntents: ctx.hooks.broadcastIntents,
    publishEvent: (payload) =>
      ctx.hooks.publishEvent({
        workspacePath: payload.workspacePath,
        sessionId: payload.sessionId,
        event: payload.event as GenericEvent,
      }),
    // The approval flag itself was already written by the transactional guard
    // above; this pass only lands the audit log, the event and the broadcast.
    alreadyPersisted: true,
  })
  console.log(`[c3:queue]「${req.title}」审核通过且机器批准已开启 → spec 自动批准`)
}
