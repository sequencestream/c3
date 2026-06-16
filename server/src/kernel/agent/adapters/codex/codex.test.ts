/**
 * Codex driver + approval tests (2026-06-06-005). The SDK boundary is injected, so
 * a scripted event stream drives the driver with no Codex auth/binary (Phase 0 ran
 * L1-only). Covers: stream → canonical translation, sessionId resolution from
 * `thread.started`, resume via `resumeThread`, whole-turn abort + failure, the
 * neutral gate → sandbox/policy mapping, the structural preApproved stamp, and the
 * no-op approval bridge (no per-tool point exists — 008 NO-GO).
 */
import { describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { CanonicalMessage, DriverStartOptions } from '../types.js'
import {
  CodexDriver,
  codexDirectSandboxEnv,
  codexRelaySandboxEnv,
  rewriteRelayHostForSandbox,
  gateToCodexPolicy,
  mcpServersToCodexConfig,
  type CodexClient,
  type CodexFactoryOptions,
  type CodexThread,
} from './driver.js'
import { CodexApprovalBridge } from './approval.js'
import { createCodexAdapter } from './index.js'

// Host-binary resolver shim: lets the image test point a NON-sandbox run at a fake
// `codex` (the only DriverStartOptions binary knob — sandboxWrapperPath — would
// intentionally drop images). Default returns the name so every other test's real
// `resolve('codex')` is unchanged; fake-factory tests ignore codexPathOverride anyway.
const launcherShim = vi.hoisted(() => ({ codexPath: '' as string }))
vi.mock('../../process/launcher.js', () => ({
  resolve: (name: string) => launcherShim.codexPath || name,
}))

/** An async generator over a fixed script of events. */
async function* scriptEvents(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const ev of events) yield ev
}

/** A fake Codex client that records its launch options and replays a scripted stream. */
function fakeCodex(events: ThreadEvent[], threadId = 'thread_x') {
  const calls: { kind: 'start' | 'resume'; id?: string; options?: ThreadOptions }[] = []
  const thread: CodexThread = {
    id: threadId,
    runStreamed: async () => ({ events: scriptEvents(events) }),
  }
  const client: CodexClient = {
    startThread: (options) => {
      calls.push({ kind: 'start', options })
      return thread
    },
    resumeThread: (id, options) => {
      calls.push({ kind: 'resume', id, options })
      return thread
    },
  }
  return { client, calls }
}

function startOpts(over: Partial<DriverStartOptions> = {}): DriverStartOptions {
  return {
    prompt: 'do the thing',
    cwd: '/work',
    signal: new AbortController().signal,
    actionMode: 'build',
    toolGate: 'on-sensitive',
    ...over,
  }
}

async function collect(stream: AsyncIterable<CanonicalMessage>): Promise<CanonicalMessage[]> {
  const out: CanonicalMessage[] = []
  for await (const m of stream) out.push(m)
  return out
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

describe('CodexDriver', () => {
  it('translates a scripted event stream into canonical messages', async () => {
    const { client } = fakeCodex([
      { type: 'thread.started', thread_id: 'thread_1' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'hi there' } },
      { type: 'turn.completed', usage: {} as never },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())

    const msgs = await collect(run.messages())
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      vendor: 'codex',
      sessionId: 'thread_1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'hi there', id: 'i1' }],
    })
  })

  it('resolves sessionId from thread.started', async () => {
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 'thread_42' }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())
    expect(await run.sessionId()).toBe('thread_42')
  })

  it('uses resumeThread and resolves sessionId to the resumed id', async () => {
    const { client, calls } = fakeCodex([
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'resumed' } },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts({ resume: 'thread_old' }))

    expect(await run.sessionId()).toBe('thread_old')
    await collect(run.messages())
    expect(calls[0]).toMatchObject({ kind: 'resume', id: 'thread_old' })
  })

  it('stamps preApproved on tool items (launch-time gate auto-allow)', async () => {
    const { client } = fakeCodex([
      { type: 'thread.started', thread_id: 't' },
      {
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: 'x',
          exit_code: 0,
          status: 'completed',
        },
      },
    ])
    const driver = new CodexDriver(() => client)
    const msgs = await collect((await driver.start(startOpts())).messages())
    expect(msgs).toHaveLength(1)
    expect(msgs[0].preApproved).toBe(true)
    expect(msgs[0].blocks[0]).toMatchObject({ type: 'tool_use', name: 'shell' })
  })

  it('propagates a turn.failed as a thrown error on the stream', async () => {
    const { client } = fakeCodex([
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.failed', error: { message: 'model exploded' } },
    ])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts())
    await expect(collect(run.messages())).rejects.toThrow('model exploded')
  })

  it('abort stops the run and resolves sessionId without hanging', async () => {
    const controller = new AbortController()
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    const run = await driver.start(startOpts({ signal: controller.signal }))
    run.abort()
    // messages() ends (closed) and sessionId() still resolves.
    await collect(run.messages())
    expect(await run.sessionId()).toBeDefined()
  })

  it('passes the gate-derived sandbox/approval policy to startThread', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    await driver.start(startOpts({ actionMode: 'plan', toolGate: 'always-ask' }))
    expect(calls[0].options).toMatchObject({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
      workingDirectory: '/work',
      skipGitRepoCheck: true,
    })
  })

  it('threads networkAccess + webSearch into ThreadOptions (2026-06-15)', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    await driver.start(startOpts({ networkAccess: true, webSearch: true }))
    expect(calls[0].options).toMatchObject({
      networkAccessEnabled: true,
      webSearchEnabled: true,
      webSearchMode: 'live',
    })
  })

  it('omits network/web-search options when not requested (codex defaults stand)', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    await driver.start(startOpts())
    expect(calls[0].options).not.toHaveProperty('networkAccessEnabled')
    expect(calls[0].options).not.toHaveProperty('webSearchEnabled')
    expect(calls[0].options).not.toHaveProperty('webSearchMode')
  })

  it('networkAccess:false explicitly disables sandbox network (without enabling web search)', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    await driver.start(startOpts({ networkAccess: false }))
    expect(calls[0].options).toMatchObject({ networkAccessEnabled: false })
    expect(calls[0].options).not.toHaveProperty('webSearchEnabled')
  })

  it('default CLI wrapper spawns codex exec and parses JSONL events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-codex-cli-'))
    const fakeCodex = join(dir, 'codex')
    const argsFile = join(dir, 'args.txt')
    writeFileSync(
      fakeCodex,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${shQuote(argsFile)}`,
        'cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"thread_cli"}\'',
        'printf \'%s\\n\' \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"ok"}}\'',
        'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\'',
      ].join('\n'),
    )
    chmodSync(fakeCodex, 0o755)
    try {
      const driver = new CodexDriver()
      const run = await driver.start(
        startOpts({
          sandboxWrapperPath: fakeCodex,
          mcpServers: {
            c3: { type: 'http', url: 'http://127.0.0.1:3000/internal/intent-mcp/v1?token=t' },
          },
        }),
      )
      expect(await run.sessionId()).toBe('thread_cli')
      expect(await collect(run.messages())).toHaveLength(1)
      const argv = readFileSync(argsFile, 'utf-8').split('\n').filter(Boolean)
      expect(argv).toContain('exec')
      expect(argv).toContain('--experimental-json')
      expect(argv).toContain(
        'mcp_servers.c3.url="http://127.0.0.1:3000/internal/intent-mcp/v1?token=t"',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes prompt images to temp files, passes them as --image paths, and cleans up after the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-codex-img-cli-'))
    const fakeCodex = join(dir, 'codex')
    const argsFile = join(dir, 'args.txt')
    writeFileSync(
      fakeCodex,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${shQuote(argsFile)}`,
        'cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"thread_img"}\'',
        'printf \'%s\\n\' \'{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"saw it"}}\'',
        'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\'',
      ].join('\n'),
    )
    chmodSync(fakeCodex, 0o755)
    // Point the host-binary resolver at the fake codex (a NON-sandbox run, so images
    // are attached — sandboxWrapperPath would drop them).
    launcherShim.codexPath = fakeCodex
    try {
      const driver = new CodexDriver()
      const run = await driver.start(
        startOpts({
          images: [
            { mediaType: 'image/png', data: Buffer.from('PNGBYTES').toString('base64') },
            { mediaType: 'image/jpeg', data: Buffer.from('JPGBYTES').toString('base64') },
          ],
        }),
      )
      expect(await run.sessionId()).toBe('thread_img')
      await collect(run.messages())

      const argv = readFileSync(argsFile, 'utf-8').split('\n').filter(Boolean)
      // Two --image flags, each followed by a temp path under c3-codex-img-*.
      const imageFlagIdx = argv.flatMap((a, i) => (a === '--image' ? [i] : []))
      expect(imageFlagIdx).toHaveLength(2)
      const imagePaths = imageFlagIdx.map((i) => argv[i + 1])
      expect(imagePaths[0]).toMatch(/c3-codex-img-.*image-0\.png$/)
      expect(imagePaths[1]).toMatch(/c3-codex-img-.*image-1\.jpg$/)
      // The temp files were removed when the turn ended (no residue).
      for (const p of imagePaths) expect(existsSync(p)).toBe(false)
    } finally {
      launcherShim.codexPath = ''
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT attach images on a sandboxed run (host temp path is unreachable in the container)', async () => {
    let capturedInput: unknown
    const thread: CodexThread = {
      id: 't',
      runStreamed: async (input) => {
        capturedInput = input
        return { events: scriptEvents([{ type: 'thread.started', thread_id: 't' }]) }
      },
    }
    const driver = new CodexDriver(() => ({
      startThread: () => thread,
      resumeThread: () => thread,
    }))
    const run = await driver.start(
      startOpts({
        sandboxWrapperPath: '/tmp/c3-sb-xyz/wrapper.sh',
        images: [{ mediaType: 'image/png', data: Buffer.from('x').toString('base64') }],
      }),
    )
    await collect(run.messages())
    // Sandbox exception: the input stays a plain prompt string, no image items.
    expect(capturedInput).toBe('do the thing')
  })
})

describe('mcpServersToCodexConfig (2026-06-12-005)', () => {
  it('returns undefined for absent or empty server maps', () => {
    expect(mcpServersToCodexConfig(undefined)).toBeUndefined()
    expect(mcpServersToCodexConfig({})).toBeUndefined()
  })

  it('translates a neutral http descriptor to codex mcp_servers with approved tools', () => {
    const out = mcpServersToCodexConfig({
      c3: { type: 'http', url: 'http://127.0.0.1:3000/internal/intent-mcp/v1?token=abc' },
    })
    expect(out).toEqual({
      c3: {
        url: 'http://127.0.0.1:3000/internal/intent-mcp/v1?token=abc',
        enabled: true,
        required: true,
        enabled_tools: ['find_intents', 'view_intent', 'save_intents'],
        default_tools_approval_mode: 'approve',
      },
    })
  })

  it('carries bearer_token_env_var only when present', () => {
    expect(
      mcpServersToCodexConfig({
        c3: { type: 'http', url: 'http://x', bearerTokenEnvVar: 'C3_TOKEN' },
      }),
    ).toEqual({
      c3: {
        url: 'http://x',
        enabled: true,
        required: true,
        enabled_tools: ['find_intents', 'view_intent', 'save_intents'],
        default_tools_approval_mode: 'approve',
        bearer_token_env_var: 'C3_TOKEN',
      },
    })
  })
})

describe('CodexDriver mcpServers injection (2026-06-12-005)', () => {
  it('threads mcpServers into codex config.mcp_servers, merged with any relay config', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(
      startOpts({
        mcpServers: {
          c3: { type: 'http', url: 'http://127.0.0.1:3000/internal/intent-mcp/v1?token=t1' },
        },
      }),
    )
    expect(captured?.config?.mcp_servers).toEqual({
      c3: {
        url: 'http://127.0.0.1:3000/internal/intent-mcp/v1?token=t1',
        enabled: true,
        required: true,
        enabled_tools: ['find_intents', 'view_intent', 'save_intents'],
        default_tools_approval_mode: 'approve',
      },
    })
    expect(captured?.env?.NO_PROXY).toContain('127.0.0.1')
    expect(captured?.env?.no_proxy).toContain('localhost')
  })

  it('omits config.mcp_servers when no mcpServers given', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(startOpts())
    expect(captured?.config?.mcp_servers).toBeUndefined()
  })
})

describe('CodexDriver provider routing — wireApi DIRECT vs RELAY (2026-06-12-006)', () => {
  /** A fake relay that records register calls and mints a fixed token. */
  function fakeRelay() {
    const registered: { baseUrl: string; apiKey: string }[] = []
    const relay = {
      baseUrl: 'http://127.0.0.1:3000/internal/codex-relay/v1',
      register(upstream: { baseUrl: string; apiKey: string }) {
        registered.push(upstream)
        return 'relay-token-xyz'
      },
      unregister() {},
    }
    return { relay, registered }
  }

  it('wireApi=chat + custom baseUrl + relay ⇒ RELAY (token as apiKey, c3relay provider)', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay, registered } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-real', wireApi: 'chat' }),
    )
    // The REAL upstream is registered behind the token; codex only sees the token.
    expect(registered).toEqual([{ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-real' }])
    expect(captured?.apiKey).toBe('relay-token-xyz')
    expect(captured?.config?.model_provider).toBe('c3relay')
    // The raw provider URL never reaches the SDK as a baseUrl on the relay path.
    expect(captured?.baseUrl).toBeUndefined()
  })

  it('wireApi=responses + custom baseUrl + relay ⇒ DIRECT (raw baseUrl/apiKey, no relay)', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay, registered } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({ baseUrl: 'https://api.openai.com', apiKey: 'sk-real', wireApi: 'responses' }),
    )
    expect(registered).toEqual([]) // never went through the relay
    expect(captured?.baseUrl).toBe('https://api.openai.com')
    expect(captured?.apiKey).toBe('sk-real')
    expect(captured?.config?.model_provider).toBeUndefined()
  })

  it('no relay present ⇒ DIRECT even with a custom baseUrl', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }) // no relay injected
    await driver.start(startOpts({ baseUrl: 'https://api.deepseek.com', wireApi: 'chat' }))
    expect(captured?.baseUrl).toBe('https://api.deepseek.com')
    expect(captured?.config?.model_provider).toBeUndefined()
  })
})

describe('codexDirectSandboxEnv (sandbox DIRECT provider, ADR-0024)', () => {
  it('mirrors the DIRECT apiKey into CODEX_API_KEY', () => {
    expect(codexDirectSandboxEnv({ apiKey: 'sk-real', wireApi: 'responses' })).toEqual({
      CODEX_API_KEY: 'sk-real',
    })
  })

  it('writes nothing for the RELAY route (wireApi=chat)', () => {
    expect(codexDirectSandboxEnv({ apiKey: 'sk-real', wireApi: 'chat' })).toEqual({})
  })

  it('writes nothing when wireApi is absent (system-mode codex)', () => {
    expect(codexDirectSandboxEnv({ apiKey: 'sk-real' })).toEqual({})
  })

  it('writes nothing when the apiKey is missing even on the DIRECT route', () => {
    expect(codexDirectSandboxEnv({ wireApi: 'responses' })).toEqual({})
  })
})

describe('CodexDriver sandbox wrapper wiring (ADR-0024)', () => {
  it('uses sandboxWrapperPath as the codex executable when supplied', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(startOpts({ sandboxWrapperPath: '/tmp/c3-sb-xyz/wrapper.sh' }))
    expect(captured?.codexPathOverride).toBe('/tmp/c3-sb-xyz/wrapper.sh')
  })

  it('keeps DIRECT baseUrl/apiKey as SDK options (they ride the wrapper argv/env)', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(
      startOpts({
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-real',
        wireApi: 'responses',
        sandboxWrapperPath: '/tmp/c3-sb-xyz/wrapper.sh',
      }),
    )
    expect(captured?.codexPathOverride).toBe('/tmp/c3-sb-xyz/wrapper.sh')
    expect(captured?.baseUrl).toBe('https://api.openai.com')
    expect(captured?.apiKey).toBe('sk-real')
  })
})

describe('rewriteRelayHostForSandbox (codex RELAY in a container, ADR-0024 follow-up)', () => {
  it('rewrites a loopback relay host to host.docker.internal, preserving port + path', () => {
    expect(rewriteRelayHostForSandbox('http://127.0.0.1:3000/internal/codex-relay/v1')).toBe(
      'http://host.docker.internal:3000/internal/codex-relay/v1',
    )
  })

  it('rewrites localhost and ::1 too', () => {
    expect(rewriteRelayHostForSandbox('http://localhost:8080/internal/codex-relay/v1')).toBe(
      'http://host.docker.internal:8080/internal/codex-relay/v1',
    )
    expect(rewriteRelayHostForSandbox('http://[::1]:3000/x')).toBe(
      'http://host.docker.internal:3000/x',
    )
  })

  it('leaves a non-loopback host unchanged', () => {
    expect(rewriteRelayHostForSandbox('http://10.0.0.5:3000/x')).toBe('http://10.0.0.5:3000/x')
  })

  it('returns an unparseable input unchanged', () => {
    expect(rewriteRelayHostForSandbox('not a url')).toBe('not a url')
  })
})

describe('codexRelaySandboxEnv (RELAY token into the container env-file, ADR-0024 follow-up)', () => {
  it('mirrors the relay token as CODEX_API_KEY + NO_PROXY for the host.docker.internal hop', () => {
    expect(codexRelaySandboxEnv('relay-token-xyz')).toEqual({
      CODEX_API_KEY: 'relay-token-xyz',
      NO_PROXY: 'host.docker.internal,127.0.0.1,localhost,::1',
      no_proxy: 'host.docker.internal,127.0.0.1,localhost,::1',
    })
  })
})

describe('CodexDriver RELAY route inside a sandbox container (ADR-0024 follow-up)', () => {
  function fakeRelay() {
    const registered: { baseUrl: string; apiKey: string }[] = []
    const relay = {
      baseUrl: 'http://127.0.0.1:3000/internal/codex-relay/v1',
      register(upstream: { baseUrl: string; apiKey: string }) {
        registered.push(upstream)
        return 'relay-token-xyz'
      },
      unregister() {},
    }
    return { relay, registered }
  }

  it('rewrites base_url to host.docker.internal and appends the token to the env-file', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-test-'))
    const envFile = join(tmp, 'env.txt')
    writeFileSync(envFile, 'PATH=/usr/bin\n', 'utf-8')
    try {
      let captured: CodexFactoryOptions | undefined
      const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
      const { relay, registered } = fakeRelay()
      const driver = new CodexDriver((options) => {
        captured = options
        return client
      }, relay)
      await driver.start(
        startOpts({
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-real',
          wireApi: 'chat',
          sandboxWrapperPath: join(tmp, 'wrapper.sh'),
          sandboxEnvFile: envFile,
        }),
      )
      // The real upstream is registered behind the token; codex sees only the token.
      expect(registered).toEqual([{ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-real' }])
      expect(captured?.apiKey).toBe('relay-token-xyz')
      // base_url points at the container-reachable host alias, NOT loopback.
      const providers = captured?.config?.model_providers as
        | Record<string, { base_url?: string }>
        | undefined
      const provider = providers?.c3relay
      expect(provider?.base_url).toBe('http://host.docker.internal:3000/internal/codex-relay/v1')
      // The token crossed into the env-file (host-process CODEX_API_KEY would be dropped).
      const env = readFileSync(envFile, 'utf-8')
      expect(env).toContain('CODEX_API_KEY=relay-token-xyz')
      expect(env).toContain('NO_PROXY=host.docker.internal,127.0.0.1,localhost,::1')
      // The base env the wrapper wrote is preserved (append, not overwrite).
      expect(env).toContain('PATH=/usr/bin')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('host (non-sandbox) RELAY keeps the loopback base_url and never touches an env-file', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-real', wireApi: 'chat' }),
    )
    const providers = captured?.config?.model_providers as
      | Record<string, { base_url?: string }>
      | undefined
    const provider = providers?.c3relay
    expect(provider?.base_url).toBe('http://127.0.0.1:3000/internal/codex-relay/v1')
  })
})

describe('gateToCodexPolicy', () => {
  it('plan + never-ask ⇒ read-only + never for read-only MCP-backed flows', () => {
    expect(gateToCodexPolicy('plan', 'never-ask')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    })
  })

  it('plan + gated tools ⇒ read-only + on-request', () => {
    expect(gateToCodexPolicy('plan', 'always-ask')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    })
  })

  it('build + never-ask ⇒ workspace-write + never', () => {
    expect(gateToCodexPolicy('build', 'never-ask')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
  })

  it('build + always-ask degrades to a read-only sandbox (Codex cannot ask live)', () => {
    expect(gateToCodexPolicy('build', 'always-ask')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    })
  })

  it('build + trusted-prefix ⇒ workspace-write + on-failure', () => {
    expect(gateToCodexPolicy('build', 'trusted-prefix')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
    })
  })
})

describe('CodexApprovalBridge', () => {
  it('onRequest registers a handler and returns a working disposer (contract)', () => {
    const bridge = new CodexApprovalBridge()
    const handler = vi.fn()
    const dispose = bridge.onRequest(handler)
    expect(typeof dispose).toBe('function')
    dispose()
    // The handler is never invoked — there is no per-tool approval event in Codex.
    expect(handler).not.toHaveBeenCalled()
  })

  it('the MCP-approval fallback is OFF by default (Phase 0 §4 skeleton)', () => {
    expect(new CodexApprovalBridge().mcpFallback).toBe(false)
    expect(new CodexApprovalBridge({ mcpFallback: true }).mcpFallback).toBe(true)
  })
})

describe('createCodexAdapter', () => {
  it('assembles a codex adapter with the all-false ledger and empty session store', async () => {
    const adapter = createCodexAdapter()
    expect(adapter.vendor).toBe('codex')
    expect(adapter.capabilities.perToolApproval).toBe(false)
    expect(await adapter.sessions.list({ cwd: '/work' })).toEqual([])
    expect(await adapter.sessions.read('thread_1', { cwd: '/work' })).toEqual([])
  })
})
