/**
 * Claude Agent SDK 0.3.219/0.3.220 compatibility boundaries (upgrade留痕).
 *
 * Drives the REAL `runClaude` with the SDK `query` mocked (the same pattern as
 * `socket-resume.test.ts`) to pin, at the stable config-construction seam, that the
 * 0.3.219 additions stay "compatible-but-not-adopted" — they neither change the
 * existing message handling nor leak a second sandbox-network / workflow policy
 * into the options c3 hands to `query()`:
 *
 *  - `DirectoryAdded` is a hook lifecycle event (in the SDK `HOOK_EVENTS` set); c3
 *    registers NO hooks, so it is never delivered to the run loop. Defensively, even
 *    a stream message of that shape falls through the `assistant`/`user`/`result`
 *    type switch: no wire frame, no `CanonicalMessage`, no turn close.
 *  - `fast_mode_disabled_reason` / `fast_mode_state` are additive optional fields on
 *    the init (`system`) and `result` messages. c3 reads none of them; the turn still
 *    reports its session id, emits its text, and closes on `result` exactly as before.
 *  - `sandbox.network.strictAllowlist` and `workflowSizeGuideline` are SDK *settings*
 *    fields. c3 constructs no `settings` (and no top-level `sandbox`) option, so the
 *    sandbox network boundary stays solely with the arapuca wrapper + c3 policy and no
 *    advisory workflow-size value is injected.
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

import { runClaude } from './kernel/agent/index.js'

const init = (extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sid-0220',
  ...extra,
})
const assistantText = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
})
const result = (extra: Record<string, unknown> = {}) => ({ type: 'result', ...extra })

/** Drive one runClaude turn, collecting the wire events it emits. */
async function runTurn(): Promise<ServerToClient[]> {
  const events: ServerToClient[] = []
  await runClaude({
    prompt: 'do the thing',
    cwd: '/tmp',
    workspacePath: '/tmp',
    signal: new AbortController().signal,
    permissionMode: 'default',
    send: (m) => events.push(m),
  })
  return events
}

beforeEach(() => {
  sdk.streams = []
  sdk.options = []
})

describe('SDK 0.3.219 DirectoryAdded hook event — harmless in the run loop', () => {
  it('a DirectoryAdded-shaped message yields no wire frame and does not close the turn', async () => {
    // A mid-session working-directory registration. In reality this is a hook event
    // c3 never subscribes to; here we feed it through the stream defensively. It sits
    // BEFORE the result to prove it does not itself end the turn.
    const directoryAdded = {
      type: 'system',
      subtype: 'directory_added',
      hook_event_name: 'DirectoryAdded',
      session_id: 'sid-0220',
      directory: '/tmp/registered-late',
    }
    sdk.streams.push([init(), directoryAdded, assistantText('hello'), result()])
    const events = await runTurn()

    // Only the assistant text + the single terminal turn_end reach the wire — the
    // DirectoryAdded message produced NO frame of its own.
    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    expect(events.some((e) => JSON.stringify(e).includes('DirectoryAdded'))).toBe(false)
    expect(events.some((e) => JSON.stringify(e).includes('directory_added'))).toBe(false)
    // The turn still closes exactly once, on the result (not on the hook event).
    const ends = events.filter((e) => e.type === 'turn_end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ type: 'turn_end', reason: 'complete' })
  })
})

describe('SDK 0.3.219 fast-mode fields — additive, not consumed', () => {
  it('fast_mode_disabled_reason / fast_mode_state on init + result do not change handling', async () => {
    sdk.streams.push([
      init({ fast_mode_state: 'disabled', fast_mode_disabled_reason: 'model_unsupported' }),
      assistantText('working'),
      result({ fast_mode_state: 'disabled', fast_mode_disabled_reason: 'model_unsupported' }),
    ])
    const events = await runTurn()

    // Normal path intact: one text frame, one clean turn_end.
    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
    expect(events.find((e) => e.type === 'turn_end')).toMatchObject({
      type: 'turn_end',
      reason: 'complete',
    })
    // No fast-mode field leaks onto the wire (c3 neither displays nor forwards it).
    expect(events.some((e) => JSON.stringify(e).includes('fast_mode'))).toBe(false)
  })
})

describe('SDK 0.3.219 settings fields — c3 injects neither sandbox.network nor workflowSizeGuideline', () => {
  it('the options handed to query() carry no `settings` object and no top-level `sandbox`', async () => {
    sdk.streams.push([init(), assistantText('ok'), result()])
    await runTurn()

    expect(sdk.options).toHaveLength(1)
    const opts = sdk.options[0]
    // Both new fields live under the SDK `settings` object (settings.sandbox.network
    // .strictAllowlist, settings.workflowSizeGuideline); c3 passes no settings at all,
    // so the sandbox network boundary stays with the arapuca wrapper + c3 policy and
    // no advisory workflow-size guideline is set.
    expect(opts).not.toHaveProperty('settings')
    expect(opts).not.toHaveProperty('sandbox')
    expect(opts).not.toHaveProperty('workflowSizeGuideline')
    // Belt and braces: the serialized options mention neither new field.
    const serialized = JSON.stringify(opts)
    expect(serialized.includes('strictAllowlist')).toBe(false)
    expect(serialized.includes('workflowSizeGuideline')).toBe(false)
  })
})
