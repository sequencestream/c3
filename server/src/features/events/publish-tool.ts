/**
 * The in-process MCP tool the `c3` server exposes to ordinary work sessions:
 *  - `publish_event` (write): the model — AFTER performing an operation with its
 *    OWN tools (gh CLI / a GitHub MCP / …) — calls this to publish ONE
 *    vendor-neutral generic event onto the kernel event bus. The first registered
 *    type is `pr:operation`; the server-side PR creation paths (dev-cleanup /
 *    automation / manual create_pr) publish the same `pr:operation create` event
 *    after successfully creating a PR.
 *
 * Unlike `save_intents`, this tool has NO confirmation gate: publishing an event
 * has no destructive side effect, so the server auto-allows it (no
 * `permission_request`, no blocking). The follow-up that DOES have side effects
 * is the automation the event may trigger — that is governed by the automation's own
 * execution identity and the three-tier MCP security model, not here.
 *
 * The tool is named on the `c3` server, so the fully-qualified name is
 * `mcp__c3__publish_event`. The driver-path twin (codex) lives in
 * `transport/event-mcp`. This is the CLAUDE path's in-process binder, mirroring
 * `features/intents/save-tool.ts`. The generic tool defs live in
 * `./tool-defs.ts`; this file only supplies the MCP framing + the
 * per-run binding closure.
 */
// C-SEC exception (annotated): this DEFINES an in-process MCP tool handed to the
// kernel run loop — it does not run an agent or mint a permission verdict. The
// tool only publishes a validated, safely-normalized event; it has no destructive
// side effect and therefore no confirmation gate.
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared/protocol'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'
import {
  publishEventDesc,
  publishEventSchema,
  runPublishEvent,
  type PublishEventArgs,
} from './tool-defs.js'

/** Per-run binding: which workspace the events belong to, and the live run id. */
export interface PublishEventBinding {
  workspacePath: string
  /** Reads the LIVE run id so a pending→real session rebind tags events with the bound session. */
  getRunId: () => string
  /** Default-denies / dispose hook parity with other per-run MCP binders (unused by the publish path). */
  signal: AbortSignal
}

/**
 * The injected event pipeline — wired at the composition root:
 *  - `normalize` runs the untrusted core through the kernel normalizer registry
 *    (the `pr:operation` entry redacts + truncates); a rejection publishes nothing.
 *  - `publish` receives the normalized {@link GenericEvent} wrapped in the bus
 *    envelope (`eventBus.publish('event', …)`).
 */
export interface PublishEventDeps {
  normalize: (core: GenericEvent) => NormalizeResult
  publish: (payload: GenericEventEnvelope) => void
}

/**
 * Build the `c3` MCP server carrying `publish_event`, bound to ONE run. The
 * workspace is captured so the model can't redirect the event to another
 * workspace; `getRunId` reads the live run id so a pending→real rebind tags the
 * event with the bound session. The raw event's `metadata` / `data` can never
 * override the envelope — they ride INSIDE `event`, while the closure supplies
 * `workspacePath` / `sessionId` on the wrapper.
 */
export function createPublishEventMcpServer(
  binding: PublishEventBinding,
  deps: PublishEventDeps,
): Record<string, McpServerConfig> {
  // Spread into a fresh literal: the SDK's `tool()` result type carries an index
  // signature, which a named interface (EventToolResult) is not assignable to.
  const handler = async (args: PublishEventArgs) => ({
    ...runPublishEvent(args, deps.normalize, (event) =>
      deps.publish({
        workspacePath: binding.workspacePath,
        sessionId: binding.getRunId(),
        event,
      }),
    ),
  })

  const server = createSdkMcpServer({
    name: 'c3',
    // Keep the tool resident in the turn-1 prompt instead of behind tool search,
    // so a work session can publish without an extra ToolSearch round-trip. The
    // blocking-startup side effect is moot — this is an in-process server.
    alwaysLoad: true,
    tools: [tool('publish_event', publishEventDesc, publishEventSchema, handler)],
  })
  return { c3: server }
}
