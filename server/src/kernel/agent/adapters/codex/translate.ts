/**
 * Codex → canonical translation (ADR-0013, 2026-06-06-005). Codex is the
 * archetypal *incremental* vendor the canonical model was designed around: a
 * thread item is born on `item.started` (usually already in progress), revised by
 * `item.updated`, and finalized by `item.completed` — every frame carries the
 * SAME item `id`, so each item maps to ONE {@link CanonicalBlock} keyed by that
 * id and the upper layer's `CanonicalAccumulator` upserts successive revisions in
 * place (no result stacking — D3's embedded `tool_use.result`).
 *
 * Codex items carry NO role (the user prompt is what c3 sent; every item is the
 * agent's own output), so the synthesized role is always `assistant`
 * (protocol.ts: "Codex synthesizes this").
 *
 * preApproved audit (008 NO-GO consequence): Codex has no per-tool approval point
 * at all — every tool it runs was auto-allowed by the launch-time
 * `sandboxMode` + `approvalPolicy` gate, never by a c3/human decision. So a
 * canonical message that carries a tool item is stamped `preApproved: true`,
 * reconstructing the pre-adjudication for the audit trail + the UI's pre-approved
 * colour (mirrors generic `preApproved` semantics, but here it is structural:
 * ALL Codex tool calls are pre-adjudicated, not just rule-engine bypasses).
 *
 * ADR-0009: SDK types (`ThreadItem`/`ThreadEvent`) are imported here (inside
 * `adapters/codex/`) and narrowed; only canonical shapes leave this module.
 */
import type { ThreadItem } from '@openai/codex-sdk'
import type { CanonicalBlock, CanonicalMessage, CanonicalToolResult } from '../types.js'

/** Item kinds that are tool executions — all auto-allowed by Codex's launch-time gate. */
function isToolItem(item: ThreadItem): boolean {
  return (
    item.type === 'command_execution' ||
    item.type === 'file_change' ||
    item.type === 'mcp_tool_call' ||
    item.type === 'web_search'
  )
}

/** Flatten an MCP tool call's result/error into the canonical embedded return. */
function mcpResult(
  item: Extract<ThreadItem, { type: 'mcp_tool_call' }>,
): CanonicalToolResult | undefined {
  if (item.error) return { content: item.error.message, isError: true }
  if (item.result) {
    const text = item.result.content
      .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
      .join('')
    return { content: text, isError: false }
  }
  return undefined // still in progress — back-filled on a later frame
}

/** A command execution's embedded return, present once it has exited. */
function commandResult(
  item: Extract<ThreadItem, { type: 'command_execution' }>,
): CanonicalToolResult | undefined {
  if (item.status === 'in_progress') return undefined
  return {
    content: item.aggregated_output,
    isError: item.status === 'failed',
    vendorExtra: { exitCode: item.exit_code, status: item.status },
  }
}

/** A patch's embedded return, present once it has applied or failed. */
function fileChangeResult(item: Extract<ThreadItem, { type: 'file_change' }>): CanonicalToolResult {
  const summary = item.changes.map((c) => `${c.kind} ${c.path}`).join('\n')
  return {
    content: summary,
    isError: item.status === 'failed',
    vendorExtra: { status: item.status },
  }
}

/**
 * Map one Codex {@link ThreadItem} to a canonical block, or null when it has no
 * canonical analogue (`todo_list` — a vendor-unique planning frame ADR-0013 does
 * NOT promote to its own variant). Text/reasoning use the item `id`; a tool uses
 * the item `id` for cross-frame correlation (started → updated → completed).
 */
export function itemToBlock(item: ThreadItem): CanonicalBlock | null {
  switch (item.type) {
    case 'agent_message':
      return { type: 'text', text: item.text, id: item.id }
    case 'reasoning':
      return { type: 'thinking', thinking: item.text, id: item.id }
    case 'error':
      // A non-fatal item-level error surfaced for the read-only monitor.
      return { type: 'text', text: item.message, id: item.id, vendorExtra: { itemType: 'error' } }
    case 'command_execution': {
      const result = commandResult(item)
      return {
        type: 'tool_use',
        id: item.id,
        name: 'shell',
        input: { command: item.command },
        ...(result ? { result } : {}),
        vendorExtra: { status: item.status },
      }
    }
    case 'file_change':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'apply_patch',
        input: { changes: item.changes },
        result: fileChangeResult(item),
        vendorExtra: { status: item.status },
      }
    case 'mcp_tool_call': {
      const result = mcpResult(item)
      return {
        type: 'tool_use',
        id: item.id,
        name: `${item.server}/${item.tool}`,
        input: item.arguments,
        ...(result ? { result } : {}),
        vendorExtra: { server: item.server, tool: item.tool, status: item.status },
      }
    }
    case 'web_search':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'web_search',
        input: { query: item.query },
        vendorExtra: { itemType: 'web_search' },
      }
    case 'todo_list':
      return null // no canonical analogue (ADR-0013 D-D: not promoted)
    default:
      return null
  }
}

/**
 * Translate one Codex item frame into a single-block {@link CanonicalMessage} the
 * accumulator upserts by block id. Tool items are stamped `preApproved: true`
 * (Codex's launch-time gate auto-allowed them; there was no c3 approval point).
 * Returns null when the item has no canonical block.
 */
export function itemToCanonical(
  item: ThreadItem,
  sessionId: string,
  now: number,
): CanonicalMessage | null {
  const block = itemToBlock(item)
  if (!block) return null
  return {
    vendor: 'codex',
    sessionId,
    role: 'assistant',
    blocks: [block],
    ts: now,
    ...(isToolItem(item) ? { preApproved: true } : {}),
  }
}
