/**
 * Shared definitions for the two READ-ONLY delivery tools, kept ONE source so
 * every MCP surface that exposes them never drifts — the same shape the intent
 * tools use (`../intents/tool-defs.ts`).
 *
 * READ-ONLY IS THE WHOLE DESIGN. There is deliberately no delivery WRITE tool on
 * any MCP surface: every legal status write funnels through `canTransitionDelivery`
 * plus the handler's guards (branch readiness, the N/M integration aggregate, the
 * human's verification confirmation, the forge's own merge verdict), and a tool
 * that let a model set a status directly would route around all of them. A model
 * that needs a delivery to move asks a human, or waits for the system fact.
 *
 * This module is framing-free: it owns the zod input shapes, the agent-facing
 * description strings and the CORE logic. The MCP framing (registration, the
 * per-execution or per-key binding) lives in each surface.
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Delivery, DeliveryStatus } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import {
  getDelivery,
  getLatestDeliveryPr,
  isStoreAvailable,
  listAssociatedIntents,
  listDeliveries,
} from './store.js'

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface DeliveryToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): DeliveryToolResult['content'] => [{ type: 'text' as const, text: s }]

// ---- Zod input shapes ------------------------------------------------------

const TOOL_DELIVERY_STATUSES = [
  'planned',
  'integrating',
  'verifying',
  'verified',
  'delivered',
  'cancelled',
] as const satisfies readonly DeliveryStatus[]

export const findDeliveriesSchema = {
  keyword: z.string().optional().describe('关键字,模糊匹配交付标题/描述(可留空)'),
  status: z
    .enum(TOOL_DELIVERY_STATUSES)
    .optional()
    .describe(
      '按交付状态过滤:planned(待集成)/integrating(集成中)/verifying(验证中)/' +
        'verified(验证通过)/delivered(已发布)/cancelled(已取消)(可留空)',
    ),
}

export const viewDeliverySchema = { id: z.string().describe('交付 id') }

export type FindDeliveriesArgs = { keyword?: string; status?: DeliveryStatus }
export type ViewDeliveryArgs = { id: string }

// ---- Description strings (advertised in the system prompt) ----

export const findDeliveriesDesc =
  '检索本项目的交付批次(只读)。交付 = 一批意图作为一个整体合入主线的 Git 生命周期单位。' +
  '可按 keyword(模糊匹配标题/描述)、status 过滤(均可选,留空则返回全部);' +
  '返回精简列表(id、title、status、baseBranch、branchName、branchReady、集成就绪 N/M)。' +
  '本工具只读:交付状态的推进由人在交付页确认、或由系统观察 forge 事实落定,没有可供写入的 MCP 工具。'

export const viewDeliveryDesc =
  '按 id 查看本项目单条交付的完整详情(只读):交付本身(状态、基线分支、交付分支与就绪标志、' +
  '集成就绪 N/M)、关联意图列表(各自状态与面向本交付的 PR 状态)、以及最新一条「交付分支 → 主线」' +
  '的交付 PR 行(编号、链接、状态、受阻原因、冲突文件)。本工具只读,不改变任何交付状态。'

// ---- Core logic (framing-free; bound to ONE project via `workspacePath`) ----

/** The list projection: the facts a caller needs to decide, nothing more. */
function slimDelivery(d: Delivery): Record<string, unknown> {
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    baseBranch: d.baseBranch,
    branchName: d.branchName,
    branchReady: d.branchReady,
    integration: d.integration,
  }
}

/** Search the project's deliveries (read-only). */
export function runFindDeliveries(
  workspacePath: string,
  args: FindDeliveriesArgs,
): DeliveryToolResult {
  if (!isStoreAvailable()) return { content: text('交付库不可用,无法检索。'), isError: true }
  const keyword = args.keyword?.trim().toLowerCase()
  const rows = listDeliveries(workspacePath).filter((d) => {
    if (args.status && d.status !== args.status) return false
    if (!keyword) return true
    return d.title.toLowerCase().includes(keyword) || d.description.toLowerCase().includes(keyword)
  })
  const slim = rows.map(slimDelivery)
  return {
    content: text(
      slim.length === 0
        ? '未找到匹配的交付。'
        : `找到 ${slim.length} 条交付:\n${JSON.stringify(slim, null, 2)}`,
    ),
  }
}

/**
 * View one delivery by id, bound to the closure project (no cross-project
 * reads — the delivery's owning workspace is resolved back to a path and
 * compared, the same equivalence the workspace registry uses).
 */
export function runViewDelivery(workspacePath: string, args: ViewDeliveryArgs): DeliveryToolResult {
  if (!isStoreAvailable()) return { content: text('交付库不可用,无法查看。'), isError: true }
  const delivery = getDelivery(args.id)
  if (!delivery || resolveWorkspaceRoot(delivery.workspaceId) !== resolve(workspacePath)) {
    return { content: text(`未找到 id 为 ${args.id} 的交付(本项目)。`) }
  }
  return {
    content: text(
      JSON.stringify(
        {
          ...slimDelivery(delivery),
          description: delivery.description,
          startDate: delivery.startDate,
          endDate: delivery.endDate,
          createdAt: delivery.createdAt,
          updatedAt: delivery.updatedAt,
          associatedIntents: listAssociatedIntents(delivery.id),
          deliveryPr: getLatestDeliveryPr(delivery.id),
        },
        null,
        2,
      ),
    ),
  }
}
