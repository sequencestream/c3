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
import type { RelayCandidate } from '../../../relay/contract.js'
import {
  CodexDriver,
  codexPolicyToGrid,
  convergeCodexPolicy,
  gateToCodexPolicy,
  mcpServersToCodexConfig,
  mcpServersEnableSaveIntents,
  isUpstreamStreamBreak,
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

  it('passes additional writable directories to startThread', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    await driver.start(startOpts({ additionalDirectories: ['/home/user/.c3/specs/project'] }))
    expect(calls[0].options).toMatchObject({
      additionalDirectories: ['/home/user/.c3/specs/project'],
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
          additionalDirectories: ['/home/user/.c3/specs/project'],
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
      expect(argv).toContain('--add-dir')
      expect(argv).toContain('/home/user/.c3/specs/project')
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

  it('uses the descriptor tool allowlist when provided', () => {
    const out = mcpServersToCodexConfig({
      c3: {
        type: 'http',
        url: 'http://127.0.0.1:3000/internal/spec-query-mcp/v1?token=abc',
        enabledTools: ['find_intents', 'view_intent'],
      },
    })
    expect(out?.c3.enabled_tools).toEqual(['find_intents', 'view_intent'])
  })

  it('carries bearer_token_env_var only when present', () => {
    expect(
      mcpServersToCodexConfig({
        c3: {
          type: 'http',
          url: 'http://x',
          bearerTokenEnvVar: 'C3_TOKEN',
          enabledTools: ['find_intents'],
        },
      }),
    ).toEqual({
      c3: {
        url: 'http://x',
        enabled: true,
        required: true,
        enabled_tools: ['find_intents'],
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

describe('mcpServersEnableSaveIntents (intent-run identification)', () => {
  it('is false for absent servers', () => {
    expect(mcpServersEnableSaveIntents(undefined)).toBe(false)
    expect(mcpServersEnableSaveIntents({})).toBe(false)
  })

  it('is true when a server enables save_intents (intent profile)', () => {
    expect(
      mcpServersEnableSaveIntents({
        c3: {
          type: 'http',
          url: 'http://x',
          enabledTools: ['find_intents', 'view_intent', 'save_intents'],
        },
      }),
    ).toBe(true)
  })

  it('is true when enabledTools is omitted (old-style intent binding defaults to the three intent tools)', () => {
    expect(mcpServersEnableSaveIntents({ c3: { type: 'http', url: 'http://x' } })).toBe(true)
  })

  it('is false for the spec find/view-only profile and the work publish_event profile', () => {
    expect(
      mcpServersEnableSaveIntents({
        c3: { type: 'http', url: 'http://x', enabledTools: ['find_intents', 'view_intent'] },
      }),
    ).toBe(false)
    expect(
      mcpServersEnableSaveIntents({
        c3: { type: 'http', url: 'http://x', enabledTools: ['publish_event'] },
      }),
    ).toBe(false)
  })
})

describe('CodexDriver intent-run code-execution + web-search shutdown', () => {
  const intentServers = {
    c3: {
      type: 'http' as const,
      url: 'http://127.0.0.1:3000/internal/intent-mcp/v1?token=t',
      enabledTools: ['find_intents', 'view_intent', 'save_intents'],
    },
  }

  it('merges features.js_repl=false + tools.web_search=false and forces web search off, keeping mcp_servers', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    // run-via-driver passes webSearch:true for every interactive run; the intent
    // shutdown must override it.
    await driver.start(startOpts({ mcpServers: intentServers, webSearch: true }))
    expect(captured?.config?.features).toEqual({ js_repl: false })
    expect(captured?.config?.tools).toEqual({ web_search: false })
    // The intent MCP servers survive the merge.
    expect(captured?.config?.mcp_servers).toBeDefined()
    // web search is forced off (old-format disabled), never live.
    expect(calls[0].options).toMatchObject({ webSearchEnabled: false })
    expect(calls[0].options).not.toHaveProperty('webSearchMode')
  })

  it('recognises an old-style intent binding (no explicit enabledTools) and shuts it down', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(
      startOpts({
        mcpServers: { c3: { type: 'http', url: 'http://127.0.0.1:3000/x?token=t' } },
        webSearch: true,
      }),
    )
    expect(captured?.config?.features).toEqual({ js_repl: false })
    expect(captured?.config?.tools).toEqual({ web_search: false })
    expect(calls[0].options).toMatchObject({ webSearchEnabled: false })
  })

  it('applies the same shutdown on resume as on a new thread', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(
      startOpts({ mcpServers: intentServers, webSearch: true, resume: 'thread_old' }),
    )
    expect(calls[0].kind).toBe('resume')
    expect(captured?.config?.features).toEqual({ js_repl: false })
    expect(captured?.config?.tools).toEqual({ web_search: false })
    expect(calls[0].options).toMatchObject({ webSearchEnabled: false })
  })

  it('does NOT shut down work (publish_event) or spec (find/view) runs — web search stays live', async () => {
    for (const enabledTools of [['publish_event'], ['find_intents', 'view_intent']]) {
      let captured: CodexFactoryOptions | undefined
      const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
      const driver = new CodexDriver((options) => {
        captured = options
        return client
      })
      await driver.start(
        startOpts({
          mcpServers: { c3: { type: 'http', url: 'http://x', enabledTools } },
          webSearch: true,
        }),
      )
      expect(captured?.config?.features).toBeUndefined()
      expect(captured?.config?.tools).toBeUndefined()
      expect(calls[0].options).toMatchObject({ webSearchEnabled: true, webSearchMode: 'live' })
    }
  })

  it('does NOT shut down a no-MCP run — web search stays live', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(startOpts({ webSearch: true }))
    expect(captured?.config?.features).toBeUndefined()
    expect(captured?.config?.tools).toBeUndefined()
    expect(calls[0].options).toMatchObject({ webSearchEnabled: true, webSearchMode: 'live' })
  })

  it('shuts down on the RELAY route without dropping the relay provider config', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const relay = {
      endpoint: () => 'http://127.0.0.1:3000/internal/relay/v1/codex',
      register: () => 'relay-token',
      unregister: () => {},
    }
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({
        relayCandidates: [
          {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-real',
            model: 'deepseek-chat',
            wireApi: 'chat',
          },
        ],
        mcpServers: intentServers,
        webSearch: true,
      }),
    )
    // Relay provider config survives the shutdown merge alongside the intent keys.
    expect(captured?.config?.model_provider).toBe('c3relay')
    expect(captured?.config?.features).toEqual({ js_repl: false })
    expect(captured?.config?.tools).toEqual({ web_search: false })
    expect(captured?.config?.mcp_servers).toBeDefined()
  })

  it('final CLI argv carries all three shutdown keys and no web_search="live"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-codex-intent-'))
    const fakeCodexBin = join(dir, 'codex')
    const argsFile = join(dir, 'args.txt')
    writeFileSync(
      fakeCodexBin,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > ${shQuote(argsFile)}`,
        'cat >/dev/null',
        'printf \'%s\\n\' \'{"type":"thread.started","thread_id":"thread_intent"}\'',
        'printf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\'',
      ].join('\n'),
    )
    chmodSync(fakeCodexBin, 0o755)
    try {
      const driver = new CodexDriver()
      const run = await driver.start(
        startOpts({ sandboxWrapperPath: fakeCodexBin, mcpServers: intentServers, webSearch: true }),
      )
      expect(await run.sessionId()).toBe('thread_intent')
      await collect(run.messages())
      const argv = readFileSync(argsFile, 'utf-8').split('\n').filter(Boolean)
      expect(argv).toContain('features.js_repl=false')
      expect(argv).toContain('tools.web_search=false')
      expect(argv).toContain('web_search="disabled"')
      expect(argv).not.toContain('web_search="live"')
      // The intent MCP server config is not lost to the shutdown merge.
      expect(argv).toContain(
        'mcp_servers.c3.url="http://127.0.0.1:3000/internal/intent-mcp/v1?token=t"',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CodexDriver provider routing — RELAY vs own-login (ADR-0029)', () => {
  /** A fake relay that records the candidate list it binds and mints a fixed token. */
  function fakeRelay() {
    const registered: RelayCandidate[][] = []
    const relay = {
      endpoint: (_vendor: 'claude' | 'codex') => 'http://127.0.0.1:3000/internal/relay/v1/codex',
      register(candidates: RelayCandidate[]) {
        registered.push(candidates)
        return 'relay-token-xyz'
      },
      unregister() {},
    }
    return { relay, registered }
  }

  it('relay candidates + relay ⇒ RELAY (token as apiKey, c3relay provider)', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay, registered } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({
        relayCandidates: [
          {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-real',
            model: 'deepseek-chat',
            wireApi: 'chat',
          },
        ],
      }),
    )
    // The REAL upstream candidate list is registered behind the token; codex only sees the token.
    expect(registered).toEqual([
      [
        {
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-real',
          model: 'deepseek-chat',
          wireApi: 'chat',
        },
      ],
    ])
    expect(captured?.apiKey).toBe('relay-token-xyz')
    expect(captured?.config?.model_provider).toBe('c3relay')
    // The raw provider URL never reaches the SDK as a baseUrl on the relay path.
    expect(captured?.baseUrl).toBeUndefined()
  })

  it('responses-native candidate still routes through the relay (passthrough)', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay, registered } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({
        relayCandidates: [
          {
            baseUrl: 'https://api.openai.com',
            apiKey: 'sk-real',
            model: 'gpt-5',
            wireApi: 'responses',
          },
        ],
      }),
    )
    // ADR-0029: all custom providers go through the relay (it passes `responses` through).
    expect(registered.length).toBe(1)
    expect(captured?.apiKey).toBe('relay-token-xyz')
    expect(captured?.config?.model_provider).toBe('c3relay')
    expect(captured?.baseUrl).toBeUndefined()
  })

  it('no relay candidates (system mode) ⇒ own login (no relay provider)', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay, registered } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(startOpts({}))
    expect(registered).toEqual([]) // never went through the relay
    expect(captured?.baseUrl).toBeUndefined()
    expect(captured?.config?.model_provider).toBeUndefined()
  })

  it('no relay present ⇒ own login even with candidates', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }) // no relay injected
    await driver.start(
      startOpts({
        relayCandidates: [
          {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-real',
            model: 'deepseek-chat',
            wireApi: 'chat',
          },
        ],
      }),
    )
    expect(captured?.baseUrl).toBeUndefined()
    expect(captured?.config?.model_provider).toBeUndefined()
  })
})

describe('CodexDriver sandbox wrapper wiring (arapuca)', () => {
  it('uses sandboxWrapperPath as the codex executable when supplied', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(startOpts({ sandboxWrapperPath: '/tmp/c3-sb-xyz/wrapper.sh' }))
    expect(captured?.codexPathOverride).toBe('/tmp/c3-sb-xyz/wrapper.sh')
    expect(calls[0]?.options).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'on-request',
    })
  })

  it('system-mode sandbox run keeps own login (no relay provider, no baseUrl)', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(startOpts({ sandboxWrapperPath: '/tmp/c3-sb-xyz/wrapper.sh' }))
    expect(captured?.codexPathOverride).toBe('/tmp/c3-sb-xyz/wrapper.sh')
    expect(captured?.baseUrl).toBeUndefined()
    expect(captured?.config?.model_provider).toBeUndefined()
  })

  it('layers own-login envOverrides onto the inherited process.env (CodexOptions.env replaces it)', async () => {
    const prev = process.env.PATH
    process.env.PATH = '/usr/bin:/bin'
    try {
      let captured: CodexFactoryOptions | undefined
      const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
      const driver = new CodexDriver((options) => {
        captured = options
        return client
      })
      // An injected GH_TOKEN (or any override) must NOT strip the inherited env:
      // CodexOptions.env replaces process.env, so the driver merges over it.
      await driver.start(startOpts({ envOverrides: { GH_TOKEN: 'bridged' } }))
      expect(captured?.env?.GH_TOKEN).toBe('bridged')
      expect(captured?.env?.PATH).toBe('/usr/bin:/bin')
    } finally {
      if (prev === undefined) delete process.env.PATH
      else process.env.PATH = prev
    }
  })
})

describe('CodexDriver RELAY route under an arapuca sandbox', () => {
  const RELAY_CODEX_ENDPOINT = 'http://127.0.0.1:3000/internal/relay/v1/codex'
  function fakeRelay() {
    const registered: RelayCandidate[][] = []
    const relay = {
      endpoint: (_vendor: 'claude' | 'codex') => RELAY_CODEX_ENDPOINT,
      register(candidates: RelayCandidate[]) {
        registered.push(candidates)
        return 'relay-token-xyz'
      },
      unregister() {},
    }
    return { relay, registered }
  }

  it('keeps the loopback base_url (same-path process reaches 127.0.0.1 directly) and needs no env-file', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay, registered } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({
        relayCandidates: [
          {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-real',
            model: 'deepseek-chat',
            wireApi: 'chat',
          },
        ],
        sandboxWrapperPath: '/tmp/c3-sb-xyz/wrapper.sh',
      }),
    )
    // The real upstream is registered behind the token; codex sees only the token
    // (delivered as CODEX_API_KEY via codexExecEnv, inherited by the arapuca child).
    expect(registered).toEqual([
      [
        {
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-real',
          model: 'deepseek-chat',
          wireApi: 'chat',
        },
      ],
    ])
    expect(captured?.apiKey).toBe('relay-token-xyz')
    const providers = captured?.config?.model_providers as
      Record<string, { base_url?: string }> | undefined
    // No host-gateway rewrite: the sandboxed process is on the host loopback.
    expect(providers?.c3relay?.base_url).toBe(RELAY_CODEX_ENDPOINT)
  })

  it('host (non-sandbox) RELAY keeps the loopback base_url', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({
        relayCandidates: [
          {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-real',
            model: 'deepseek-chat',
            wireApi: 'chat',
          },
        ],
      }),
    )
    const providers = captured?.config?.model_providers as
      Record<string, { base_url?: string }> | undefined
    const provider = providers?.c3relay
    expect(provider?.base_url).toBe(RELAY_CODEX_ENDPOINT)
  })
})

describe('CodexDriver custom-model catalog (2026-08-08-013)', () => {
  const RELAY_ENDPOINT = 'http://127.0.0.1:3000/internal/relay/v1/codex'
  const CANDIDATE: RelayCandidate = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-real',
    model: 'deepseek-v4-flash',
    wireApi: 'chat',
  }
  function fakeRelay() {
    const registered: RelayCandidate[][] = []
    const relay = {
      endpoint: (_vendor: 'claude' | 'codex') => RELAY_ENDPOINT,
      register(candidates: RelayCandidate[]) {
        registered.push(candidates)
        return 'relay-token-xyz'
      },
      unregister() {},
    }
    return { relay, registered }
  }

  it('relay + capability fields ⇒ model_catalog_json registers the CLI model id', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(
      startOpts({
        relayCandidates: [CANDIDATE],
        contextWindow: 65536,
        maxOutputTokens: 8192,
      }),
    )
    const catalog = captured?.config?.model_catalog_json as string | undefined
    expect(catalog).toBeDefined()
    // Host run: the per-run catalog lives under os.tmpdir().
    expect(catalog!.includes('c3-codex-catalog-')).toBe(true)
    // The relay provider routing is untouched by the catalog registration.
    expect(captured?.config?.model_provider).toBe('c3relay')
  })

  it('relay without capability fields ⇒ no model_catalog_json', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(startOpts({ relayCandidates: [CANDIDATE] }))
    expect(captured?.config?.model_catalog_json).toBeUndefined()
  })

  it('DIRECT route never registers a catalog, even when capability fields are passed', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    })
    await driver.start(startOpts({ contextWindow: 65536 }))
    // DIRECT (system mode) has no config at all — no catalog, no relay provider.
    expect(captured?.config).toBeUndefined()
    expect(captured?.config?.model_catalog_json).toBeUndefined()
  })

  it('sandboxed relay places the catalog inside sandboxTmpDir (the arapuca allow set)', async () => {
    const sandboxTmpDir = mkdtempSync(join(tmpdir(), 'c3-sb-cat-driver-'))
    try {
      let captured: CodexFactoryOptions | undefined
      const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
      const { relay } = fakeRelay()
      const driver = new CodexDriver((options) => {
        captured = options
        return client
      }, relay)
      await driver.start(
        startOpts({
          relayCandidates: [CANDIDATE],
          contextWindow: 65536,
          sandboxWrapperPath: join(sandboxTmpDir, 'wrapper.sh'),
          sandboxTmpDir,
        }),
      )
      const catalog = captured?.config?.model_catalog_json as string | undefined
      expect(catalog).toBeDefined()
      // Inside the allow set — a host temp path would be unreadable in arapuca.
      expect(catalog!.startsWith(sandboxTmpDir)).toBe(true)
      expect(catalog!.includes('model-catalog-')).toBe(true)
    } finally {
      rmSync(sandboxTmpDir, { recursive: true, force: true })
    }
  })

  it('sandboxed relay without sandboxTmpDir drops the catalog with a warning (never breaks the run)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let captured: CodexFactoryOptions | undefined
      const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
      const { relay } = fakeRelay()
      const driver = new CodexDriver((options) => {
        captured = options
        return client
      }, relay)
      await driver.start(
        startOpts({
          relayCandidates: [CANDIDATE],
          contextWindow: 65536,
          sandboxWrapperPath: '/tmp/c3-sb-cat-missing/wrapper.sh',
        }),
      )
      expect(captured?.config?.model_catalog_json).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('host relay (no wrapper) keeps the catalog on os.tmpdir()', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const { relay } = fakeRelay()
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, relay)
    await driver.start(startOpts({ relayCandidates: [CANDIDATE], contextWindow: 65536 }))
    const catalog = captured?.config?.model_catalog_json as string | undefined
    expect(catalog).toBeDefined()
    expect(catalog!.startsWith(tmpdir())).toBe(true)
  })
})

describe('gateToCodexPolicy', () => {
  it('preserves an exact workspace-write + never policy without widening it', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(() => client)
    await driver.start(
      startOpts({
        actionMode: 'build',
        toolGate: 'never-ask',
        vendorContext: { codexPolicy: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } },
      }),
    )
    expect(calls[0]?.options).toMatchObject({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
  })

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

  it('build + never-ask WITHOUT explicit authorization ⇒ workspace-write + never', () => {
    // "Stop asking" is not "no sandbox": a two-arg call (and an explicit false)
    // keeps the cell on workspace-write. This is the regression pin for the
    // silently-promoted-default bug.
    expect(gateToCodexPolicy('build', 'never-ask')).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
    expect(gateToCodexPolicy('build', 'never-ask', { explicitFullAccess: false })).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
  })

  it('build + never-ask with explicit authorization ⇒ danger-full-access (the ONLY such input)', () => {
    expect(gateToCodexPolicy('build', 'never-ask', { explicitFullAccess: true })).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    })
    // Authorization never widens any OTHER cell.
    expect(gateToCodexPolicy('build', 'on-sensitive', { explicitFullAccess: true })).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    })
    expect(gateToCodexPolicy('build', 'trusted-prefix', { explicitFullAccess: true })).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-failure',
    })
    expect(gateToCodexPolicy('build', 'always-ask', { explicitFullAccess: true })).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'on-request',
    })
    expect(gateToCodexPolicy('plan', 'never-ask', { explicitFullAccess: true })).toEqual({
      sandboxMode: 'read-only',
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

describe('convergeCodexPolicy (vendorContext is not a bypass)', () => {
  it('a stored danger-full-access WITH explicit authorization is adopted verbatim', () => {
    const out = convergeCodexPolicy({
      actionMode: 'build',
      toolGate: 'never-ask',
      explicitFullAccess: true,
      vendorContext: {
        codexPolicy: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      },
    })
    expect(out).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    })
  })

  it('a stored danger-full-access WITHOUT the marker falls back to the grid', () => {
    const out = convergeCodexPolicy({
      actionMode: 'build',
      toolGate: 'never-ask',
      // no explicitFullAccess
      vendorContext: {
        codexPolicy: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      },
    })
    expect(out).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
    // An explicit `false` is the same as absent — strictly true is the rule.
    expect(
      convergeCodexPolicy({
        actionMode: 'build',
        toolGate: 'never-ask',
        explicitFullAccess: false,
        vendorContext: {
          codexPolicy: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
        },
      }).sandboxMode,
    ).toBe('workspace-write')
  })

  it('in-boundary stored policies (read-only / workspace-write) are adopted unchanged', () => {
    for (const sandboxMode of ['read-only', 'workspace-write'] as const) {
      const out = convergeCodexPolicy({
        actionMode: 'build',
        toolGate: 'on-sensitive',
        vendorContext: {
          codexPolicy: { sandboxMode, approvalPolicy: 'on-request' },
        },
      })
      expect(out.sandboxMode).toBe(sandboxMode)
    }
  })

  it('an unauthorized widening loses; a narrowing is always honoured', () => {
    // `workspace-write` is a widening of a read-only grid and carries no
    // authorization, so it loses; the same stored value against a workspace-write
    // grid is adopted above. Narrowing in the other direction is never blocked.
    expect(
      convergeCodexPolicy({
        actionMode: 'plan',
        toolGate: 'on-sensitive',
        vendorContext: {
          codexPolicy: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
        },
      }),
    ).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'on-request' })
    expect(
      convergeCodexPolicy({
        actionMode: 'build',
        toolGate: 'on-sensitive',
        vendorContext: {
          codexPolicy: { sandboxMode: 'read-only', approvalPolicy: 'never' },
        },
      }),
    ).toEqual({ sandboxMode: 'read-only', approvalPolicy: 'never' })
  })

  it('an authorized full-access survives the lossy round-trip that produced its grid', () => {
    // A codex run's grid is derived from the SAME stored policy by the lossy
    // reverse map, which folds `danger-full-access` back onto the cell its
    // `approvalPolicy` names. Arbitrating the stored value against that grid would
    // silently discard the user's explicit choice — and this is the ordinary UI
    // path, because the title bar swaps `sandboxMode` while keeping the stored
    // `on-request` (the session default).
    for (const approvalPolicy of ['on-request', 'on-failure'] as const) {
      const policy = {
        sandboxMode: 'danger-full-access',
        approvalPolicy,
        explicitFullAccess: true,
      } as const
      const grid = codexPolicyToGrid(policy)
      expect(
        convergeCodexPolicy({
          actionMode: grid.actionMode,
          toolGate: grid.toolGate,
          explicitFullAccess: true,
          vendorContext: { codexPolicy: policy },
        }),
      ).toEqual({ sandboxMode: 'danger-full-access', approvalPolicy })
    }
    // The same stored value without the marker is an unauthorized widening and
    // still loses to the grid.
    expect(
      convergeCodexPolicy({
        actionMode: 'build',
        toolGate: 'on-sensitive',
        vendorContext: {
          codexPolicy: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' },
        },
      }),
    ).toEqual({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' })
  })

  it('with no vendor policy in the bag, the grid decides', () => {
    expect(convergeCodexPolicy({ actionMode: 'build', toolGate: 'never-ask' })).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
  })
})

describe('CodexDriver git-metadata compensation', () => {
  it('does not add the git dir when the probe finds no repository', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(
      (options) => {
        captured = options
        return client
      },
      undefined,
      async () => null,
    )
    await driver.start(
      startOpts({
        actionMode: 'build',
        toolGate: 'on-sensitive',
        additionalDirectories: ['/home/user/.c3/specs/project'],
      }),
    )
    expect(captured).toBeDefined()
    expect(calls[0]?.options?.additionalDirectories).toEqual(['/home/user/.c3/specs/project'])
  })

  it('threads the caller directories + the git dir into thread options', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver(
      () => client,
      undefined,
      async () => '/repo/main/.git',
    )
    await driver.start(
      startOpts({
        actionMode: 'build',
        toolGate: 'never-ask',
        additionalDirectories: ['/home/user/.c3/specs/project'],
      }),
    )
    expect(calls[0]?.options?.additionalDirectories).toEqual([
      '/home/user/.c3/specs/project',
      '/repo/main/.git',
    ])
  })

  it('does not widen a danger-full-access run with a git dir', async () => {
    const { client, calls } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    let probed = false
    const driver = new CodexDriver(
      () => client,
      undefined,
      async () => {
        probed = true
        return '/repo/main/.git'
      },
    )
    await driver.start(
      startOpts({ actionMode: 'build', toolGate: 'never-ask', explicitFullAccess: true }),
    )
    expect(calls[0]?.options?.sandboxMode).toBe('danger-full-access')
    expect(probed).toBe(false)
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

/**
 * Upstream response-stream resilience. The failure under test is the CLI's own
 * terminal verdict after its reconnect budget runs out
 * (`stream disconnected before completion … socket connection was closed
 * unexpectedly`), reached through an `error` event or a generator throw. Such a
 * round used to fail immediately and unattended — the one case where a transient
 * upstream fault cost a whole automation run. Codex-specific, so it stays here
 * rather than in the shared error classification.
 */
describe('isUpstreamStreamBreak', () => {
  it.each([
    [
      'the CLI truncated-stream verdict',
      'codex stream error: stream disconnected before completion',
    ],
    [
      'the wrapped transport cause',
      'upstream fetch failed: The socket connection was closed unexpectedly',
    ],
    ['the reconnect budget, counted down', 'Reconnecting... 1/5 then gave up'],
    ["c3's own truncation marker, bare", 'upstream stream ended before completion'],
    [
      "c3's own truncation marker, wrapped in the CLI's own sentence",
      'codex turn failed: upstream stream ended before completion',
    ],
    [
      "c3's own truncation marker, wrapped and punctuated",
      'ERROR stream error: Stream ended before completion: upstream stream ended before completion.',
    ],
  ])('recognizes %s', (_label, message) => {
    expect(isUpstreamStreamBreak(new Error(message))).toBe(true)
    expect(isUpstreamStreamBreak({ message })).toBe(true)
  })

  it.each([
    ['a tool failure', 'codex stream error: tool `bash` exited 1'],
    ['an auth rejection', 'codex stream error: 401 Unauthorized (invalid api key)'],
    ['an active-writer rejection', 'thread t already has an active writer'],
    ['an empty failure', ''],
  ])('does NOT misclassify %s', (_label, message) => {
    expect(isUpstreamStreamBreak(new Error(message))).toBe(false)
  })
})

describe('CodexDriver upstream stream-break recovery', () => {
  /** The CLI's terminal stream-error event, as it actually arrives. */
  const BREAK_EVENT = {
    type: 'error',
    message:
      'stream disconnected before completion: upstream fetch failed: The socket connection was closed unexpectedly',
  } as ThreadEvent

  /**
   * A client whose threads replay a different script per attempt, recording how
   * each was launched (fresh vs resumed) so the resume branch is observable.
   */
  function sequentialClient(
    scripts: ThreadEvent[][],
    threadIds: string[] = [],
  ): { client: CodexClient; calls: Array<{ kind: 'start' | 'resume'; id?: string }> } {
    const calls: Array<{ kind: 'start' | 'resume'; id?: string }> = []
    let index = 0
    const nextThread = (): CodexThread => {
      const script = scripts[Math.min(index, scripts.length - 1)]
      const id = threadIds[index] ?? `thread_${index}`
      index += 1
      return {
        id,
        runStreamed: async () => ({ events: scriptEvents(script) }),
        // The CLI exits 0 even when it abandons the stream — the misleading
        // signature this whole path exists to explain.
        lastChildOutcome: () => null,
      }
    }
    const client: CodexClient = {
      startThread: () => {
        calls.push({ kind: 'start' })
        return nextThread()
      },
      resumeThread: (id) => {
        calls.push({ kind: 'resume', id })
        return nextThread()
      },
    }
    return { client, calls }
  }

  it('retries once and succeeds when the first attempt breaks mid-stream', async () => {
    const { client, calls } = sequentialClient(
      [
        [
          { type: 'thread.started', thread_id: 'thread_a' },
          { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'partial' } },
          BREAK_EVENT,
        ],
        [
          { type: 'thread.started', thread_id: 'thread_b' },
          { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'complete' } },
          { type: 'turn.completed', usage: {} as never },
        ],
      ],
      ['thread_a', 'thread_b'],
    )
    const run = await new CodexDriver(() => client).start(startOpts())

    const msgs = await collect(run.messages())
    // The invariant is no DUPLICATE stacking, not "hide the broken attempt": text
    // the CLI already streamed before the break was genuinely produced and has
    // already been handed to the consumer, so it is kept — what must not happen is
    // the same item appearing twice, or the discarded attempt emitting into the
    // replacement queue after the swap.
    const texts = msgs.flatMap((m) => m.blocks.map((b) => (b as { text?: string }).text))
    expect(texts).toEqual(['partial', 'complete'])
    const ids = msgs.map((m) => (m.blocks[0] as { id?: string }).id)
    expect(ids).toEqual(['i0', 'i1'])
    expect(new Set(ids).size).toBe(ids.length) // no item delivered twice
    // The broken turn HAD announced its thread id, so the retry resumes that thread
    // to keep the context it had built.
    expect(calls).toEqual([{ kind: 'start' }, { kind: 'resume', id: 'thread_a' }])
  })

  it('lands failed with a readable attribution when the retry breaks too', async () => {
    const { client, calls } = sequentialClient([
      [{ type: 'thread.started', thread_id: 'thread_a' }, BREAK_EVENT],
    ])
    const run = await new CodexDriver(() => client).start(startOpts())

    await expect(collect(run.messages())).rejects.toThrow(
      /上游响应流在完成前中断.*已自动重试 1 次仍失败/s,
    )
    // Budget is one: the original attempt plus exactly one retry, then it stops.
    expect(calls).toHaveLength(2)
  })

  it('keeps the CLI outcome phrase as evidence beside the attribution', async () => {
    const calls: Array<{ kind: 'start' | 'resume'; id?: string }> = []
    let index = 0
    const thread = (): CodexThread => {
      index += 1
      return {
        id: 'thread_a',
        runStreamed: async () => ({ events: scriptEvents([BREAK_EVENT]) }),
        lastChildOutcome: () => ({ pid: 43210, exitCode: 0, signal: null }),
      }
    }
    const client: CodexClient = {
      startThread: () => {
        calls.push({ kind: 'start' })
        return thread()
      },
      resumeThread: (id) => {
        calls.push({ kind: 'resume', id })
        return thread()
      },
    }
    const run = await new CodexDriver(() => client).start(startOpts())

    await expect(collect(run.messages())).rejects.toThrow(
      /上游响应流在完成前中断[\s\S]*exited code=0/,
    )
  })

  it('starts fresh when the break precedes the thread id', async () => {
    const { client, calls } = sequentialClient([
      [BREAK_EVENT],
      [
        { type: 'thread.started', thread_id: 'thread_b' },
        { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'ok' } },
        { type: 'turn.completed', usage: {} as never },
      ],
    ])
    const run = await new CodexDriver(() => client).start(startOpts())

    expect(await collect(run.messages())).toHaveLength(1)
    // No id was ever announced, so there is nothing to resume — a clean restart.
    expect(calls).toEqual([{ kind: 'start' }, { kind: 'start' }])
  })

  it('recovers a generator-thrown break, not just an error event', async () => {
    let index = 0
    const client: CodexClient = {
      startThread: () => ({
        id: 'thread_a',
        runStreamed: async () => ({
          events: (async function* (): AsyncGenerator<ThreadEvent> {
            if (index++ === 0) {
              yield { type: 'thread.started', thread_id: 'thread_a' } as ThreadEvent
              throw new Error('upstream fetch failed: socket connection was closed unexpectedly')
            }
            yield {
              type: 'item.completed',
              item: { id: 'i1', type: 'agent_message', text: 'recovered' },
            } as ThreadEvent
            yield { type: 'turn.completed', usage: {} as never } as ThreadEvent
          })(),
        }),
      }),
      resumeThread: () => client.startThread(),
    }
    const run = await new CodexDriver(() => client).start(startOpts())

    const msgs = await collect(run.messages())
    expect(msgs[0].blocks).toMatchObject([{ type: 'text', text: 'recovered' }])
  })

  it('does NOT retry an ordinary failure (no budget spent on unrelated errors)', async () => {
    const { client, calls } = sequentialClient([
      [
        { type: 'thread.started', thread_id: 'thread_a' },
        { type: 'error', message: 'tool `bash` exited with code 1' } as ThreadEvent,
      ],
    ])
    const run = await new CodexDriver(() => client).start(startOpts())

    await expect(collect(run.messages())).rejects.toThrow(/exited with code 1/)
    expect(calls).toHaveLength(1)
  })

  it('does NOT retry when the run was aborted before the break', async () => {
    const controller = new AbortController()
    const { client, calls } = sequentialClient([
      [
        { type: 'thread.started', thread_id: 'thread_a' },
        (() => {
          controller.abort()
          return BREAK_EVENT
        })(),
      ],
    ])
    const run = await new CodexDriver(() => client).start(startOpts({ signal: controller.signal }))

    await collect(run.messages()).catch(() => undefined)
    // An abort is the user stopping the run; it outranks every classification.
    expect(calls).toHaveLength(1)
  })

  it('grants the retry budget to a FRESH round, not only to a resume', async () => {
    // The original bug: the budget was `opts.resume ? 1 : 0`, so a brand-new
    // automation run — the case in the report — had no recovery at all.
    const { client, calls } = sequentialClient([
      [{ type: 'thread.started', thread_id: 'thread_a' }, BREAK_EVENT],
      [
        { type: 'thread.started', thread_id: 'thread_b' },
        { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: {} as never },
      ],
    ])
    const run = await new CodexDriver(() => client).start(startOpts({ resume: undefined }))

    expect(await collect(run.messages())).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })
})

describe('CodexDriver relay provider stream tolerance', () => {
  /** A fake relay that records the candidate list it binds and mints a fixed token. */
  function fakeRelay() {
    const relay = {
      endpoint: () => 'http://127.0.0.1:3000/internal/relay/v1/codex',
      register: () => 'relay-token-xyz',
      unregister: () => {},
    }
    return relay
  }

  it('configures the CLI stream-retry knobs on the c3-constructed provider', async () => {
    let captured: CodexFactoryOptions | undefined
    const { client } = fakeCodex([{ type: 'thread.started', thread_id: 't' }])
    const driver = new CodexDriver((options) => {
      captured = options
      return client
    }, fakeRelay())
    await driver.start(
      startOpts({
        relayCandidates: [
          {
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk',
            model: 'deepseek-chat',
            wireApi: 'chat',
          },
        ],
      }),
    )
    const provider = captured?.config?.model_providers as Record<string, Record<string, unknown>>
    const entry = provider.c3relay
    // Each is a field of the CLI's own ModelProviderInfo (verified against the
    // shipped 0.159.2 binary); integers, because the CLI parses them as numbers.
    expect(entry.request_max_retries).toBe(6)
    expect(entry.stream_max_retries).toBe(8)
    expect(entry.stream_idle_timeout_ms).toBe(300_000)
    for (const key of ['request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms']) {
      expect(Number.isInteger(entry[key])).toBe(true)
    }
    // The websocket timeout is irrelevant on a route that forces plain HTTP+SSE.
    expect(entry.websocket_connect_timeout_ms).toBeUndefined()
    expect(entry.supports_websockets).toBe(false)
  })
})
