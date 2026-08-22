/**
 * Sync IM answer contracts when todos become answerable.
 */
import type { PermissionRequestCtx } from '../../kernel/permission/gateway.js'
import { resolveWorkspaceRoot, pathToName } from '../../state.js'
import { createEvent, getEventByRequestId } from '../user-involve/store.js'
import { upsertAnswerContract } from '../user-involve/answer-contract-store.js'
import { getIntent } from '../intents/store.js'
import { readSpecFingerprint } from '../intents/spec-review.js'
import { classifyImPermissionRequest } from './l2-permission-category.js'

function workspaceName(path: string): string {
  return pathToName(path) ?? path
}

export function syncPermissionRequestContract(
  ctx: PermissionRequestCtx,
  initiatedBySubject: string | null | undefined,
): void {
  if (!initiatedBySubject) return
  const event = getEventByRequestId(ctx.requestId)
  if (!event) return
  const match = classifyImPermissionRequest('claude', ctx.toolName, ctx.input)
  if (!match) return
  upsertAnswerContract({
    todoId: event.id,
    capability: 'queue_respond',
    actorSubject: initiatedBySubject,
    workspaceName: workspaceName(ctx.workspacePath),
    objectType: 'permission_request',
    objectId: ctx.requestId,
    todoFingerprint: `${match.category}:${match.inputFingerprint}`,
    answers: match.answers,
    domainAction: {
      kind: 'permission_respond',
      requestId: ctx.requestId,
      vendor: 'claude',
      toolName: ctx.toolName,
      category: match.category,
      inputFingerprint: match.inputFingerprint,
    },
  })
}

export function syncSpecApprovalContract(intentId: string, specFingerprint: string): void {
  const intent = getIntent(intentId)
  if (!intent?.responsibleSubject) return
  const requestId = `spec:${intentId}:${specFingerprint}`
  const event = getEventByRequestId(requestId)
  if (!event) return
  upsertAnswerContract({
    todoId: event.id,
    capability: 'queue_respond',
    actorSubject: intent.responsibleSubject,
    workspaceName: intent.workspaceName,
    objectType: 'spec',
    objectId: intentId,
    todoFingerprint: specFingerprint,
    answers: [
      { answerId: 'approve', label: 'approve' },
      { answerId: 'changes_requested', label: 'changes_requested' },
    ],
    domainAction: {
      kind: 'spec_respond',
      intentId,
      specFingerprint,
    },
  })
}

export function ensureSpecApprovalTodo(intentId: string, specFingerprint: string): void {
  const intent = getIntent(intentId)
  if (!intent || intent.specStatus !== 'pending') return
  const ws = resolveWorkspaceRoot(intent.workspaceName)
  if (!ws || !intent.specPath) return
  const live = readSpecFingerprint(ws, intent.specPath)
  if (live !== specFingerprint) return
  const requestId = `spec:${intentId}:${specFingerprint}`
  if (!getEventByRequestId(requestId)) {
    createEvent({
      workspacePath: ws,
      sessionKind: 'spec',
      sessionId: intent.specSessionId,
      title: `Spec 待批准: ${intent.title}`,
      requestId,
      toolName: null,
      toolInput: { intentId, specFingerprint },
    })
  }
  syncSpecApprovalContract(intentId, specFingerprint)
}

export function syncParkUnparkContract(input: {
  intentId: string
  workspacePath: string
  actorSubject: string | null | undefined
  todoId: string
}): void {
  if (!input.actorSubject) return
  upsertAnswerContract({
    todoId: input.todoId,
    capability: 'automation_control',
    actorSubject: input.actorSubject,
    workspaceName: workspaceName(input.workspacePath),
    objectType: 'intent',
    objectId: input.intentId,
    todoFingerprint: `park:${input.intentId}`,
    answers: [{ answerId: 'unpark', label: 'unpark' }],
    domainAction: {
      kind: 'automation_unpark',
      intentId: input.intentId,
      workspacePath: input.workspacePath,
    },
  })
}

export function syncRaiseUserTodoClaim(input: {
  todoId: string
  intentId: string
  workspacePath: string
  actorSubject: string | null | undefined
  reasonCode: string
}): void {
  if (!input.actorSubject) return
  upsertAnswerContract({
    todoId: input.todoId,
    capability: 'annotate',
    actorSubject: input.actorSubject,
    workspaceName: workspaceName(input.workspacePath),
    objectType: 'intent',
    objectId: input.intentId,
    todoFingerprint: `claim:${input.reasonCode}`,
    answers: [{ answerId: 'claim', label: 'claim' }],
    domainAction: {
      kind: 'todo_claim',
      intentId: input.intentId,
      reasonCode: input.reasonCode,
    },
  })
}
