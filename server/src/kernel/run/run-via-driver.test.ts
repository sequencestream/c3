/**
 * WireEmitter — the canonical(upsert) → wire(claude-incremental)
 * diff that lets the existing web console render driver-path turns. Text emits only
 * new suffixes; a tool_use emits once, its result once, no duplicates on re-emit.
 */
import { describe, expect, it, vi } from 'vitest'

// Stub the codex gh-token bridge so tests never spawn a real `gh auth token`. The
// default is a passthrough (overrides unchanged); the link test overrides it once
// to inject a token and assert it reaches driver.start.
const ghBridge = vi.hoisted(() => ({
  fn: vi.fn((o?: Record<string, string>) => Promise.resolve(o)),
}))
vi.mock('../agent/adapters/codex/gh-token.js', () => ({
  resolveCodexGhTokenEnv: (o?: Record<string, string>) => ghBridge.fn(o),
}))

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { CanonicalBlock, CanonicalMessage, VendorAdapter } from '../agent/adapters/types.js'
import type { EventBus, EventBusEvents } from '../events/event-bus.js'
import {
  WireEmitter,
  intentDriverModeForVendor,
  makeDriverApprovalHandler,
  runViaDriver,
  specDriverModeForVendor,
} from './run-via-driver.js'
import { addViewer, ensureRuntime, removeRuntime, type Viewer } from '../../runs.js'
import { getSpecsBase } from '../config/workspace-path.js'

function frame(blocks: CanonicalBlock[], extra?: Partial<CanonicalMessage>): CanonicalMessage {
  return { vendor: 'codex', sessionId: 's', role: 'assistant', blocks, ts: 0, ...extra }
}

describe('WireEmitter', () => {
  it('emits only the new suffix of a growing text block', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    e.consume(frame([{ type: 'text', text: 'Hel', id: 't1' }]))
    e.consume(frame([{ type: 'text', text: 'Hello', id: 't1' }]))
    expect(out).toEqual([
      { type: 'assistant_text', text: 'Hel' },
      { type: 'assistant_text', text: 'lo' },
    ])
  })

  it('emits a tool_use once and its result once, ignoring re-emits', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    const running: CanonicalBlock = {
      type: 'tool_use',
      id: 'c1',
      name: 'bash',
      input: { cmd: 'ls' },
    }
    const done: CanonicalBlock = {
      type: 'tool_use',
      id: 'c1',
      name: 'bash',
      input: { cmd: 'ls' },
      result: { content: 'ok', isError: false },
    }
    e.consume(frame([running]))
    e.consume(frame([done]))
    e.consume(frame([done])) // idempotent re-emit

    expect(out).toEqual([
      { type: 'tool_use', toolUseId: 'c1', toolName: 'bash', input: { cmd: 'ls' } },
      { type: 'tool_result', toolUseId: 'c1', content: 'ok', isError: false },
    ])
  })

  it('carries a message-level preApproved marker onto the first tool_use frame', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    const tool: CanonicalBlock = { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }
    e.consume(frame([tool], { preApproved: true }))
    expect(out).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'c1',
        toolName: 'bash',
        input: { cmd: 'ls' },
        preApproved: true,
      },
    ])
  })

  it('omits preApproved on a gated (non-pre-approved) tool_use', () => {
    const out: ServerToClient[] = []
    const e = new WireEmitter((m) => out.push(m))
    const tool: CanonicalBlock = { type: 'tool_use', id: 'c1', name: 'bash', input: { cmd: 'ls' } }
    e.consume(frame([tool]))
    expect(out).toEqual([
      { type: 'tool_use', toolUseId: 'c1', toolName: 'bash', input: { cmd: 'ls' } },
    ])
    expect(out[0]).not.toHaveProperty('preApproved')
  })
})

describe('intentDriverModeForVendor', () => {
  it('lets Codex use read-only MCP tools without a non-existent live approval channel', () => {
    expect(intentDriverModeForVendor('codex')).toEqual({
      actionMode: 'plan',
      toolGate: 'never-ask',
    })
  })
})

describe('specDriverModeForVendor', () => {
  it('forces Codex spec authoring to workspace-write without a live approval channel', () => {
    expect(specDriverModeForVendor('codex')).toEqual({
      actionMode: 'build',
      toolGate: 'never-ask',
    })
  })
})

describe('makeDriverApprovalHandler — WorkCenter event registration', () => {
  function deps(over: Partial<Parameters<typeof makeDriverApprovalHandler>[0]> = {}) {
    return {
      getRunId: () => 'run-1',
      workspacePath: '/proj',
      sessionKind: 'work' as const,
      signal: new AbortController().signal,
      emit: vi.fn(),
      waitForDecision: vi.fn(async () => ({ decision: 'allow' as const })),
      onPermissionRequest: vi.fn(),
      ...over,
    }
  }

  it('registers the event BEFORE the wire frame, with the runtime sessionKind + live run id', async () => {
    const order: string[] = []
    const d = deps({
      sessionKind: 'intent',
      getRunId: () => 'run-9',
      workspacePath: '/w',
      emit: vi.fn(() => order.push('emit')),
      onPermissionRequest: vi.fn(() => order.push('hook')),
    })
    const handler = makeDriverApprovalHandler(d)
    const decision = await handler({
      requestId: 'r1',
      toolName: 'Write',
      input: { file_path: '/x' },
    })

    expect(d.onPermissionRequest).toHaveBeenCalledWith({
      requestId: 'r1',
      toolName: 'Write',
      input: { file_path: '/x' },
      sessionId: 'run-9',
      workspacePath: '/w',
      sessionKind: 'intent',
    })
    expect(order).toEqual(['hook', 'emit'])
    expect(d.emit).toHaveBeenCalledWith('run-9', {
      type: 'permission_request',
      requestId: 'r1',
      toolName: 'Write',
      input: { file_path: '/x' },
    })
    expect(decision).toEqual({ behavior: 'allow' })
  })

  it('tags an interaction tool frame with isUserInteraction', async () => {
    const d = deps()
    const handler = makeDriverApprovalHandler(d)
    await handler({ requestId: 'r2', toolName: 'AskUserQuestion', input: {} })
    expect(d.emit).toHaveBeenCalledWith('run-1', {
      type: 'permission_request',
      requestId: 'r2',
      toolName: 'AskUserQuestion',
      input: {},
      isUserInteraction: true,
    })
  })

  it('maps a deny decision to a default-deny ApprovalDecision', async () => {
    const d = deps({ waitForDecision: vi.fn(async () => ({ decision: 'deny' as const })) })
    const handler = makeDriverApprovalHandler(d)
    const decision = await handler({ requestId: 'r3', toolName: 'Bash', input: {} })
    expect(decision).toEqual({ behavior: 'deny', reason: 'User denied in c3 UI' })
  })

  it('is a no-op-safe registration when onPermissionRequest is absent', async () => {
    const d = deps({ onPermissionRequest: undefined })
    const handler = makeDriverApprovalHandler(d)
    const decision = await handler({ requestId: 'r4', toolName: 'Read', input: {} })
    expect(decision).toEqual({ behavior: 'allow' })
    expect(d.emit).toHaveBeenCalledTimes(1)
  })
})

describe('runViaDriver — codex delivery split (hide-session-system-instructions)', () => {
  // A fake codex adapter that captures the driver prompt and yields no messages, so
  // we can assert what reaches the MODEL vs what the client sees echoed.
  function fakeCodexAdapter(): {
    adapter: VendorAdapter
    started: { prompt?: string; systemInstruction?: string }
  } {
    const started: { prompt?: string; systemInstruction?: string } = {}
    const adapter = {
      vendor: 'codex',
      approval: { onRequest: () => () => {} },
      driver: {
        start: (opts: { prompt: string; systemInstruction?: string }) => {
          started.prompt = opts.prompt
          started.systemInstruction = opts.systemInstruction
          return Promise.resolve({
            sessionId: () => Promise.resolve(sid),
            // eslint-disable-next-line require-yield
            messages: async function* () {
              return
            },
          })
        },
      },
    } as unknown as VendorAdapter
    return { adapter, started }
  }

  // A real native id (not a pending prefix) so sessionId() === runId ⇒ no pending
  // bind / agent freeze (keeps the test free of config/DB wiring).
  const sid = 'codex-native-1'
  const eventBus = { publish: () => {} } as unknown as EventBus<EventBusEvents>

  it('delivers the SDD instruct on the system channel + the slash-command dev skill on the user turn; echoes the visible body alone', async () => {
    const rt = ensureRuntime(sid, '/proj', 'default', [], 'work')
    const frames: ServerToClient[] = []
    const viewer: Viewer = (e) => frames.push(e)
    addViewer(sid, viewer)

    const SDD = 'You are a spec-driven development agent. Hard constraints: Spec is Truth.'
    const VISIBLE = 'Cache the endpoint\n\nAdd an LRU cache.'
    const { adapter, started } = fakeCodexAdapter()

    await runViaDriver(rt, VISIBLE, adapter, eventBus, undefined, undefined, undefined, {
      systemInstruction: SDD,
      userTurnPrefix: '/dev ',
    })

    // The system instruction rides the driver's dedicated systemInstruction channel;
    // the model user turn carries only the slash command + the visible body.
    expect(started.systemInstruction).toBe(SDD)
    expect(started.prompt).toBe(`/dev ${VISIBLE}`)
    expect(started.prompt).not.toContain('Hard constraints')

    // The client echo (user_text) is the visible body ALONE — no instruction, no prefix.
    const echoed = frames.filter((e) => e.type === 'user_text')
    expect(echoed).toHaveLength(1)
    const echo = echoed[0]
    expect(echo).toEqual({ type: 'user_text', text: VISIBLE })
    // The echoed text never carries the internal instruction or the slash command.
    const text = echo.type === 'user_text' ? echo.text : ''
    expect(text).not.toContain('Hard constraints')
    expect(text).not.toContain('/dev')

    removeRuntime(sid)
  })
})

describe('runViaDriver — work-session base MCP injection (publish_pr_event, codex)', () => {
  const sid = 'codex-native-pr'
  const eventBus = { publish: () => {} } as unknown as EventBus<EventBusEvents>

  function fakeCodexAdapter(): {
    adapter: VendorAdapter
    started: { mcpServers?: Record<string, unknown> }
  } {
    const started: { mcpServers?: Record<string, unknown> } = {}
    const adapter = {
      vendor: 'codex',
      approval: { onRequest: () => () => {} },
      driver: {
        start: (opts: { mcpServers?: Record<string, unknown> }) => {
          started.mcpServers = opts.mcpServers
          return Promise.resolve({
            sessionId: () => Promise.resolve(sid),
            // eslint-disable-next-line require-yield
            messages: async function* () {
              return
            },
          })
        },
      },
    } as unknown as VendorAdapter
    return { adapter, started }
  }

  it('binds the session profile driver MCP and threads its servers to driver.start', async () => {
    const rt = ensureRuntime(sid, '/proj', 'default', [], 'work')
    const viewer: Viewer = () => {}
    addViewer(sid, viewer)

    const dispose = vi.fn()
    const servers = {
      c3: { type: 'http' as const, url: 'http://127.0.0.1/internal/pr-event-mcp/v1?token=t' },
    }
    const bindDriverMcp = vi.fn(() => ({ servers, dispose }))
    const { adapter, started } = fakeCodexAdapter()

    await runViaDriver(rt, 'hi', adapter, eventBus, undefined, undefined, undefined, undefined, {
      bindInProcessMcp: () => ({}),
      bindDriverMcp,
    })

    expect(bindDriverMcp).toHaveBeenCalledTimes(1)
    expect(started.mcpServers).toEqual(servers)
    // The per-run binding is evicted at run end.
    expect(dispose).toHaveBeenCalledTimes(1)

    removeRuntime(sid)
  })
})

describe('runViaDriver — Codex specs writable root', () => {
  it('derives and injects only the owning workspace specs root', async () => {
    const sid = 'codex-specs-root'
    const workspacePath = '/projects/owner/repository'
    const rt = ensureRuntime(sid, workspacePath, 'default', [], 'work')
    const eventBus = { publish: () => {} } as unknown as EventBus<EventBusEvents>
    const started: { additionalDirectories?: string[] } = {}
    const adapter = {
      vendor: 'codex',
      approval: { onRequest: () => () => {} },
      driver: {
        start: (opts: { additionalDirectories?: string[] }) => {
          started.additionalDirectories = opts.additionalDirectories
          return Promise.resolve({
            sessionId: () => Promise.resolve(sid),
            // eslint-disable-next-line require-yield
            messages: async function* () {
              return
            },
          })
        },
      },
    } as unknown as VendorAdapter

    await runViaDriver(rt, 'hi', adapter, eventBus)

    expect(started.additionalDirectories).toEqual([getSpecsBase(workspacePath)])
    removeRuntime(sid)
  })

  it('moves Codex spec cwd to the specs root and binds read-only spec MCP', async () => {
    const prevC3Dir = process.env.C3_DIR
    const tmpC3 = mkdtempSync(join(tmpdir(), 'c3-run-driver-spec-'))
    const sid = 'codex-spec-session'
    try {
      process.env.C3_DIR = tmpC3
      const workspacePath = '/projects/owner/repository'
      const rt = ensureRuntime(sid, workspacePath, 'default', [], 'spec')
      rt.specDir = `${getSpecsBase(workspacePath)}/2026/06/27/spec`
      const eventBus = { publish: () => {} } as unknown as EventBus<EventBusEvents>
      const started: {
        cwd?: string
        actionMode?: string
        toolGate?: string
        additionalDirectories?: string[]
        mcpServers?: Record<string, unknown>
        prompt?: string
        systemInstruction?: string
      } = {}
      const adapter = {
        vendor: 'codex',
        approval: { onRequest: () => () => {} },
        driver: {
          start: (opts: {
            cwd?: string
            actionMode?: string
            toolGate?: string
            additionalDirectories?: string[]
            mcpServers?: Record<string, unknown>
            prompt?: string
            systemInstruction?: string
          }) => {
            Object.assign(started, opts)
            return Promise.resolve({
              sessionId: () => Promise.resolve(sid),
              // eslint-disable-next-line require-yield
              messages: async function* () {
                return
              },
            })
          },
        },
      } as unknown as VendorAdapter
      const dispose = vi.fn()
      const servers = {
        c3: {
          type: 'http' as const,
          url: 'http://127.0.0.1/internal/spec-query-mcp/v1?token=t',
          enabledTools: ['find_intents', 'view_intent'],
        },
      }

      await runViaDriver(
        rt,
        'write spec',
        adapter,
        eventBus,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          appendSystemPrompt: 'SPEC SYSTEM',
          disallowedTools: [],
          gate: 'spec',
          bindDriverMcp: () => ({ servers, dispose }),
        },
      )

      expect(started.cwd).toBe(getSpecsBase(workspacePath))
      expect(started.additionalDirectories).toEqual([getSpecsBase(workspacePath)])
      expect(started.actionMode).toBe('build')
      expect(started.toolGate).toBe('never-ask')
      expect(started.mcpServers).toEqual(servers)
      // The spec-authoring contract rides the system channel; the user turn is the
      // visible body alone.
      expect(started.systemInstruction).toBe('SPEC SYSTEM')
      expect(started.prompt).toBe('write spec')
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      removeRuntime(sid)
      if (prevC3Dir === undefined) delete process.env.C3_DIR
      else process.env.C3_DIR = prevC3Dir
      rmSync(tmpC3, { recursive: true, force: true })
    }
  })
})

describe('runViaDriver — gh token bridge', () => {
  function captureAdapter(
    vendor: 'codex' | 'claude',
    sid: string,
    started: { envOverrides?: Record<string, string> },
  ): VendorAdapter {
    return {
      vendor,
      approval: { onRequest: () => () => {} },
      driver: {
        start: (opts: { envOverrides?: Record<string, string> }) => {
          started.envOverrides = opts.envOverrides
          return Promise.resolve({
            sessionId: () => Promise.resolve(sid),
            // eslint-disable-next-line require-yield
            messages: async function* () {
              return
            },
          })
        },
      },
    } as unknown as VendorAdapter
  }

  it('resolves the host gh credential and threads the injected envOverrides into a codex driver.start', async () => {
    ghBridge.fn.mockClear()
    ghBridge.fn.mockImplementationOnce((o?: Record<string, string>) =>
      Promise.resolve({ ...(o ?? {}), GH_TOKEN: 'bridged' }),
    )
    const sid = 'codex-gh-bridge'
    const rt = ensureRuntime(sid, '/projects/x', 'default', [], 'work')
    const eventBus = { publish: () => {} } as unknown as EventBus<EventBusEvents>
    const started: { envOverrides?: Record<string, string> } = {}

    await runViaDriver(rt, 'hi', captureAdapter('codex', sid, started), eventBus)

    expect(ghBridge.fn).toHaveBeenCalledTimes(1)
    // The bridge's resolved result — whatever launch overrides it received, plus the
    // appended token — is what the codex driver must receive.
    expect(started.envOverrides).toMatchObject({ GH_TOKEN: 'bridged' })
    removeRuntime(sid)
  })

  it('does not probe for a claude session (no seatbelt boundary)', async () => {
    ghBridge.fn.mockClear()
    const sid = 'claude-no-gh-bridge'
    const rt = ensureRuntime(sid, '/projects/y', 'default', [], 'work')
    const eventBus = { publish: () => {} } as unknown as EventBus<EventBusEvents>
    const started: { envOverrides?: Record<string, string> } = {}

    await runViaDriver(rt, 'hi', captureAdapter('claude', sid, started), eventBus)

    expect(ghBridge.fn).not.toHaveBeenCalled()
    removeRuntime(sid)
  })
})
