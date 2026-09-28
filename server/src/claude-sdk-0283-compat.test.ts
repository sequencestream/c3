/**
 * Claude Agent SDK 0.3.237 → 0.3.283 compatibility boundaries (upgrade 留痕).
 *
 * Drives the REAL `runClaude` / `runTaskTool` with the SDK `query` mocked (the same
 * pattern as `claude-sdk-0237-compat.test.ts`) to pin, at the stable
 * config-construction and message-loop seams, what this upgrade window changed
 * for c3:
 *
 *  - **0.3.283 `system/informational`.** stream-json now emits warnings/notices
 *    that were previously dropped. c3's loop only narrows `assistant` / `user` /
 *    `result`; informational frames (even with `prevent_continuation`) produce
 *    no wire frame and do not close the turn.
 *  - **0.3.283 / 0.3.274 additive init fields** (`plugin_errors`, `startup_timing`,
 *    `user_message_uuid` / `user_message_uuids`). c3 does not read, echo, or persist
 *    them — they ride `unknown` narrowing with no wire leak.
 *  - **0.3.243 Read PDF inside `tool_result`.** Non-text content blocks are
 *    JSON-stringified by `stringifyToolResult`; the loop does not throw.
 *  - **0.3.268 task/todo default-tool shrink.** c3 still injects neither `tools`
 *    nor `allowedTools` (nor `CLAUDE_CODE_ENABLE_TODO_TOOLS`); `runTaskTool` keeps
 *    the same no-injection boundary.
 *  - **Hooks split.** Standard gate still has no `hooks` key. Robot gate with a
 *    frozen `robotRoot` DOES pass `hooks.PreToolUse` (the 0.3.237 record's "c3
 *    passes no hooks" claim was only true for the standard path).
 *  - **Surfaces c3 does not construct** (`verbatimPrompts`, `permissionPrompts`,
 *    `settings`, `prewarm`). Asserted absent from query options.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

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
  session_id: 'sid-0283',
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

describe('SDK 0.3.283 system/informational — ignored, does not close the turn', () => {
  it('an informational frame with prevent_continuation yields no wire frame and the turn still completes on result', async () => {
    sdk.streams.push([
      init(),
      {
        type: 'system',
        subtype: 'informational',
        session_id: 'sid-0283',
        message: 'plugin failed to load',
        prevent_continuation: true,
      },
      assistantText('ok'),
      result(),
    ])
    const events = await runTurn()

    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
    const serialized = JSON.stringify(events)
    expect(serialized.includes('informational')).toBe(false)
    expect(serialized.includes('prevent_continuation')).toBe(false)
    expect(serialized.includes('plugin failed to load')).toBe(false)
  })
})

describe('SDK 0.3.283 / 0.3.274 additive init fields — compatible, not consumed', () => {
  it('plugin_errors / startup_timing / user_message_uuids ride unknown narrowing', async () => {
    sdk.streams.push([
      init({
        plugin_errors: [{ plugin: 'demo', type: 'load', message: 'missing', path: '/x' }],
        startup_timing: { initialize_ms: 12 },
        user_message_uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        user_message_uuids: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
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
      'plugin_errors',
      'startup_timing',
      'user_message_uuid',
      'user_message_uuids',
    ]) {
      expect(serialized.includes(field)).toBe(false)
    }
  })
})

describe('SDK 0.3.243 Read PDF inside tool_result — stringified, no throw', () => {
  it('a document block in tool_result content becomes JSON on the wire', async () => {
    const documentBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'AAA' },
    }
    sdk.streams.push([
      init(),
      assistantText('reading'),
      toolResult('tu-pdf', [documentBlock]),
      result(),
    ])
    const events = await runTurn()

    const results = events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ type: 'tool_result', toolUseId: 'tu-pdf', isError: false })
    expect((results[0] as { content: string }).content).toContain('"type":"document"')
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
  })
})

describe('SDK 0.3.237-claim correction — hooks only on the robot gate', () => {
  it('standard gate still has no hooks / tools / allowedTools / settings / verbatimPrompts', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn()

    const opts = sdk.options[0]
    expect(opts).not.toHaveProperty('hooks')
    expect(opts).not.toHaveProperty('tools')
    expect(opts).not.toHaveProperty('allowedTools')
    expect(opts).not.toHaveProperty('settings')
    expect(opts).not.toHaveProperty('verbatimPrompts')
    expect(opts).not.toHaveProperty('permissionPrompts')
    expect(opts.permissionMode).toBe('default')
    expect(opts.canUseTool).toBeTypeOf('function')
  })

  it('robot gate with robotRoot passes PreToolUse hooks and still no tools/allowedTools', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn({ gate: 'robot', robotRoot: '/tmp/robot-root' })

    const opts = sdk.options[0]
    expect(opts.hooks).toEqual(
      expect.objectContaining({
        PreToolUse: expect.any(Array),
      }),
    )
    const pre = (opts.hooks as { PreToolUse: unknown[] }).PreToolUse
    expect(pre.length).toBeGreaterThan(0)
    expect(opts).not.toHaveProperty('tools')
    expect(opts).not.toHaveProperty('allowedTools')
    expect(opts.canUseTool).toBeTypeOf('function')
    expect(opts.permissionMode).toBe('default')
  })
})

describe('SDK 0.3.268 task/todo default-tool shrink — still no injection', () => {
  it('runClaude does not inject tools, allowedTools, or CLAUDE_CODE_ENABLE_TODO_TOOLS', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn()

    const opts = sdk.options[0]
    expect(opts).not.toHaveProperty('tools')
    expect(opts).not.toHaveProperty('allowedTools')
  })

  it('runTaskTool keeps the same no-injection boundary', async () => {
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
