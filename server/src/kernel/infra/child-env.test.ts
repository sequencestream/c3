/**
 * Unit coverage for the platform-branching executable lookup (release 4/7).
 *
 * `claudeLookupCommand` is the pure seam extracted from `findClaudeExecutable` so the
 * Windows vs POSIX branch is testable WITHOUT spawning a real process: Windows has no
 * `sh`, so it must use `where`; POSIX uses the portable `command -v`.
 */
import { describe, expect, it } from 'vitest'
import { KEEPALIVE_ENV_DEFAULTS, buildChildEnv, claudeLookupCommand } from './child-env.js'

describe('claudeLookupCommand', () => {
  it('uses `where claude` on Windows (no `sh` there)', () => {
    expect(claudeLookupCommand('win32')).toEqual(['where', ['claude']])
  })

  it('uses portable `sh -c command -v claude` on POSIX', () => {
    expect(claudeLookupCommand('darwin')).toEqual(['sh', ['-c', 'command -v claude']])
    expect(claudeLookupCommand('linux')).toEqual(['sh', ['-c', 'command -v claude']])
  })
})

describe('child env under the SDK 0.3.218 default subagent policy', () => {
  // SDK 0.3.217 added two subagent knobs — a concurrency cap (default 20) and a
  // spawn-depth cap (default 1). c3 accepts both defaults and must NOT inject
  // either override, so a subagent tree never widens or deepens past the SDK
  // default. buildChildEnv still layers process.env, so we assert only that these
  // keys are not sourced from c3's own defaults.
  const SUBAGENT_KNOBS = [
    'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
    'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
  ] as const

  it('keepalive defaults do not carry the subagent overrides', () => {
    for (const knob of SUBAGENT_KNOBS) {
      expect(KEEPALIVE_ENV_DEFAULTS).not.toHaveProperty(knob)
    }
  })

  it('buildChildEnv does not synthesize the subagent overrides', () => {
    const inherited = Object.fromEntries(
      SUBAGENT_KNOBS.filter((k) => k in process.env).map((k) => [k, process.env[k]]),
    )
    const env = buildChildEnv()
    for (const knob of SUBAGENT_KNOBS) {
      // The only way a knob appears is if the host shell already set it; c3 adds none.
      expect(env[knob]).toBe(inherited[knob])
    }
  })
})

describe('child env under the SDK 0.3.233 default task-tool surface', () => {
  // SDK 0.3.233 dropped TaskCreate/TaskList/TaskUpdate/TaskGet (+ TodoWrite) from the
  // DEFAULT tool surface on Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5 and newer, and
  // offers CLAUDE_CODE_ENABLE_TODO_TOOLS as the escape hatch. c3 accepts the SDK
  // default and injects NOTHING: the tool surface a spawned agent gets is the
  // vendor's own, not one c3 quietly rewrote. Whoever wants the tools back sets the
  // variable themselves — in their shell, or on an agent's env overrides — and the
  // precedence below lets that through untouched.
  const TODO_TOOLS_KNOB = 'CLAUDE_CODE_ENABLE_TODO_TOOLS'

  it('keepalive defaults do not carry the todo-tools override', () => {
    expect(KEEPALIVE_ENV_DEFAULTS).not.toHaveProperty(TODO_TOOLS_KNOB)
  })

  it('buildChildEnv does not synthesize the todo-tools override', () => {
    const saved = process.env[TODO_TOOLS_KNOB]
    try {
      delete process.env[TODO_TOOLS_KNOB]
      // The ONLY way it appears is if the host shell or the agent set it; c3 adds none.
      expect(buildChildEnv()[TODO_TOOLS_KNOB]).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env[TODO_TOOLS_KNOB]
      else process.env[TODO_TOOLS_KNOB] = saved
    }
  })

  it('passes a user/agent-supplied value straight through', () => {
    expect(buildChildEnv({ [TODO_TOOLS_KNOB]: '1' })[TODO_TOOLS_KNOB]).toBe('1')
  })
})

describe('child env loopback proxy bypass', () => {
  // A host that exports HTTP(S)_PROXY with no NO_PROXY made the claude CLI route
  // c3's OWN loopback MCP routes through that proxy; the proxy 502s, the MCP server
  // never connects, and every `mcp__c3__*` tool vanishes from the model's tool set
  // with no visible error (the model then guesses bare names and gets "No such tool
  // available: find_intents"). buildChildEnv must therefore always hand the child a
  // NO_PROXY covering c3's loopback.
  const PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const

  function withHostEnv(patch: Record<string, string | undefined>, body: () => void): void {
    const saved = new Map<string, string | undefined>()
    for (const key of Object.keys(patch)) saved.set(key, process.env[key])
    try {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      body()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it('injects the loopback hosts when the host sets no NO_PROXY', () => {
    withHostEnv({ NO_PROXY: undefined, no_proxy: undefined }, () => {
      const env = buildChildEnv()
      for (const key of PROXY_KEYS) {
        expect(env[key]).toBe('127.0.0.1,localhost,::1')
      }
    })
  })

  it('appends to — never replaces — a host-configured bypass list', () => {
    withHostEnv({ NO_PROXY: 'example.com', no_proxy: 'example.com' }, () => {
      const env = buildChildEnv()
      for (const key of PROXY_KEYS) {
        expect(env[key]).toBe('example.com,127.0.0.1,localhost,::1')
      }
    })
  })

  it('keeps an agent override yet still guarantees the loopback bypass', () => {
    // NO_PROXY is the one key computed AFTER envOverrides: an agent-supplied value is
    // preserved, but the loopback hosts are still appended — otherwise a proxy-carrying
    // agent config would knock out the c3 tools again.
    withHostEnv({ NO_PROXY: undefined, no_proxy: undefined }, () => {
      const env = buildChildEnv({ NO_PROXY: 'corp.internal' })
      expect(env.NO_PROXY).toBe('corp.internal,127.0.0.1,localhost,::1')
      expect(env.no_proxy).toBe('127.0.0.1,localhost,::1')
    })
  })
})
