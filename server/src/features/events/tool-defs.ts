/**
 * Shared, framing-free definitions for the vendor-neutral `publish_event` MCP
 * tool, kept ONE source so the surfaces that expose it never drift:
 *  - the in-process Claude SDK MCP server (`./publish-tool.ts`),
 *  - the localhost HTTP MCP route for driver-path vendors (`transport/event-mcp`,
 *    codex),
 *  - the unattended-automation c3 MCP tool set (`../automations/c3-tools.ts`).
 *
 * This module owns the zod input shape (which mirrors the {@link GenericEvent}
 * contract 1:1), the description advertised in the system prompt, and the core
 * publish logic. It is deliberately TYPE-AGNOSTIC: the per-type field-level
 * safety normalization lives in the registered normalizers (e.g. the `pr:operation`
 * entry in `../pr-events/tool-defs.ts`), reached through the injected `normalize`.
 * The MCP framing — tool registration + the per-run binding closure that supplies
 * `workspacePath` + `sessionId` — lives in each surface.
 *
 * A model constructs a {@link GenericEvent} core (`type` + optional
 * `status` / `description` / `metadata` / `data`) and calls this tool ONCE; the
 * core is normalized through the kernel registry and — on success only — wrapped
 * in a {@link GenericEventEnvelope} and delivered to the single `'event'` bus
 * topic. The `type` is an OPEN `<category>:<action>` string: a known type gets its
 * typed normalizer, any custom type falls through to the default (structural)
 * normalizer, and either way the payload is safely redacted/truncated. An invalid
 * core or a normalizer rejection returns an `isError` result and publishes NOTHING.
 */
import { z } from 'zod'
import type { GenericEvent } from '@ccc/shared/protocol'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface EventToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): EventToolResult['content'] => [{ type: 'text' as const, text: s }]

// ---- Zod input shape (raw shape; both `tool()` and `registerTool` accept it) ----
//
// Mirrors {@link GenericEvent}: `type` is the required, non-empty open
// `<category>:<action>` discriminant; the rest is optional free-form context. The
// kernel registry re-validates + normalizes per type after this gate, so this
// shape stays loose.

export const publishEventSchema = {
  type: z
    .string()
    .describe(
      '事件类型判别值(必填,非空),形如 "<大类>:<动作>"(开放字符串,可自定义,如 custom:create)。' +
        '已知的 PR 操作事件:pr:create / pr:review / pr:merge / pr:close / ' +
        'pr:comment / pr:update(update=已有 PR 修改后重新提交/重新打开,非新建),' +
        '自定义 type 也会被安全归一化后发布。',
    ),
  status: z
    .string()
    .optional()
    .describe('事件结果/状态(自由文本)。pr:* 填操作结果:success/failure/error。'),
  description: z
    .string()
    .optional()
    .describe(
      '简短描述/摘要(自由文本),服务端会安全归一化。pr:* 用作 errorSummary' +
        '(仅 failure/error 有意义),勿放令牌/密钥/命令行原始输出/绝对路径。',
    ),
  metadata: z
    .record(z.string(), z.string())
    .optional()
    .describe('扁平的 string→string 元数据(不接受嵌套)。pr:* 无需额外必填键。'),
  data: z
    // `z.any()` value (not `unknown`) so the SDK-inferred arg type stays assignable
    // to the JSON-compatible `GenericEvent.data`; the registry re-validates JSON-ness.
    .record(z.string(), z.any())
    .optional()
    .describe(
      'JSON 兼容的结构化数据。pr:* 用 { pr, repo, ref, association };' +
        'pr={number,id,url,title,state}、repo={provider,host,owner,name}、' +
        'ref={head,base}、association={intentId,intentTitle};review 场景请填 ' +
        'pr.id + association.intentTitle(意图名称)让事件自解释。',
    ),
}

/** The tool args — structurally a {@link GenericEvent} core (re-validated by the registry). */
export type PublishEventArgs = GenericEvent

// ---- Description string (advertised in the system prompt) ----

export const publishEventDesc =
  '发布一条供应商中立的通用事件到 c3 事件总线。你应先用自己的工具(gh CLI / GitHub MCP 等)' +
  '完成实际操作,c3 本身不执行任何操作;操作完成或失败后调用本工具发布对应事件,供订阅的 ' +
  'Automation / 消费者匹配并触发后续动作。入参为通用事件:type(必填,形如 "<大类>:<动作>",' +
  '开放字符串,可自定义)、status、description、metadata(扁平 string→string)、data(JSON)。' +
  '已知 PR 操作事件 type=pr:create / pr:review / pr:merge / pr:close / pr:comment / ' +
  'pr:update(update=已有 PR 修改后重新提交/重新打开,非新建):status 填操作结果 ' +
  'success/failure/error,data 携带 { pr, repo, ref, association },失败原因写入 description。' +
  '服务端会对所有字段做安全归一化(脱敏/剥绝对路径/截断);自定义 type 同样会被安全发布,不会因未预注册而拒绝。'

// ---- Core publish logic (shared handler) ----

/**
 * Validate + normalize the generic event core through the injected `normalize`
 * (the kernel registry: looks up `core.type`, runs the matching per-type or the
 * default normalizer, re-validates) and publish the NORMALIZED event via the
 * injected `publish` sink (bound to the run's workspace + session at the
 * composition root). An invalid core or a normalizer rejection returns an `isError`
 * result and publishes NOTHING.
 */
export function runPublishEvent(
  core: PublishEventArgs,
  normalize: (core: GenericEvent) => NormalizeResult,
  publish: (event: GenericEvent) => void,
): EventToolResult {
  const res = normalize(core)
  if (!res.ok) {
    return { content: text(`事件发布失败:${res.reason}`), isError: true }
  }
  try {
    publish(res.event)
  } catch (err) {
    return { content: text(`事件发布失败:${String(err)}`), isError: true }
  }
  return { content: text(`已发布事件:${res.event.type}`) }
}
