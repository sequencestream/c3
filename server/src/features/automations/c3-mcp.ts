/**
 * In-process c3 MCP profile for unattended Claude automation runs.
 *
 * This is deliberately separate from the interactive intent MCP profile: a
 * automation has no browser decision queue, so it exposes only the bounded PR
 * reconciliation write instead of the confirmation-gated general intent save.
 */
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { buildAutomationC3Tools, type AutomationMcpDeps } from './c3-tools.js'

export type { AutomationMcpDeps } from './c3-tools.js'

let deps: AutomationMcpDeps | null = null

/** Configure composition-root callbacks used by automation c3 MCP handlers. */
export function configureAutomationMcp(next: AutomationMcpDeps): void {
  deps = next
}

/**
 * Build the restricted c3 server bound to one automation execution (the CLAUDE
 * in-process surface). The tool list + handler closures come from the shared
 * {@link buildAutomationC3Tools} so this surface and the codex HTTP route never
 * drift; here they are wrapped as Claude SDK `tool()` registrations.
 */
export function createAutomationMcpServer(
  workspacePath: string,
  executionId: string,
  automationMetadata?: Record<string, string>,
): Record<string, McpServerConfig> {
  const server = createSdkMcpServer({
    name: 'c3',
    alwaysLoad: true,
    tools: buildAutomationC3Tools(workspacePath, executionId, deps, automationMetadata).map((t) =>
      // Spread into a fresh object literal so it carries the implicit index
      // signature the SDK `CallToolResult` return type requires.
      tool(t.name, t.description, t.inputSchema, async (args) => ({ ...(await t.handler(args)) })),
    ),
  })
  return { c3: server }
}
