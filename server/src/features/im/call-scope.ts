/**
 * Per-tool-call workspace visibility for IM robots.
 *
 * Re-reads binding, personal scope, group whitelist and policy epoch on every
 * call. Run-start results only select a Conversation — they never authorize
 * subsequent tool handlers.
 */
import { createHash } from 'node:crypto'
import type { ImPlatform, WorkspaceInfo } from '@ccc/shared/protocol'
import type { ImIdentityBinding } from '@ccc/shared/protocol'
import { listWorkspacesForSubject } from '../auth/authorization.js'
import { readPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import { resolveWorkspaceRoot, isDirectory } from '../../state.js'
import {
  accountNamespaceOf,
  getActiveBindingById,
  getActiveBindingForSender,
  groupWorkspaceNames,
  providerAccountKeyOf,
} from './identity-store.js'
import { getRobot } from './robot-store.js'

export const L1_OBJECT_TOOLS = ['view_intent', 'view_delivery', 'view_discussion'] as const
export const L1_LIST_TOOLS = ['find_intents', 'find_deliveries', 'find_discussions'] as const
export const L1_READ_TOOLS = [...L1_OBJECT_TOOLS, ...L1_LIST_TOOLS] as const

export type L1ReadTool = (typeof L1_READ_TOOLS)[number]

export function isL1ReadTool(name: string): name is L1ReadTool {
  return (L1_READ_TOOLS as readonly string[]).includes(name)
}

/** Uniform tool result when an object is missing, out of scope, or group-hidden. */
export const NOT_VISIBLE_RESULT = Object.freeze({
  code: 'not_visible' as const,
})

export type ChatContext = {
  chatType: 'group' | 'p2p'
  chatId: string
  platform: ImPlatform
  providerAccountKey: string
}

export type CallScopeSnapshot = {
  bindingId: string
  subject: string
  bindingVersion: string
  policyEpoch: number
  /** Workspaces the caller may see in detail this call (registry order). */
  detailWorkspaces: WorkspaceInfo[]
  /** Personal scope before group intersection (registry order). */
  personalWorkspaces: WorkspaceInfo[]
  chat: ChatContext
  scopeHash: string
}

export type ResolveCallScopeInput = {
  robotId: string
  senderId: string
  chat: ChatContext
  /** When set, binding id must still match the active row. */
  expectedBindingId?: string
}

export type ResolveCallScopeResult =
  | { ok: true; scope: CallScopeSnapshot }
  | { ok: false; reason: 'unbound' | 'mismatch' | 'db_unavailable' }

function workspaceInfosResolvable(list: WorkspaceInfo[]): WorkspaceInfo[] {
  return list.filter((w) => {
    const path = resolveWorkspaceRoot(w.name)
    return !!path && isDirectory(path)
  })
}

/**
 * Canonical irreversible digest of the authorization version. Monotonic via
 * policyEpoch + binding id — restoring an identical workspace set after a
 * change still yields a new hash once the epoch advanced.
 */
export function computeScopeHash(parts: {
  subject: string
  bindingId: string
  policyEpoch: number
  chatType: 'group' | 'p2p'
  groupKey: string | null
  detailWorkspaceNames: readonly string[]
}): string {
  const payload = [
    parts.subject,
    parts.bindingId,
    String(parts.policyEpoch),
    parts.chatType,
    parts.groupKey ?? '',
    ...parts.detailWorkspaceNames,
  ].join('\0')
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function groupKeyOf(chat: ChatContext): string | null {
  if (chat.chatType !== 'group') return null
  return `${chat.platform}:${chat.providerAccountKey}:${chat.chatId}`
}

/**
 * Fresh call-level scope. Never caches across tool calls.
 */
export function resolveCallScope(input: ResolveCallScopeInput): ResolveCallScopeResult {
  const robot = getRobot(input.robotId)
  if (!robot) return { ok: false, reason: 'unbound' }
  const ns = accountNamespaceOf(robot.platform, robot.appId)
  const binding = getActiveBindingForSender(ns, input.senderId)
  if (!binding) return { ok: false, reason: 'unbound' }
  if (input.expectedBindingId && binding.id !== input.expectedBindingId) {
    return { ok: false, reason: 'mismatch' }
  }
  return snapshotFromBinding(binding, input.chat)
}

export function resolveCallScopeByBinding(
  bindingId: string,
  chat: ChatContext,
): ResolveCallScopeResult {
  const binding = getActiveBindingById(bindingId)
  if (!binding) return { ok: false, reason: 'unbound' }
  return snapshotFromBinding(binding, chat)
}

function snapshotFromBinding(
  binding: ImIdentityBinding,
  chat: ChatContext,
): ResolveCallScopeResult {
  const personal = workspaceInfosResolvable(listWorkspacesForSubject(binding.subject))
  let detail = personal
  if (chat.chatType === 'group') {
    const allowed = new Set(
      groupWorkspaceNames(chat.platform, chat.providerAccountKey, chat.chatId),
    )
    detail = personal.filter((w) => allowed.has(w.name))
  }
  const policyEpoch = readPolicyEpoch()
  const scopeHash = computeScopeHash({
    subject: binding.subject,
    bindingId: binding.id,
    policyEpoch,
    chatType: chat.chatType,
    groupKey: groupKeyOf(chat),
    detailWorkspaceNames: detail.map((w) => w.name),
  })
  return {
    ok: true,
    scope: {
      bindingId: binding.id,
      subject: binding.subject,
      bindingVersion: binding.id,
      policyEpoch,
      detailWorkspaces: detail,
      personalWorkspaces: personal,
      chat,
      scopeHash,
    },
  }
}

/** Build chat context from a live robot + inbound message fields. */
export function chatContextFor(
  platform: ImPlatform,
  appId: string,
  chatType: 'group' | 'p2p',
  chatId: string,
): ChatContext {
  return {
    platform,
    providerAccountKey: providerAccountKeyOf(platform, appId),
    chatType,
    chatId,
  }
}

export function detailWorkspacePaths(scope: CallScopeSnapshot): string[] {
  return scope.detailWorkspaces
    .map((w) => resolveWorkspaceRoot(w.name))
    .filter((p): p is string => !!p)
}

export function personalWorkspacePaths(scope: CallScopeSnapshot): string[] {
  return scope.personalWorkspaces
    .map((w) => resolveWorkspaceRoot(w.name))
    .filter((p): p is string => !!p)
}

export function isWorkspaceInDetail(scope: CallScopeSnapshot, workspaceName: string): boolean {
  return scope.detailWorkspaces.some((w) => w.name === workspaceName)
}

export function isWorkspaceInPersonal(scope: CallScopeSnapshot, workspaceName: string): boolean {
  return scope.personalWorkspaces.some((w) => w.name === workspaceName)
}
