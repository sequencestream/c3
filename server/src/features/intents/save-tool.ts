/**
 * The in-process MCP tools the `c3` server exposes to the intent-
 * communication agent:
 *  - `save_intents` (write): the agent submits a batch of proposed
 *    intents; the save handler runs its OWN confirmation gate (`gatedSave`):
 *    it emits a `permission_request`, blocks on the user's decision, and only
 *    persists on `allow`. This gate lives in the HANDLER — not the SDK's
 *    `canUseTool` — so a vendor allow-rule that pre-approves the tool (and
 *    therefore skips `canUseTool`) still raises the confirmation. This mirrors
 *    the codex/driver path (`save-gate.ts`); both vendors converge on one gate.
 *  - `find_intents` / `view_intent` (read-only): let the agent search
 *    the project ledger and inspect one item so it can discover related work,
 *    avoid duplicates, and set `dependsOn` correctly. The gate auto-allows these
 *    (no confirmation). All three are bound to ONE project via `workspacePath` in
 *    the closure, so the agent can never read/write another project's ledger.
 *
 * Tools are named on the `c3` server, so the fully-qualified names are
 * `mcp__c3__save_intents` / `mcp__c3__find_intents` /
 * `mcp__c3__view_intent` (see the `*_TOOL` constants in `claude.ts`).
 */
// C-SEC exception (annotated): this DEFINES an in-process MCP tool (the
// `save_intents` server) handed to the kernel run loop — it does not run an
// agent or mint a permission verdict. `save_intents` invocations are gated by
// the save handler's own `gatedSave` (emit permission_request + waitForDecision);
// the intent gate in `kernel/permission` now lets save through (classifyIntentTool
// ⇒ allow) so the handler is the single confirmation point.
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { gatedSave, type SaveGateBinding, type SaveGateDeps } from './save-gate.js'
import {
  findDesc,
  findSchema,
  runFind,
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
 * Build the `c3` MCP server carrying `save_intents`, bound to ONE run.
 *
 * `binding.workspacePath` is captured so the agent can't redirect the save to
 * another project; `binding.getRunId` reads the LIVE run id so a pending→real
 * rebind routes the confirmation frame to the bound session; `binding.signal`
 * default-denies on user stop. `deps` carries the confirmation gate's
 * dependencies (emit / waitForDecision / broadcast / WorkCenter hook), injected
 * at the composition root. Re-bind per run so the gate always targets the live
 * comm runtime — the binding (run id + signal) does not exist at profile-build
 * time, only once the run starts.
 */
export function createIntentMcpServer(
  binding: SaveGateBinding,
  deps: SaveGateDeps,
): Record<string, McpServerConfig> {
  const { workspacePath } = binding
  // `save_intents` runs the shared confirmation gate (`gatedSave`) — the SAME one
  // the codex/driver path uses — so reaching persistence requires the user's OK,
  // and a vendor pre-approval that skips `canUseTool` cannot bypass it. find/view
  // stay read-only. Spread into a fresh literal: the SDK's `tool()` result type
  // carries an index signature, which a named interface is not assignable to.
  const saveHandler = async (args: SaveArgs) => ({ ...(await gatedSave(deps, binding, args)) })
  const findHandler = async (args: FindArgs) => ({ ...runFind(workspacePath, args) })
  const viewHandler = async (args: ViewArgs) => ({ ...runView(workspacePath, args) })

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
