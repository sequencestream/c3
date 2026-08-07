/**
 * Shared, framing-free definitions for the automation `sync_intent_pr_status`
 * MCP tool — the explicit trigger for c3's forge-driven PR-status reconciliation,
 * kept ONE source so every surface that exposes it never drifts. Today only the
 * unattended-automation c3 MCP tool set (`../automations/c3-tools.ts`) registers
 * it; the advisor keeps its own human-confirmed `sync_intent_pr_status` (which
 * shares the same `syncIntentPrStatus` core), so this module stays the
 * automation-facing single source.
 *
 * The tool deliberately takes ONLY `intentId`. It does NOT accept a status value,
 * a PR id or a delivery id: the terminal `merged` / `closed` state is always
 * derived server-side from the forge's own answer. That structural absence is what
 * keeps the old `save_intent_pr_info` failure mode out of reach — an intent can
 * hold several PR rows, so a model cannot address one by intent id, and it must
 * never be allowed to write a status by hand. The model triggers; c3 reconciles;
 * the forge decides.
 *
 * This module is framing-free: it owns the zod input shape, the description
 * advertised in the system prompt, and the dispatch to the shared core. The MCP
 * framing — tool registration + the per-execution binding closure that supplies
 * `workspacePath` and the broadcast callback — lives in each surface.
 */
import { z } from 'zod'
import { syncIntentPrStatus } from './pr-status-sync.js'

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface IntentPrToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): IntentPrToolResult['content'] => [{ type: 'text' as const, text: s }]

// ---- Zod input shape (raw shape; both `tool()` and `registerTool` accept it) ----
//
// Only the intent id. No `status` / `prId` / `deliveryId` fields exist to pass:
// the terminal state comes from the forge query, never from the model.

export const syncIntentPrStatusSchema = {
  intentId: z
    .string()
    .describe(
      '要同步 PR 状态的本项目意图 id。工具不接受任何状态值:服务端遍历该意图全部 ' +
        'reviewing 的 PR 行逐条向 forge 查询,终态(merged/closed)唯一由 forge 裁决并落库。',
    ),
}

/** The tool args — only the intent whose PR rows should be reconciled. */
export type SyncIntentPrStatusArgs = { intentId: string }

// ---- Description string (advertised in the system prompt) ----

export const syncIntentPrStatusDesc =
  '把本项目一条意图的 PR 状态与服务端 forge 事实对齐(触发服务端派生,模型不写任何状态值)。' +
  '输入仅 intentId:服务端遍历该意图全部处于 reviewing 的 PR 行,逐条向 forge 查询真实状态,' +
  '已合并/关闭的行落为终态并写意图日志(pr_merged / pr_closed),forge 仍 open 的行保持不变,' +
  '查询失败的行聚合报错、不阻断其余行。' +
  '适合合并类自动化在检测到 PR 已被合并/关闭而台账仍显示 reviewing 时显式调用:' +
  '先用你自己的工具(gh CLI / GitHub MCP 等)核实 forge 状态,再调用本工具让 c3 复核落库——' +
  '无需知道该意图持有哪些 PR、无需指明是哪一条,状态只能由 c3 从 forge 裁决。'

// ---- Core dispatch (framing-free; bound to ONE project via `workspacePath`) ----

/**
 * Trigger the shared `syncIntentPrStatus` core for one intent and echo its result
 * as JSON. `onBroadcast` lets the caller refresh the refreshed intent list to every
 * connection after a change; a non-`ok` result (unknown / foreign intent, no PR
 * rows, all forge queries failed) is surfaced as an error so the model sees it.
 */
export async function runSyncIntentPrStatus(
  workspacePath: string,
  args: SyncIntentPrStatusArgs,
  onBroadcast?: (workspacePath: string) => void,
): Promise<IntentPrToolResult> {
  const result = await syncIntentPrStatus({
    workspacePath,
    intentId: args.intentId,
    broadcastIntents: onBroadcast,
  })
  const payload = JSON.stringify(result)
  return result.ok ? { content: text(payload) } : { content: text(payload), isError: true }
}
