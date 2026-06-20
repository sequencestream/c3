/**
 * The in-process MCP tools the `c3` server exposes to the SPEC-authoring agent:
 *  - `find_intents` / `view_intent` (read-only): let the spec author search the
 *    project ledger and inspect one intent so it can ground / clarify the spec
 *    against existing intents. Both are bound to ONE project via `workspacePath`
 *    in the closure, so the spec agent can never read another project's ledger.
 *
 * Unlike the intent comm agent's server (`createIntentMcpServer`, `save-tool.ts`),
 * this one carries NO `save_intents` and NO run-level binding (no save gate, so no
 * `getRunId` / `signal` / `SaveGateDeps`). A spec session is read-only over the
 * ledger by construction: the only writable thing it has is its own spec file
 * (governed by the spec permission gate). Keeping a separate, smaller constructor
 * avoids dragging the save-gate dependencies into the spec path.
 *
 * Tools are named on the `c3` server, so the fully-qualified names are
 * `mcp__c3__find_intents` / `mcp__c3__view_intent`.
 */
// C-SEC exception (annotated): this DEFINES two in-process read-only MCP tools
// (the spec author's ledger query server) handed to the kernel run loop — it does
// not run an agent or mint a permission verdict. Both tools only READ this
// project's ledger (project-bound in the closure); neither can write or reach
// another project.
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  findDesc,
  findSchema,
  runFind,
  runView,
  viewDesc,
  viewSchema,
  type FindArgs,
  type ViewArgs,
} from './tool-defs.js'

/**
 * Build the `c3` MCP server carrying ONLY the two read-only ledger query tools,
 * bound to ONE project via `workspacePath`. The spec agent calls `find_intents` /
 * `view_intent` to ground the spec against existing intents; it can never read
 * another project's ledger nor write anything (no `save_intents` is registered).
 *
 * No run-level binding is needed (unlike the intent path's `createIntentMcpServer`):
 * the read core (`runFind` / `runView`) takes the project path alone, and there is
 * no save confirmation gate, so the constructor's signature stays minimal.
 */
export function createSpecQueryMcpServer(workspacePath: string): Record<string, McpServerConfig> {
  // find/view stay read-only and project-bound; the workspacePath is captured in
  // the closure so the spec agent can't redirect the read elsewhere. Spread into a
  // fresh literal: the SDK's `tool()` result type carries an index signature, which
  // a named interface is not assignable to.
  const findHandler = async (args: FindArgs) => ({ ...runFind(workspacePath, args) })
  const viewHandler = async (args: ViewArgs) => ({ ...runView(workspacePath, args) })

  const server = createSdkMcpServer({
    name: 'c3',
    // Keep both tools resident in the turn-1 prompt instead of letting the harness
    // defer them behind tool search, so the spec author can query the ledger
    // without a ToolSearch round-trip first. `alwaysLoad` sets
    // `_meta['anthropic/alwaysLoad']` on each tool (≡ API `defer_loading: false`).
    alwaysLoad: true,
    tools: [
      tool('find_intents', findDesc, findSchema, findHandler),
      tool('view_intent', viewDesc, viewSchema, viewHandler),
    ],
  })
  return { c3: server }
}
