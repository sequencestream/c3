import type { ServerToClient } from '@ccc/shared/protocol'
export { PENDING_SESSION_PREFIX, SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
export { VIEW_MODE_KEY, sessionCacheKey } from '../state/types'

/** 深链兑现超时:10 秒,足够服务端回包,但不至于在慢网下过多等待。 */
export const DEEP_LINK_TIMEOUT_MS = 10_000

/**
 * 每一种 `create_intent` 拒绝码 —— 收到任一都要释放「增加意图」的在途守卫,
 * 否则入口与新增弹窗的提交按钮会一直禁用到页面状态重建。跨 `workspace.` /
 * `intent.` / `delivery.` 三个前缀,因此显式列举而非前缀判断。
 */
export const CREATE_INTENT_REFUSAL_CODES = new Set<string>([
  'workspace.unknown',
  'intent.dbUnavailable',
  'intent.createFailed',
  'intent.baseBranchRequired',
  'intent.deliveryContextUnknown',
  'delivery.guard.branchNotReady',
])

/**
 * Explicit errors that mean the post-create owner-session bind will not complete
 * on this connection. Clearing the awaiting-bind flag on these restores
 * `firstIntentTurn` so the user can retry; a mid-bind `intents` snapshot that
 * merely lists the id without `intentSessionId` is NOT a clear signal.
 */
export const INTENT_SESSION_BIND_FAIL_CODES = new Set<string>([
  'intent.startSessionFailed',
  'intent.worktreeCreateFailed',
  'intent.worktreeBaseMismatch',
  'intent.worktreeBaseMismatchDirty',
  'intent.worktreeDirty',
  'intent.worktreeRepairFailed',
])

/** Broadcast types that can change a Dashboard count while it is the active view. */
export const DASHBOARD_REFRESH_TYPES = new Set<ServerToClient['type']>([
  'sessions',
  'session_status',
  'intents',
  'discussions',
  'automations',
])
