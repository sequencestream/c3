/**
 * Integration tests for the Claude in-process `publish_pr_event` MCP server
 * (AC3, claude path). We drive the REAL handler the SDK registered
 * (`instance._registeredTools`), not a re-implementation, so the test fails if the
 * tool's wiring changes. Asserts the tool publishes via the injected sink tagged
 * with the bound workspace + live run id, and never raises a confirmation gate.
 */
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { PrOperationEvent } from '@ccc/shared/protocol'
import { createPrEventMcpServer } from './publish-tool.js'

interface CallToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult>

function getHandler(servers: Record<string, McpServerConfig>, toolName: string): Handler {
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return c3.instance._registeredTools[toolName].handler
}

describe('createPrEventMcpServer — publish_pr_event (claude in-process)', () => {
  it('registers publish_pr_event on the c3 server', () => {
    const servers = createPrEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'run-1', signal: new AbortController().signal },
      { publish: vi.fn() },
    )
    expect(getHandler(servers, 'publish_pr_event')).toBeTypeOf('function')
  })

  it('publishes a valid event tagged with the bound workspace + live run id', async () => {
    const published: Array<{ workspacePath: string; sessionId: string } & PrOperationEvent> = []
    let liveRunId = 'pending-1'
    const servers = createPrEventMcpServer(
      { workspacePath: '/proj', getRunId: () => liveRunId, signal: new AbortController().signal },
      { publish: (p) => published.push(p) },
    )
    const handler = getHandler(servers, 'publish_pr_event')

    // A pending→real rebind happens before the model calls the tool.
    liveRunId = 'real-7'
    const r = await handler({ operation: 'merge', result: 'success', pr: { number: 3 } }, {})

    expect(r.isError).toBeUndefined()
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      workspacePath: '/proj',
      sessionId: 'real-7',
      operation: 'merge',
      result: 'success',
      pr: { number: 3 },
    })
  })

  it('returns an isError result and publishes nothing for an illegal operation', async () => {
    const publish = vi.fn()
    const servers = createPrEventMcpServer(
      { workspacePath: '/proj', getRunId: () => 'run-1', signal: new AbortController().signal },
      { publish },
    )
    const handler = getHandler(servers, 'publish_pr_event')
    const r = await handler({ operation: 'rebase', result: 'success' }, {})
    expect(r.isError).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  })
})
