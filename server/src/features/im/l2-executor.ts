/**
 * L2 domain action executors — server-derived actor, no WebSocket context.
 */
import type { ImRobot, RobotWritableCapability, VendorId } from '@ccc/shared/protocol'
import { resolvePending } from '../../runs.js'
import { registerPermissionResolver } from '../../kernel/permission/registry.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { getEventByRequestId, updateStatus } from '../user-involve/store.js'
import {
  getAnswerContract,
  claimTodoAssignee,
  type AnswerContract,
} from '../user-involve/answer-contract-store.js'
import { getIntent, approveSpecIfPending } from '../intents/store.js'
import { applySpecApproval } from '../intents/spec.js'
import { requestHumanSpecRework } from '../intents/spec-rework.js'
import { clearPark } from '../intents/queue-outcome-actions.js'
import { classifyImPermissionRequest } from './l2-permission-category.js'

export type L2ExecuteResult =
  | { ok: true; outcome: 'applied' | 'already_applied' }
  | { ok: false; outcome: 'stale' | 'refused' | 'domain_refused'; reason?: string }

export interface L2ExecuteInput {
  robot: ImRobot
  contract: AnswerContract
  answerId: string
  actorSubject: string
  idempotencyKey: string
  broadcastIntents?: (workspacePath: string) => void
  requestQueuePass?: () => void
}

function matchAnswer(contract: AnswerContract, answerId: string): boolean {
  return contract.answers.some((a) => a.answerId === answerId)
}

export function executeL2Action(input: L2ExecuteInput): L2ExecuteResult {
  const { contract, answerId, actorSubject } = input
  if (contract.actorSubject !== actorSubject) {
    return { ok: false, outcome: 'refused', reason: 'actor_mismatch' }
  }
  if (!matchAnswer(contract, answerId)) {
    return { ok: false, outcome: 'refused', reason: 'answer_invalid' }
  }

  switch (contract.domainAction.kind) {
    case 'permission_respond':
      return executePermissionRespond(input)
    case 'spec_respond':
      return executeSpecRespond(input)
    case 'automation_unpark':
      return executeUnpark(input)
    case 'todo_claim':
      return executeClaim(input)
    default:
      return { ok: false, outcome: 'domain_refused', reason: 'unknown_action' }
  }
}

function executePermissionRespond(input: L2ExecuteInput): L2ExecuteResult {
  const da = input.contract.domainAction as unknown as {
    requestId: string
    vendor: string
    toolName: string
    inputFingerprint: string
    category: string
  }
  const event = getEventByRequestId(da.requestId)
  if (!event || event.status !== 'todo') return { ok: false, outcome: 'stale' }
  const live = classifyImPermissionRequest(da.vendor as VendorId, da.toolName, event.toolInput)
  if (!live || live.category !== da.category || live.inputFingerprint !== da.inputFingerprint) {
    return { ok: false, outcome: 'stale' }
  }
  if (input.answerId === 'cancel') {
    resolvePending(da.requestId)
    registerPermissionResolver.resolve(da.requestId, 'deny', undefined, input.actorSubject)
    updateStatus(event.id, 'canceled')
    return { ok: true, outcome: 'applied' }
  }
  const opt = live.answers.find((a) => a.answerId === input.answerId)
  if (!opt || opt.answerId === 'cancel') {
    return { ok: false, outcome: 'refused' }
  }
  const answers = { [live.questionLabel]: opt.label }
  resolvePending(da.requestId)
  registerPermissionResolver.resolve(da.requestId, 'allow', answers, input.actorSubject)
  updateStatus(event.id, 'done')
  return { ok: true, outcome: 'applied' }
}

function executeSpecRespond(input: L2ExecuteInput): L2ExecuteResult {
  const da = input.contract.domainAction as unknown as { intentId: string; specFingerprint: string }
  if (input.answerId === 'approve') {
    const intent = getIntent(da.intentId)
    if (!intent || intent.specStatus !== 'pending') return { ok: false, outcome: 'stale' }
    const ws = resolveWorkspaceRoot(intent.workspaceName)
    if (!ws) return { ok: false, outcome: 'stale' }
    const applied = applySpecApproval({
      workspacePath: ws,
      intent,
      approver: input.actorSubject,
      broadcastIntents: input.broadcastIntents ?? (() => {}),
      publishEvent: () => {},
    })
    if (!applied) return { ok: false, outcome: 'stale' }
    updateStatus(input.contract.todoId, 'done')
    return { ok: true, outcome: 'applied' }
  }
  if (input.answerId === 'changes_requested') {
    const r = requestHumanSpecRework({
      intentId: da.intentId,
      specFingerprint: da.specFingerprint,
      actor: input.actorSubject,
      idempotencyKey: input.idempotencyKey,
    })
    if (r === 'already_applied') return { ok: true, outcome: 'already_applied' }
    if (r === 'applied') return { ok: true, outcome: 'applied' }
    return { ok: false, outcome: r === 'stale' ? 'stale' : 'domain_refused' }
  }
  return { ok: false, outcome: 'refused' }
}

function executeUnpark(input: L2ExecuteInput): L2ExecuteResult {
  const da = input.contract.domainAction as unknown as { intentId: string; workspacePath: string }
  const intent = getIntent(da.intentId)
  if (!intent) return { ok: false, outcome: 'stale' }
  if (!clearPark(da.workspacePath, da.intentId)) {
    return { ok: false, outcome: 'domain_refused', reason: 'not_parked' }
  }
  input.requestQueuePass?.()
  updateStatus(input.contract.todoId, 'done')
  return { ok: true, outcome: 'applied' }
}

function executeClaim(input: L2ExecuteInput): L2ExecuteResult {
  const r = claimTodoAssignee(input.contract.todoId, input.actorSubject, input.idempotencyKey)
  if (!r.ok) return { ok: false, outcome: 'refused' }
  if (r.alreadyApplied) return { ok: true, outcome: 'already_applied' }
  return { ok: true, outcome: 'applied' }
}

export function capabilityForContract(contract: AnswerContract): RobotWritableCapability {
  return contract.capability
}
