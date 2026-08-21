/**
 * The chat robot's SECOND filesystem enforcement point, tested as the SDK would
 * invoke it. The PreToolUse hook exists because `canUseTool` is skippable: an
 * `allow` rule in an inherited `~/.claude/settings.json` resolves a tool BEFORE
 * c3's callback is ever consulted, so a host operator's own settings could make
 * a robot read outside its directory. The hook runs the SAME frozen-root
 * adjudication ahead of every rule, and a hook deny is terminal — which is what
 * makes "a robot reads only inside its own directory" independent of the host.
 *
 * This test drives the hook callback directly with the exact shapes the SDK
 * would pass, without spawning a `query()` process. It asserts the hook DENIES
 * what the gate denies, CONTINUES what the gate allows, and refuses with the
 * ONE fixed message — never the target path, so the robot still cannot probe
 * the host through the second channel either.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk'
import { robotFsPreToolUseHook } from './index.js'
import { freezeRobotRoot, ROBOT_FS_DENY_MESSAGE } from '../permission/index.js'

let base = ''
let root = ''
let outside = ''

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'c3-robot-hook-')))
  // The run root must exist before it can be frozen (a turn never starts on a
  // boundary it could not establish).
  mkdirSync(join(base, 'robot'), { recursive: true })
  root = freezeRobotRoot(join(base, 'robot'))
  outside = join(base, 'outside')
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'notes', 'a.md'), '# hello')
  writeFileSync(join(outside, 'secret.md'), 'secret')
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const call = (toolName: string, toolInput: unknown): Promise<unknown> => {
  const matcher = robotFsPreToolUseHook(root)
  const callback = matcher.hooks[0]!
  // The SDK invokes the hook with (input, options, signal); the hook only reads
  // the input, so options/signal are inert for these tests.
  return callback(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'toolu_test',
    } as unknown as PreToolUseHookInput,
    {} as never,
    { signal: new AbortController().signal },
  )
}

const denyDecision = (
  out: unknown,
): { permissionDecision: string; permissionDecisionReason: string } => {
  const o = out as {
    hookSpecificOutput?: {
      permissionDecision?: string
      permissionDecisionReason?: string
    }
  }
  expect(o.hookSpecificOutput).toBeDefined()
  return {
    permissionDecision: o.hookSpecificOutput!.permissionDecision!,
    permissionDecisionReason: o.hookSpecificOutput!.permissionDecisionReason!,
  }
}

describe('robotFsPreToolUseHook — the second enforcement point', () => {
  it('continues a local read that resolves INSIDE the frozen run root', async () => {
    expect(await call('Read', { file_path: join(root, 'notes', 'a.md') })).toMatchObject({
      continue: true,
    })
  })

  it('continues a relative read (resolved against the run root)', async () => {
    expect(await call('Read', { file_path: 'notes/a.md' })).toMatchObject({ continue: true })
  })

  it('DENIES a read that resolves OUTSIDE the run root, with the ONE fixed message', async () => {
    const out = await call('Read', { file_path: join(outside, 'secret.md') })
    const d = denyDecision(out)
    expect(d.permissionDecision).toBe('deny')
    expect(d.permissionDecisionReason).toBe(ROBOT_FS_DENY_MESSAGE)
    // The refusal must not echo the target — the robot cannot probe through the
    // hook any more than through the gate.
    expect(d.permissionDecisionReason).not.toMatch(/secret|outside|passwd/)
  })

  it('DENIES a `..` chain that leaves the run root', async () => {
    const out = await call('Read', { file_path: join(root, '..', '..', 'etc', 'passwd') })
    expect(denyDecision(out).permissionDecision).toBe('deny')
  })

  it('DENIES a Glob pattern that moves its walk root outside', async () => {
    expect(denyDecision(await call('Glob', { pattern: '/etc/**' })).permissionDecision).toBe('deny')
  })

  it('DENIES a c3 MCP tool that has grown an unexamined location field', async () => {
    // The MCP tools are bound to the robot's own directory at the transport and
    // take no path argument today; the day one of them does, the hook fails it
    // closed until that parameter is described — the same rule as the gate.
    expect(
      denyDecision(await call('mcp__c3__find_intents', { keyword: 'login', cwd: '/etc' }))
        .permissionDecision,
    ).toBe('deny')
  })

  it('continues a c3 MCP tool carrying no location (its transport is the boundary)', async () => {
    expect(await call('mcp__c3__find_intents', { keyword: 'login' })).toMatchObject({
      continue: true,
    })
  })

  it('continues a non-PreToolUse hook event untouched', async () => {
    const matcher = robotFsPreToolUseHook(root)
    const callback = matcher.hooks[0]!
    const out = await callback(
      { hook_event_name: 'SomeOtherEvent' } as unknown as PreToolUseHookInput,
      {} as never,
      { signal: new AbortController().signal },
    )
    expect(out).toMatchObject({ continue: true })
  })
})
