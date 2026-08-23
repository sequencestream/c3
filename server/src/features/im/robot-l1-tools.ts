/**
 * Call-level L1 read tools for IM robots. Each handler re-resolves scope; run
 * start never authorizes these calls. Object tools reverse-lookup workspace by
 * id; list tools enumerate personal (or group∩personal) scope and annotate
 * workspaceName. Unauthorized / missing objects share one not_visible shape.
 */
import { resolve } from 'node:path'
import {
  findDesc,
  findSchema,
  runFind,
  runView,
  viewDesc,
  viewSchema,
  type FindArgs,
  type ViewArgs,
} from '../intents/tool-defs.js'
import { getIntent, isStoreAvailable as isIntentStoreAvailable } from '../intents/store.js'
import {
  findDeliveriesDesc,
  findDeliveriesSchema,
  runFindDeliveries,
  runViewDelivery,
  viewDeliveryDesc,
  viewDeliverySchema,
  type FindDeliveriesArgs,
  type ViewDeliveryArgs,
} from '../deliveries/tool-defs.js'
import { getDelivery, isStoreAvailable as isDeliveryStoreAvailable } from '../deliveries/store.js'
import {
  findDiscussionsDesc,
  findDiscussionsSchema,
  runFindDiscussions,
  runViewDiscussion,
  viewDiscussionDesc,
  viewDiscussionSchema,
  type FindDiscussionsArgs,
  type ViewDiscussionArgs,
} from '../discussions/tool-defs.js'
import {
  getDiscussion,
  isStoreAvailable as isDiscussionStoreAvailable,
} from '../discussions/store.js'
import { resolveWorkspaceRoot } from '../../state.js'
import type { AutomationC3Tool, AutomationC3ToolResult } from '../automations/c3-tools.js'
import {
  isL1ReadTool,
  isWorkspaceInDetail,
  isWorkspaceInPersonal,
  NOT_VISIBLE_RESULT,
  resolveCallScope,
  type CallScopeSnapshot,
  type ChatContext,
  type L1ReadTool,
} from './call-scope.js'
import {
  recordGroupHidden,
  recordObjectNotVisible,
  type TurnDisplaySignals,
} from './robot-message-registry.js'

export type RobotL1AuthContext = {
  robotId: string
  senderId: string
  chat: ChatContext
  /** Binding id frozen at turn start — mismatch ⇒ scope_changed. */
  expectedBindingId: string
  /** Scope hash at turn start — mismatch ⇒ scope_changed. */
  turnStartScopeHash: string
  /** Invoked when a call sees a mid-turn auth change. */
  onScopeChanged?: () => void
  /** Server-only turn signals for fixed security copy (not in MCP results). */
  displaySignals?: TurnDisplaySignals
}

function text(s: string): AutomationC3ToolResult['content'] {
  return [{ type: 'text' as const, text: s }]
}

export function robotNotVisible(auth: RobotL1AuthContext): AutomationC3ToolResult {
  if (auth.displaySignals) recordObjectNotVisible(auth.displaySignals)
  return { content: text(JSON.stringify(NOT_VISIBLE_RESULT)) }
}

export function robotScopeChanged(): AutomationC3ToolResult {
  return {
    content: text(JSON.stringify({ code: 'scope_changed' })),
    isError: true,
  }
}

export function freshRobotScope(
  auth: RobotL1AuthContext,
): CallScopeSnapshot | 'unbound' | 'changed' {
  const r = resolveCallScope({
    robotId: auth.robotId,
    senderId: auth.senderId,
    chat: auth.chat,
    expectedBindingId: auth.expectedBindingId,
  })
  if (!r.ok) {
    auth.onScopeChanged?.()
    return r.reason === 'mismatch' ? 'changed' : 'unbound'
  }
  if (r.scope.scopeHash !== auth.turnStartScopeHash) {
    auth.onScopeChanged?.()
    return 'changed'
  }
  return r.scope
}

/**
 * Workspace discovery returns the newest valid intersection even when its
 * authorization version moved during the turn. The signal still invalidates
 * the final answer, while a revoked or replaced binding cannot switch subject.
 */
function freshDiscoveryScope(auth: RobotL1AuthContext): CallScopeSnapshot | 'changed' {
  const r = resolveCallScope({
    robotId: auth.robotId,
    senderId: auth.senderId,
    chat: auth.chat,
    expectedBindingId: auth.expectedBindingId,
  })
  if (!r.ok) {
    auth.onScopeChanged?.()
    return 'changed'
  }
  if (r.scope.scopeHash !== auth.turnStartScopeHash) auth.onScopeChanged?.()
  return r.scope
}

function pathFor(workspaceName: string): string | null {
  return resolveWorkspaceRoot(workspaceName)
}

/** Parse JSON tool body into rows when the single-workspace runner returned a list. */
function extractJsonArray(body: string): unknown[] | null {
  const idx = body.indexOf('[')
  if (idx < 0) return null
  try {
    const parsed: unknown = JSON.parse(body.slice(idx))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mergeListResults(
  auth: RobotL1AuthContext,
  scope: CallScopeSnapshot,
  perWorkspace: Array<{ workspaceName: string; items: Record<string, unknown>[] }>,
  hiddenCount: number,
): AutomationC3ToolResult {
  if (scope.chat.chatType === 'group' && hiddenCount > 0 && auth.displaySignals) {
    const visibleCount = perWorkspace.reduce((n, w) => n + w.items.length, 0)
    recordGroupHidden(auth.displaySignals, visibleCount, hiddenCount)
  }
  const items = perWorkspace.flatMap((w) =>
    w.items.map((it) => ({ ...it, workspaceName: w.workspaceName })),
  )
  return { content: text(JSON.stringify({ items })) }
}

function runObjectTool(
  auth: RobotL1AuthContext,
  locate: () => { workspaceName: string } | null,
  viewAt: (workspacePath: string) => AutomationC3ToolResult,
): AutomationC3ToolResult {
  const scope = freshRobotScope(auth)
  if (scope === 'changed' || scope === 'unbound') return robotScopeChanged()
  const located = locate()
  if (!located) return robotNotVisible(auth)
  if (!isWorkspaceInDetail(scope, located.workspaceName)) return robotNotVisible(auth)
  const path = pathFor(located.workspaceName)
  if (!path) return robotNotVisible(auth)
  return viewAt(path)
}

function runListTool(
  auth: RobotL1AuthContext,
  listAt: (workspacePath: string) => { items: Record<string, unknown>[]; rawEmpty: boolean },
): AutomationC3ToolResult {
  const scope = freshRobotScope(auth)
  if (scope === 'changed' || scope === 'unbound') return robotScopeChanged()

  const detailNames = new Set(scope.detailWorkspaces.map((w) => w.name))
  const perWs: Array<{ workspaceName: string; items: Record<string, unknown>[] }> = []
  let hiddenCount = 0

  for (const ws of scope.personalWorkspaces) {
    const path = pathFor(ws.name)
    if (!path) continue
    const { items } = listAt(path)
    if (detailNames.has(ws.name)) {
      perWs.push({ workspaceName: ws.name, items })
    } else if (scope.chat.chatType === 'group') {
      hiddenCount += items.length
    }
  }

  return mergeListResults(auth, scope, perWs, hiddenCount)
}

function parseFindBody(result: AutomationC3ToolResult): Record<string, unknown>[] {
  const body = result.content[0]?.text ?? ''
  const arr = extractJsonArray(body)
  if (!arr) return []
  return arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
}

/** Build the six ledger reads plus workspace discovery with call-level scope. */
export function buildRobotL1Tools(auth: RobotL1AuthContext): AutomationC3Tool[] {
  const tools: AutomationC3Tool[] = [
    {
      name: 'list_workspaces',
      description:
        '列出本次 IM 调用当前可见的工作区名称(只读)。' +
        '返回 JSON:{"workspaces":["…"]},顺序与注册表一致,只含名称、不含任何磁盘路径。',
      inputSchema: {},
      handler: async () => {
        const scope = freshDiscoveryScope(auth)
        if (scope === 'changed') return robotScopeChanged()
        return {
          content: text(
            JSON.stringify({
              workspaces: scope.detailWorkspaces.map((workspace) => workspace.name),
            }),
          ),
        }
      },
    },
    {
      name: 'find_intents',
      description: findDesc,
      inputSchema: findSchema,
      handler: async (args) =>
        runListTool(auth, (workspacePath) => {
          if (!isIntentStoreAvailable()) return { items: [], rawEmpty: true }
          const r = runFind(workspacePath, args as FindArgs)
          return { items: parseFindBody(r), rawEmpty: false }
        }),
    },
    {
      name: 'view_intent',
      description: viewDesc,
      inputSchema: viewSchema,
      handler: async (args) => {
        const id = (args as ViewArgs).id
        return runObjectTool(
          auth,
          () => {
            if (!isIntentStoreAvailable()) return null
            const intent = getIntent(id)
            return intent ? { workspaceName: intent.workspaceName } : null
          },
          (workspacePath) => runView(workspacePath, args as ViewArgs),
        )
      },
    },
    {
      name: 'find_deliveries',
      description: findDeliveriesDesc,
      inputSchema: findDeliveriesSchema,
      handler: async (args) =>
        runListTool(auth, (workspacePath) => {
          if (!isDeliveryStoreAvailable()) return { items: [], rawEmpty: true }
          const r = runFindDeliveries(workspacePath, args as FindDeliveriesArgs)
          return { items: parseFindBody(r), rawEmpty: false }
        }),
    },
    {
      name: 'view_delivery',
      description: viewDeliveryDesc,
      inputSchema: viewDeliverySchema,
      handler: async (args) => {
        const id = (args as ViewDeliveryArgs).id
        return runObjectTool(
          auth,
          () => {
            if (!isDeliveryStoreAvailable()) return null
            const d = getDelivery(id)
            return d ? { workspaceName: d.workspaceName } : null
          },
          (workspacePath) => runViewDelivery(workspacePath, args as ViewDeliveryArgs),
        )
      },
    },
    {
      name: 'find_discussions',
      description: findDiscussionsDesc,
      inputSchema: findDiscussionsSchema,
      handler: async (args) =>
        runListTool(auth, (workspacePath) => {
          if (!isDiscussionStoreAvailable()) return { items: [], rawEmpty: true }
          const r = runFindDiscussions(workspacePath, args as FindDiscussionsArgs)
          return { items: parseFindBody(r), rawEmpty: false }
        }),
    },
    {
      name: 'view_discussion',
      description: viewDiscussionDesc,
      inputSchema: viewDiscussionSchema,
      handler: async (args) => {
        const id = (args as ViewDiscussionArgs).discussionId
        return runObjectTool(
          auth,
          () => {
            if (!isDiscussionStoreAvailable()) return null
            const d = getDiscussion(id)
            return d ? { workspaceName: d.workspaceName } : null
          },
          (workspacePath) => runViewDiscussion(workspacePath, args as ViewDiscussionArgs),
        )
      },
    },
  ]
  return tools
}

export function filterSelectedL1(selected: readonly string[]): L1ReadTool[] {
  return selected.filter(isL1ReadTool)
}

/** Exported for tests: object path equivalence used by single-workspace runners. */
export function workspacePathEquals(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

export { isWorkspaceInPersonal }
