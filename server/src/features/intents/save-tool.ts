/**
 * The in-process MCP tools the `c3` server exposes to the intent-
 * communication agent:
 *  - `save_intents` (write): the agent submits a batch of proposed
 *    intents; the c3 permission gate (see `claude.ts`) intercepts and asks
 *    the user to confirm. Reaching the handler therefore means the user already
 *    allowed it — the handler just persists and broadcasts.
 *  - `find_intents` / `view_intent` (read-only): let the agent search
 *    the project ledger and inspect one item so it can discover related work,
 *    avoid duplicates, and set `dependsOn` correctly. The gate auto-allows these
 *    (no confirmation). All three are bound to ONE project via `projectPath` in
 *    the closure, so the agent can never read/write another project's ledger.
 *
 * Tools are named on the `c3` server, so the fully-qualified names are
 * `mcp__c3__save_intents` / `mcp__c3__find_intents` /
 * `mcp__c3__view_intent` (see the `*_TOOL` constants in `claude.ts`).
 */
// C-SEC exception (annotated): this DEFINES an in-process MCP tool (the
// `save_intents` server) handed to the kernel run loop — it does not run an
// agent or mint a permission verdict. The tool's invocations still pass through
// the intent gate in `kernel/permission` (classifyIntentTool ⇒ confirm-save).
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  findDesc,
  findSchema,
  runFind,
  runSaveConfirmed,
  runView,
  saveDesc,
  saveSchema,
  viewDesc,
  viewSchema,
  type FindArgs,
  type SaveArgs,
  type ViewArgs,
} from './tool-defs.js'

/**
 * Build the `c3` MCP server carrying `save_intents`, bound to one project.
 *
 * `projectPath` is captured in the closure so the agent can't redirect the save
 * to another project; `onSaved` lets the server broadcast the refreshed list
 * (the tool stays decoupled from connection state). Re-construct per run so the
 * binding always matches the current comm runtime's workspace.
 */
export function createIntentMcpServer(
  projectPath: string,
  onSaved: (projectPath: string) => void,
): Record<string, McpServerConfig> {
  // The three tools delegate to the shared core (`tool-defs.ts`). The save gate on
  // THIS (Claude) path is the SDK's `canUseTool` (classifyIntentTool ⇒ confirm-save),
  // so reaching `saveHandler` means the user already confirmed — it just persists.
  // Spread into a fresh literal: the SDK's `tool()` result type carries an index
  // signature, which a named interface (`IntentToolResult`) is not assignable to.
  const saveHandler = async (args: SaveArgs) => ({
    ...runSaveConfirmed(projectPath, args, onSaved),
  })
  const findHandler = async (args: FindArgs) => ({ ...runFind(projectPath, args) })
  const viewHandler = async (args: ViewArgs) => ({ ...runView(projectPath, args) })

  const server = createSdkMcpServer({
    name: 'c3',
    // Keep this server's tools resident in the turn-1 prompt instead of letting
    // the harness defer them behind tool search. Without this, the intent
    // agent must ToolSearch `save_intents` back before every save (an extra
    // round-trip + tokens). `alwaysLoad` sets `_meta['anthropic/alwaysLoad']` on
    // each tool (≡ API `defer_loading: false`). The blocking-startup side effect
    // is moot here — this is an in-process MCP server, so it connects instantly.
    // Scope is naturally the intent agent only: this server is built solely
    // by the `kind === 'intent'` / `gate: 'intent'` launch path.
    alwaysLoad: true,
    tools: [
      // Canonical names (advertised in the system prompt).
      tool('save_intents', saveDesc, saveSchema, saveHandler),
      tool('find_intents', findDesc, findSchema, findHandler),
      tool('view_intent', viewDesc, viewSchema, viewHandler),
    ],
  })
  return { c3: server }
}
