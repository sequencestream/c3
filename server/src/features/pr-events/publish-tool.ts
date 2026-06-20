/**
 * The in-process MCP tool the `c3` server exposes to ordinary work sessions:
 *  - `publish_pr_event` (write): the model — AFTER performing a PR operation
 *    with its OWN tools (gh CLI / a GitHub MCP / …) — calls this to publish ONE
 *    vendor-neutral PR operation event onto the kernel event bus. c3 NEVER
 *    executes the PR operation itself.
 *
 * Unlike `save_intents`, this tool has NO confirmation gate: publishing an event
 * has no destructive side effect, so the server auto-allows it (no
 * `permission_request`, no blocking). The follow-up that DOES have side effects
 * is the schedule the event may trigger — that is governed by the schedule's own
 * execution identity and the three-tier MCP security model, not here.
 *
 * The tool is named on the `c3` server, so the fully-qualified name is
 * `mcp__c3__publish_pr_event`. The driver-path twin (codex) lives in
 * `transport/pr-event-mcp`. This is the CLAUDE path's in-process binder, mirroring
 * `features/intents/save-tool.ts`.
 */
// C-SEC exception (annotated): this DEFINES an in-process MCP tool handed to the
// kernel run loop — it does not run an agent or mint a permission verdict. The
// tool only publishes a validated, safely-normalized event; it has no destructive
// side effect and therefore no confirmation gate.
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { PrOperationEvent } from '@ccc/shared/protocol'
import {
  publishPrEventDesc,
  publishPrEventSchema,
  runPublishPrEvent,
  type PublishPrEventArgs,
} from './tool-defs.js'

/** Per-run binding: which workspace the events belong to, and the live run id. */
export interface PrEventBinding {
  workspacePath: string
  /** Reads the LIVE run id so a pending→real session rebind tags events with the bound session. */
  getRunId: () => string
  /** Default-denies / dispose hook parity with other per-run MCP binders (unused by the publish path). */
  signal: AbortSignal
}

/** The injected publish sink — the composition root wires it to `eventBus.publish('pr:operation', …)`. */
export interface PrEventDeps {
  publish: (payload: { workspacePath: string; sessionId: string } & PrOperationEvent) => void
}

/**
 * Build the `c3` MCP server carrying `publish_pr_event`, bound to ONE run. The
 * workspace is captured so the model can't redirect the event to another
 * workspace; `getRunId` reads the live run id so a pending→real rebind tags the
 * event with the bound session.
 */
export function createPrEventMcpServer(
  binding: PrEventBinding,
  deps: PrEventDeps,
): Record<string, McpServerConfig> {
  // Spread into a fresh literal: the SDK's `tool()` result type carries an index
  // signature, which a named interface (PrEventToolResult) is not assignable to.
  const handler = async (args: PublishPrEventArgs) => ({
    ...runPublishPrEvent(args, (event) =>
      deps.publish({
        workspacePath: binding.workspacePath,
        sessionId: binding.getRunId(),
        ...event,
      }),
    ),
  })

  const server = createSdkMcpServer({
    name: 'c3',
    // Keep the tool resident in the turn-1 prompt instead of behind tool search,
    // so a work session can publish without an extra ToolSearch round-trip. The
    // blocking-startup side effect is moot — this is an in-process server.
    alwaysLoad: true,
    tools: [tool('publish_pr_event', publishPrEventDesc, publishPrEventSchema, handler)],
  })
  return { c3: server }
}
