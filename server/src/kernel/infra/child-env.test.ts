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
