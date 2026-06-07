/**
 * C-SEC unit tests for the permission gateway chokepoint (server refactor 3/3).
 *
 * Covers the two no-consensus gate policies end to end (intent /
 * discussion-research) — read tools pass, everything else is DENIED BY DEFAULT
 * (PG-R4) — and asserts the load-bearing C-SEC invariant: a permission verdict is
 * EPHEMERAL. Resolving any number of prompts never writes to disk (the gateway +
 * registry hold state only in memory, unlike settings/state which persist). The
 * standard (consensus) gate's default-deny is pinned by the C4 golden contract.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import type { ServerToClient } from '@ccc/shared/protocol'
import { createCanUseTool, type GatewaySpec } from './gateway.js'
import { resolveDecision } from './registry.js'

function spec(overrides: Partial<GatewaySpec> = {}): GatewaySpec {
  return {
    gate: 'intent',
    send: () => {},
    signal: new AbortController().signal,
    currentAgentId: null,
    cwd: '/tmp',
    recentContext: () => '',
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('intent gate — read-only, deny-by-default', () => {
  it('allows a read-class built-in with the original input (no prompt)', async () => {
    const gate = createCanUseTool(spec())
    const out = await gate('Read', { file_path: '/x' }, {} as never)
    expect(out).toMatchObject({ behavior: 'allow', updatedInput: { file_path: '/x' } })
  })

  it('DENIES a write/exec tool by default', async () => {
    const gate = createCanUseTool(spec())
    const out = await gate('Bash', { command: 'rm -rf /' }, {} as never)
    expect(out).toMatchObject({ behavior: 'deny' })
    expect((out as { message: string }).message).toMatch(/read-only/)
  })

  it('routes save_intents to a human prompt, then honours the allow', async () => {
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(spec({ send: (m) => sent.push(m) }))
    const p = gate('mcp__c3__save_intents', { items: [] }, {} as never)
    // The gateway emitted a permission_request — answer it from the "browser".
    const req = sent.find((m) => m.type === 'permission_request')
    expect(req).toBeDefined()
    if (req && req.type === 'permission_request') resolveDecision(req.requestId, 'allow')
    expect(await p).toMatchObject({ behavior: 'allow' })
  })

  it('denies save_intents when the human declines', async () => {
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(spec({ send: (m) => sent.push(m) }))
    const p = gate('mcp__c3__save_intents', { items: [] }, {} as never)
    const req = sent.find((m) => m.type === 'permission_request')
    if (req && req.type === 'permission_request') resolveDecision(req.requestId, 'deny')
    expect(await p).toMatchObject({ behavior: 'deny' })
  })
})

describe('discussion-research gate — read-only, deny-by-default', () => {
  it('allows a read tool, denies everything else', async () => {
    const gate = createCanUseTool(spec({ gate: 'discussion-research' }))
    expect(await gate('Grep', { pattern: 'x' }, {} as never)).toMatchObject({ behavior: 'allow' })
    expect(await gate('Write', { file_path: '/x' }, {} as never)).toMatchObject({
      behavior: 'deny',
    })
  })
})

describe('C-SEC — permission verdicts are NOT persisted (no-persist)', () => {
  it('a full allow + deny + save flow never writes to disk', async () => {
    const writeFile = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    const sent: ServerToClient[] = []
    const gate = createCanUseTool(spec({ send: (m) => sent.push(m) }))

    await gate('Read', { file_path: '/a' }, {} as never) // allow
    await gate('Bash', { command: 'x' }, {} as never) // deny
    const p = gate('mcp__c3__save_intents', { items: [] }, {} as never) // prompt
    const req = sent.find((m) => m.type === 'permission_request')
    if (req && req.type === 'permission_request') resolveDecision(req.requestId, 'allow')
    await p

    // The verdict path is entirely in-memory: no settings-style fs write happened.
    expect(writeFile).not.toHaveBeenCalled()
  })
})
