/**
 * GOLDEN-STANDARD CONTRACT — C4: the permission gateway defaults to deny.
 *
 * Pins a behavior that MUST survive every slice of the server refactor (ADR-0009):
 * a sensitive tool is NEVER auto-allowed. Absent an explicit human `allow`, the
 * gateway denies — and on run teardown (abort) an unanswered prompt resolves to
 * deny, never allow.
 *
 * Two seams, both never-moving:
 *   1. `waitForDecision` (the pure permission registry) resolves to `deny` when
 *      its signal aborts before a decision arrives.
 *   2. `runClaude`'s `canUseTool` gateway (standard gate, consensus disabled)
 *      sends a `permission_request` and, when the run is torn down without an
 *      answer, returns `{ behavior: 'deny' }`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

// One programmable SDK stream + captured `canUseTool` verdict (the tool's fate).
const sdk = vi.hoisted(() => ({
  canUseToolResult: null as unknown,
  capturedOptions: null as { canUseTool?: (...a: unknown[]) => Promise<unknown> } | null,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { options?: { canUseTool?: (...a: unknown[]) => Promise<unknown> } }) => {
    sdk.capturedOptions = arg.options ?? null
    return {
      async *[Symbol.asyncIterator]() {
        // Init message carries the session id.
        yield { type: 'system', session_id: 'sid-c4' }
        // The SDK asks the gateway to authorize a sensitive (write/exec) tool.
        // The gateway blocks on the human; nobody answers; the run is torn down,
        // so this resolves to deny.
        sdk.canUseToolResult = await arg.options!.canUseTool!(
          'Bash',
          { command: 'echo danger' },
          {},
        )
        yield { type: 'result', session_id: 'sid-c4' }
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
    }
  },
}))

import { runClaude } from '../../src/claude.js'
import { waitForDecision, resolveDecision, pendingCount } from '../../src/permissions.js'

beforeEach(() => {
  sdk.canUseToolResult = null
  sdk.capturedOptions = null
})

describe('C4 — permission gateway defaults to deny', () => {
  it('waitForDecision resolves to deny when the run is torn down before an answer', async () => {
    const ac = new AbortController()
    const p = waitForDecision('req-c4-abort', ac.signal)
    expect(pendingCount()).toBe(1)
    ac.abort()
    await expect(p).resolves.toEqual({ decision: 'deny' })
    // An already-aborted signal denies immediately, with no lingering entry.
    await expect(waitForDecision('req-c4-pre', ac.signal)).resolves.toEqual({ decision: 'deny' })
    expect(pendingCount()).toBe(0)
  })

  it('a human allow flows through (the gateway is not allow-by-default the other way)', async () => {
    const ac = new AbortController()
    const p = waitForDecision('req-c4-allow', ac.signal)
    expect(resolveDecision('req-c4-allow', 'allow')).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'allow', answers: undefined })
  })

  it('runClaude canUseTool denies an unanswered sensitive tool on teardown', async () => {
    const ac = new AbortController()
    const events: ServerToClient[] = []

    const run = runClaude({
      prompt: 'use a tool',
      cwd: '/tmp',
      signal: ac.signal,
      permissionMode: 'default',
      send: (m) => events.push(m),
    })

    // Let the iterator reach canUseTool and emit the permission_request.
    for (let i = 0; i < 20 && !events.some((e) => e.type === 'permission_request'); i++) {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
    }
    const req = events.find((e) => e.type === 'permission_request')
    expect(req).toBeDefined()

    // Nobody answers — the run is torn down. The pending prompt MUST resolve to deny.
    ac.abort()
    await run

    expect(sdk.canUseToolResult).toMatchObject({ behavior: 'deny' })
  })
})
