/**
 * Claude Agent SDK 0.3.221 → 0.3.233 compatibility boundaries (upgrade 留痕).
 *
 * Drives the REAL `runClaude` / `runTaskTool` with the SDK `query` mocked (the same
 * pattern as `claude-sdk-0220-compat.test.ts` and `socket-resume.test.ts`) to pin, at
 * the stable config-construction and message-loop seams, what this upgrade window
 * changed for c3:
 *
 *  - **0.3.233 task/todo tool surface (the one behaviour change c3 had to act on).**
 *    `TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet` (+ `TodoWrite`) left the DEFAULT
 *    tool surface on Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5 and newer. c3's task
 *    panel is derived ONLY from those tools' wire frames, so the surface is restored
 *    via `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` on the child env — deliberately NOT via
 *    `tools` (which would replace the whole built-in set) or `allowedTools` (which
 *    means "auto-allowed without prompting" and would pre-decide these tools behind
 *    `canUseTool`, c3's single permission chokepoint).
 *  - **0.3.223 `system/permission_denied` stream event.** Additive; falls through the
 *    `assistant`/`user`/`result` type switch with no wire frame and no turn close.
 *  - **0.3.223/0.3.228/0.3.229/0.3.232 additive result fields** (`api_error_status`,
 *    `modelUsage`, `usage.output_tokens_details`, `terminal_reason: 'api_error'`,
 *    `context_usage`). c3 reads none of them; the turn still closes exactly as before
 *    and nothing leaks onto the wire.
 *  - **0.3.232 subagent `tool_use_result` shape change** (bare value → `{ content,
 *    _meta }`). c3 parses the `tool_result` CONTENT BLOCK on the user message, never
 *    the sibling `tool_use_result` field, so the reshape is inert.
 *  - **0.3.221/0.3.223/0.3.224 option surfaces c3 does not construct** (`skills`,
 *    `resumeDropsTurn`, `sessionStore`, `settings`). Asserted absent from the options
 *    handed to `query()`, including on the resume path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import { applyTaskTool, emptyTaskModel, isTaskTool } from '@ccc/shared/task-model'

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
  session_id: 'sid-0233',
  ...extra,
})
const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
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

describe('SDK 0.3.233 task/todo tool surface — explicitly kept, not degraded', () => {
  it('runClaude spawns the child with the task-tool surface restored', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn()

    const env = sdk.options[0].env as Record<string, string>
    // Without this the four task tools vanish from the model's tool set on the newer
    // models and `task-tracker` — whose ONLY data source is their tool frames — would
    // derive an empty panel with no error anywhere.
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
  })

  it('keeps them WITHOUT reaching for `tools` or `allowedTools`', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn()

    const opts = sdk.options[0]
    // `tools` REPLACES the base built-in surface — adopting it would force c3 to
    // enumerate every built-in it wants forever.
    expect(opts).not.toHaveProperty('tools')
    // `allowedTools` means "auto-allowed without prompting": it would pre-decide the
    // task tools BEHIND `canUseTool`, which must stay c3's single permission chokepoint.
    expect(opts).not.toHaveProperty('allowedTools')
    expect(opts.canUseTool).toBeTypeOf('function')
  })

  it('runTaskTool (the ClaudeTaskStore executor) also gets the surface restored', async () => {
    sdk.streams.push([init(), toolResult('tu-1', '{"tasks":[]}'), result()])
    await runTaskTool({
      toolName: 'TaskList',
      input: {},
      cwd: '/tmp',
      signal: new AbortController().signal,
    })

    const opts = sdk.options[0]
    const env = opts.env as Record<string, string>
    // The executor exists to invoke ONE task tool; losing the surface would break the
    // whole store, not just the panel. `env` replaces the child environment wholesale,
    // so PATH/HOME must still be there.
    expect(env.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
    expect(env.PATH).toBe(process.env.PATH)
    expect(opts).not.toHaveProperty('tools')
    expect(opts).not.toHaveProperty('allowedTools')
  })

  it('a TaskList call still reaches the wire as the frames the task panel is derived from', async () => {
    const listed = '{"tasks":[{"id":"1","subject":"ship it","status":"in_progress"}]}'
    sdk.streams.push([
      init(),
      toolUse('tu-list', 'TaskList', {}),
      toolResult('tu-list', listed),
      result(),
    ])
    const events = await runTurn()

    const use = events.find((e) => e.type === 'tool_use')
    const res = events.find((e) => e.type === 'tool_result')
    expect(use).toMatchObject({ type: 'tool_use', toolUseId: 'tu-list', toolName: 'TaskList' })
    expect(res).toMatchObject({ type: 'tool_result', toolUseId: 'tu-list', isError: false })

    // The exact pair `observeTaskWire` correlates — folded through the shared model
    // (the single SoT) it yields a non-empty snapshot, so the panel's data path is
    // intact end to end.
    expect(isTaskTool('TaskList')).toBe(true)
    const model = applyTaskTool(
      emptyTaskModel(),
      'TaskList',
      {},
      {
        content: (res as { content: string }).content,
        isError: false,
      },
    )
    expect(model.tasks).toEqual([{ id: '1', subject: 'ship it', status: 'in_progress', order: 0 }])
  })
})

describe('SDK 0.3.223 system/permission_denied stream event — harmless in the run loop', () => {
  it('produces no wire frame and does not close the turn', async () => {
    // Emitted only on the bare-headless path (no `canUseTool`); c3 always supplies a
    // gateway, so it should never arrive at all. Fed through defensively, BEFORE the
    // result, to prove it does not itself end the turn.
    const permissionDenied = {
      type: 'system',
      subtype: 'permission_denied',
      session_id: 'sid-0233',
      tool_name: 'Bash',
    }
    sdk.streams.push([init(), permissionDenied, assistantText('hello'), result()])
    const events = await runTurn()

    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    expect(events.some((e) => JSON.stringify(e).includes('permission_denied'))).toBe(false)
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
  })
})

describe('SDK 0.3.223–0.3.232 additive result fields — compatible, not consumed', () => {
  it('api_error_status / modelUsage / context_usage / terminal_reason do not change handling', async () => {
    sdk.streams.push([
      init({ terminal_slash_commands: ['/resume', '/clear'] }),
      assistantText('working'),
      result({
        // 0.3.223: structural overload signal; 0.3.229: the 32 MB body cap now ends
        // the turn as `api_error` rather than `image_error`.
        api_error_status: 529,
        terminal_reason: 'api_error',
        error_details: 'request_body_over_limit: 33554432',
        // 0.3.223 documented `modelUsage` (cumulative, all pipeline calls) as the
        // cost-accounting field; 0.3.228 carries `output_tokens_details` through.
        usage: { output_tokens: 12, output_tokens_details: { reasoning_tokens: 4 } },
        modelUsage: { 'claude-opus-5': { outputTokens: 12 } },
        // 0.3.232: structured `/context` payload (SDKContextUsage).
        context_usage: { total_tokens: 1000, used_tokens: 120 },
      }),
    ])
    const events = await runTurn()

    // c3 has no cost/usage or terminal-reason product surface today: the turn closes
    // exactly as before and none of the new fields leak onto the wire.
    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
    const serialized = JSON.stringify(events)
    for (const field of [
      'api_error_status',
      'terminal_reason',
      'modelUsage',
      'output_tokens_details',
      'context_usage',
      'terminal_slash_commands',
    ]) {
      expect(serialized.includes(field)).toBe(false)
    }
  })
})

describe('SDK 0.3.232 subagent tool_use_result reshape — inert for c3', () => {
  it('the tool_result CONTENT BLOCK is still what c3 parses; `_meta` never leaks', async () => {
    // 0.3.232 changed the sibling `tool_use_result` field from a bare value to
    // `{ content, _meta }` when the MCP result carries `_meta`. c3 reads only the
    // `tool_result` block on `message.content`, so the wire frame is unchanged.
    sdk.streams.push([
      init(),
      toolUse('tu-mcp', 'mcp__c3__find_intents', { q: 'x' }),
      toolResult('tu-mcp', 'found 2 intents', {
        tool_use_result: { content: 'found 2 intents', _meta: { source: 'subagent' } },
      }),
      result(),
    ])
    const events = await runTurn()

    const res = events.find((e) => e.type === 'tool_result')
    expect(res).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tu-mcp',
      content: 'found 2 intents',
      isError: false,
    })
    expect(JSON.stringify(events).includes('_meta')).toBe(false)
  })
})

describe('SDK 0.3.221–0.3.224 option surfaces c3 does not construct', () => {
  it('no `skills`, `resumeDropsTurn`, `sessionStore` or `settings` in the query options', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn({ resume: 'prior-session' })

    expect(sdk.options).toHaveLength(1)
    const opts = sdk.options[0]
    // 0.3.221 tightened `skills` name validation — c3 passes no `skills` option at
    // all (skills reach the model as on-disk `.claude/skills` entries via
    // `settingSources`), so no name of c3's can trip the new validator.
    expect(opts).not.toHaveProperty('skills')
    // 0.3.223's truncating-resume declaration: c3 resumes whole sessions, never
    // truncated ones, so neither `resumeDropsTurn` nor `resumeSessionAt` is set.
    expect(opts).not.toHaveProperty('resumeDropsTurn')
    expect(opts).not.toHaveProperty('resumeSessionAt')
    // 0.3.222 fixed `query({ sessionStore, resume })` not carrying user settings.json
    // into the resumed subprocess. c3 uses the plain `resume` path with NO
    // `sessionStore`, and always hands the child an EXPLICIT env, so that fix cannot
    // change what this subprocess inherits.
    expect(opts.resume).toBe('prior-session')
    expect(opts).not.toHaveProperty('sessionStore')
    expect(opts.env).toBeTypeOf('object')
    expect(opts.settingSources).toEqual(['user', 'project'])
    // 0.3.224's `crossSessionInbound` / `dialogExpiry` / archive plugin source /
    // sandbox credential masking all live under SDK `settings`, which c3 never builds.
    expect(opts).not.toHaveProperty('settings')
    const serialized = JSON.stringify(opts)
    for (const field of ['crossSessionInbound', 'dialogExpiry', 'maskClaims', 'awsPairs']) {
      expect(serialized.includes(field)).toBe(false)
    }
  })
})
