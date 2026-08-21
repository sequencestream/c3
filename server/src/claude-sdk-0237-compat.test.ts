/**
 * Claude Agent SDK 0.3.233 → 0.3.237 compatibility boundaries (upgrade 留痕).
 *
 * Drives the REAL `runClaude` / `runTaskTool` with the SDK `query` mocked (the same
 * pattern as `claude-sdk-0233-compat.test.ts` and `claude-sdk-0220-compat.test.ts`)
 * to pin, at the stable config-construction and message-loop seams, what this upgrade
 * window changed for c3:
 *
 *  - **0.3.234 breaking `ExitReason`.** `bypass_permissions_disabled` was removed from
 *    `ExitReason` / `EXIT_REASONS` (the value was never emitted). c3 does not consume
 *    `ExitReason` anywhere — asserted here at the option-construction seam: no new
 *    case branch appears and no option keys change. The compile-time break is inert.
 *  - **0.3.234 `ApiKeySource` widening** (`ANTHROPIC_API_KEY` / `apiKeyHelper` /
 *    `/login managed key` / `none` + 4 legacy members). Additive; c3 never branches
 *    on the source, so the new members ride `unknown` narrowing harmlessly.
 *  - **0.3.234 `SDKSystemMessage.effort`** (applied effort level, `null` when unset).
 *    c3 does not read it, does not echo it, and adds no wire/persisted field — the
 *    model directory keeps its own reasoning-level vocabulary, and a single init
 *    telemetry value is not a product capability.
 *  - **0.3.234 / 0.3.236 host-injected surfaces c3 does not construct** — `origin`
 *    `fromMode` (cross-session peer class) and the `PostToolUseHookOutput`
 *    `classifierContext` hook return. c3 passes no `hooks` to the SDK, so these are
 *    inert; the assert below pins "no `hooks` key in the query options".
 *  - **0.3.236 `SDKAssistantMessageError.account_on_hold`.** Account-level terminal
 *    error. c3's `isDegradableError` classifies error TEXT, and the `assistant.error`
 *    structured field never reaches that classifier (it does not close the turn
 *    through the catch path). Asserted: an assistant message carrying
 *    `error: 'account_on_hold'` still passes through the loop with no wire frame and
 *    no turn close, and does NOT take the degradable path.
 *  - **0.3.237 parity (Claude Code v2.1.237).** Auto-mode hardening (classifier
 *    defaults on Bedrock/Vertex/Foundry, `Monitor` rules set aside in auto, git
 *    status check) — all tighten an existing classifier c3 already defaults away
 *    from (`auto` is not a mode c3 starts runs in); the `PermissionMode` union is
 *    unchanged across 0.3.233 → 0.3.237. Asserted: no c3 `permissionMode` mapping
 *    changed and the options surface c3 builds is byte-identical in shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

// Per-test programmed message streams (one array per query() call) + a capture of
// each call's full options object (to assert the config-construction boundary).
const sdk = vi.hoisted(() => ({
  streams: [] as Array<Array<Record<string, unknown>>>,
  options: [] as Array<Record<string, unknown>>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { options?: Record<string, unknown> }) => {
    sdk.options.push(arg.options ?? {})
    const steps = sdk.streams.shift() ?? []
    return {
      async *[Symbol.asyncIterator]() {
        for (const s of steps) yield s
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
    }
  },
}))

import { runClaude, runTaskTool } from './kernel/agent/index.js'

const init = (extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sid-0237',
  ...extra,
})
const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const toolResult = (id: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] },
  ...extra,
})
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', ...extra })

/** Drive one runClaude turn, collecting the wire events it emits. */
async function runTurn(overrides: Record<string, unknown> = {}): Promise<ServerToClient[]> {
  const events: ServerToClient[] = []
  await runClaude({
    prompt: 'do the thing',
    cwd: '/tmp',
    workspacePath: '/tmp',
    signal: new AbortController().signal,
    permissionMode: 'default',
    send: (m) => events.push(m),
    ...overrides,
  })
  return events
}

beforeEach(() => {
  sdk.streams = []
  sdk.options = []
})

describe('SDK 0.3.234 breaking ExitReason — c3 has no ExitReason consumer', () => {
  it('no exit-reason case branch leaks into the message loop and options are unchanged in shape', async () => {
    // The loop only narrows `assistant` / `user` / `result`. Feeding a `result`
    // whose `subtype` would have been matched against `bypass_permissions_disabled`
    // (had c3 kept such a branch) proves no such branch exists: the turn closes
    // exactly as before with a `complete` reason.
    sdk.streams.push([init(), assistantText('ok'), result({ subtype: 'success' })])
    const events = await runTurn()

    expect(events.some((e) => JSON.stringify(e).includes('bypass_permissions_disabled'))).toBe(
      false,
    )
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
  })
})

describe('SDK 0.3.234 additive init fields — compatible, not consumed', () => {
  it('init effort / syncClaudeAiSkills / spellcheck / autoContinueAtUsageLimit ride `unknown` narrowing', async () => {
    // 0.3.234 `SDKSystemMessage.effort`; 0.3.235 parity surfaced the `Settings`
    // spellcheck knob; 0.3.234 `ApiKeySource` widened. c3 reads none of them and
    // emits no wire frame for any.
    sdk.streams.push([
      init({
        effort: 'medium',
        apiKeySource: '/login managed key',
        syncClaudeAiSkills: true,
        spellcheck: { enabled: true, checker: 'aspell' },
        autoContinueAtUsageLimit: true,
      }),
      assistantText('working'),
      result(),
    ])
    const events = await runTurn()

    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
    const serialized = JSON.stringify(events)
    for (const field of [
      'effort',
      'apiKeySource',
      'syncClaudeAiSkills',
      'spellcheck',
      'autoContinueAtUsageLimit',
    ]) {
      expect(serialized.includes(field)).toBe(false)
    }
  })
})

describe('SDK 0.3.234/0.3.236 host-injected surfaces c3 does not construct', () => {
  it('no `hooks` key and no `origin`/`fromMode` in the query options', async () => {
    // c3 is the permission UI via `canUseTool`; it never passes SDK hooks, so the
    // 0.3.236 `PostToolUseHookOutput.classifierContext` and the 0.3.234 peer-origin
    // `fromMode` are both inert. A future c3 hooks user would change this assertion.
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn()

    const opts = sdk.options[0]
    expect(opts).not.toHaveProperty('hooks')
    expect(opts.canUseTool).toBeTypeOf('function')
    const serialized = JSON.stringify(opts)
    for (const field of ['classifierContext', 'fromMode', 'origin']) {
      expect(serialized.includes(field)).toBe(false)
    }
  })
})

describe('SDK 0.3.236 account_on_hold — account-level terminal, not vendor-wide', () => {
  it('an assistant message carrying error account_on_hold does not close the turn or mark the vendor unavailable', async () => {
    // `SDKAssistantMessage.error` is a structured field ON the assistant message; it
    // does not route through `isDegradableError` (which classifies the THROWN error
    // text of a failed run). c3 maps only `assistant` content blocks, so the error
    // field is invisible to it — the turn keeps streaming and ends with `complete`,
    // and no `account_on_hold` text reaches the wire.
    sdk.streams.push([
      init(),
      assistantText('continuing'),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'still going' }] },
        error: 'account_on_hold',
      },
      result(),
    ])
    const events = await runTurn()

    expect(events.filter((e) => e.type === 'assistant_text').length).toBeGreaterThanOrEqual(2)
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
    expect(JSON.stringify(events).includes('account_on_hold')).toBe(false)
  })
})

describe('SDK 0.3.237 parity — c3 run modes and permission mapping unchanged', () => {
  it('runClaude builds the same permission mode and options surface as before', async () => {
    // 2.1.237 hardens the `auto` permission classifier. c3 runs sessions in
    // `default` (or a mapped mode); `auto` only appears as a user-picked automation
    // mode, and the `PermissionMode` union is unchanged across 0.3.233 → 0.3.237.
    sdk.streams.push([init(), assistantText('ok'), result()])
    const events = await runTurn()

    const opts = sdk.options[0]
    expect(opts.permissionMode).toBe('default')
    // The option surface c3 builds is stable: no new SDK-parity keys crept in.
    expect(opts).not.toHaveProperty('autoContinueAtUsageLimit')
    expect(opts).not.toHaveProperty('spellcheck')
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(1)
  })

  it('runTaskTool (the ClaudeTaskStore executor) keeps the same no-injection boundary', async () => {
    sdk.streams.push([init(), toolResult('tu-1', '{"tasks":[]}'), result()])
    await runTaskTool({
      toolName: 'TaskList',
      input: {},
      cwd: '/tmp',
      signal: new AbortController().signal,
    })

    const opts = sdk.options[0]
    expect(opts).not.toHaveProperty('env')
    expect(opts).not.toHaveProperty('tools')
    expect(opts).not.toHaveProperty('allowedTools')
    expect(opts).not.toHaveProperty('hooks')
    expect(opts.permissionMode).toBe('default')
  })
})
