/**
 * Keepalive env injection — the prevention layer (scheme E, first line of defence)
 * against `socket connection was closed unexpectedly` (AS-R20).
 *
 * Drives the REAL `runClaude` with the SDK `query` mocked (same pattern as
 * `socket-resume.test.ts`) and captures the `options.env` the SDK is spawned with,
 * asserting:
 *  - the keepalive vars are always present (even with no agent overrides), and
 *  - a same-named value set by the user (`process.env`) or the agent
 *    (`envOverrides`) overrides the keepalive default (user priority).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Capture each query() call's resolved options.env.
const sdk = vi.hoisted(() => ({
  envs: [] as Array<Record<string, string> | undefined>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { options?: { env?: Record<string, string> } }) => {
    sdk.envs.push(arg.options?.env)
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', session_id: 'sid' }
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
    }
  },
}))

import { runClaude } from './kernel/agent/index.js'
import { KEEPALIVE_ENV_DEFAULTS, buildChildEnv } from './kernel/infra/child-env.js'

/** Drive one runClaude turn and return the env it spawned the SDK with. */
async function runAndCaptureEnv(
  envOverrides?: Record<string, string>,
): Promise<Record<string, string>> {
  await runClaude({
    prompt: 'go',
    cwd: '/tmp',
    workspacePath: '/tmp',
    signal: new AbortController().signal,
    permissionMode: 'default',
    envOverrides,
    send: () => {},
  })
  const env = sdk.envs.at(-1)
  if (!env) throw new Error('query() was not called with an env')
  return env
}

beforeEach(() => {
  sdk.envs = []
})

describe('keepalive env injection (AS-R20)', () => {
  it('injects all keepalive vars even with no agent overrides (system agent)', async () => {
    const env = await runAndCaptureEnv(undefined)
    expect(env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES).toBe('true')
    expect(env.BUN_CONFIG_HTTP_IDLE_TIMEOUT).toBe('120')
    expect(env.BUN_CONFIG_HTTP_RETRY_COUNT).toBe('3')
  })

  it('still carries the full process.env, not just the keepalive vars', async () => {
    const env = await runAndCaptureEnv(undefined)
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('lets an agent override (envOverrides) win over the keepalive default', async () => {
    const env = await runAndCaptureEnv({ BUN_CONFIG_HTTP_RETRY_COUNT: '9' })
    expect(env.BUN_CONFIG_HTTP_RETRY_COUNT).toBe('9') // agent value, not the default '3'
    // Non-overridden keepalive vars stay at their defaults.
    expect(env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES).toBe('true')
  })

  describe('with a same-named var in the user shell (process.env)', () => {
    const KEY = 'CLAUDE_CODE_REMOTE_SEND_KEEPALIVES'
    let prev: string | undefined
    beforeEach(() => {
      prev = process.env[KEY]
      process.env[KEY] = 'false'
    })
    afterEach(() => {
      if (prev === undefined) delete process.env[KEY]
      else process.env[KEY] = prev
    })

    it('lets the user shell value win over the keepalive default', async () => {
      const env = await runAndCaptureEnv(undefined)
      expect(env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES).toBe('false')
    })

    it('but the agent override still wins over the user shell', async () => {
      const env = await runAndCaptureEnv({ [KEY]: 'true' })
      expect(env[KEY]).toBe('true')
    })
  })
})

describe('buildChildEnv precedence (low → high: keepalive < process.env < overrides)', () => {
  it('returns keepalive defaults merged under process.env and overrides', () => {
    const env = buildChildEnv({ FOO_AGENT_ONLY: 'bar' })
    for (const [k, v] of Object.entries(KEEPALIVE_ENV_DEFAULTS)) {
      // present unless process.env already defines the same key
      if (process.env[k] === undefined) expect(env[k]).toBe(v)
    }
    expect(env.FOO_AGENT_ONLY).toBe('bar')
    expect(env.PATH).toBe(process.env.PATH)
  })
})
