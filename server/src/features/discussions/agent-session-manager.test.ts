/**
 * Unit tests for {@link AgentSessionManager}: session lifecycle (create, resume,
 * degradation), close, error handling, and text collection.
 */

import { describe, expect, it } from 'vitest'
import type { AgentConfig, VendorId } from '@ccc/shared/protocol'
import type {
  AgentDriver,
  AgentRun,
  CanonicalMessage,
  CanonicalBlock,
  VendorAdapter,
} from '../../kernel/agent/adapters/types.js'
import type { AgentSessionRow } from './store.js'
import {
  AgentSessionManager,
  type AgentSessionStore,
  type DiscussionSessionProjection,
} from './agent-session-manager.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A canonical message factory. */
const msg = (over: Partial<CanonicalMessage> & { blocks: CanonicalBlock[] }): CanonicalMessage => ({
  vendor: 'claude',
  sessionId: 's-test',
  role: 'assistant',
  ts: Date.now(),
  ...over,
})

/** A text block. */
const textBlock = (text: string): CanonicalBlock & { type: 'text' } => ({
  type: 'text',
  text,
})

/** A canonical queue that yields scripted messages then ends. */
class FakeRun implements AgentRun {
  private sid: string

  constructor(
    sid: string,
    private readonly items: CanonicalMessage[],
  ) {
    this.sid = sid
  }

  sessionId(): Promise<string> {
    return Promise.resolve(this.sid)
  }

  async *messages(): AsyncIterable<CanonicalMessage> {
    for (const item of this.items) {
      yield item
    }
  }

  abort(): void {}
}

/** A fake driver with configurable start behavior. */
class FakeDriver implements AgentDriver {
  readonly vendor: VendorId
  readonly capabilities = {
    interrupt: false,
    setActionMode: false,
    streamingPush: true,
    inProcessMcp: false,
    forkSession: false,
    perToolApproval: false,
    taskStore: false,
    nativeUserInput: false,
    sessions: {
      list: 'full' as const,
      read: 'full' as const,
      resume: 'full' as const,
      rename: 'full' as const,
      delete: 'full' as const,
    },
  }

  /** The start calls this driver has received. */
  startCalls: Array<{
    prompt: string
    cwd: string
    resume: string | undefined
    contextWindow?: number
    maxOutputTokens?: number
  }> = []

  private readonly resolveRun: (opts: { prompt: string; cwd: string; resume?: string }) => {
    run: AgentRun
    sessionId: string
  }

  constructor(
    vendor: VendorId,
    resolveRun: (opts: { prompt: string; cwd: string; resume?: string }) => {
      run: AgentRun
      sessionId: string
    },
  ) {
    this.vendor = vendor
    this.resolveRun = resolveRun
  }

  async start(opts: {
    prompt: string
    cwd: string
    signal: AbortSignal
    actionMode: string
    toolGate: string
    resume?: string
    model?: string
    envOverrides?: Record<string, string>
    relayCandidates?: unknown
    contextWindow?: number
    maxOutputTokens?: number
  }): Promise<AgentRun> {
    this.startCalls.push({
      prompt: opts.prompt,
      cwd: opts.cwd,
      resume: opts.resume,
      ...(opts.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    })
    const result = this.resolveRun({
      prompt: opts.prompt,
      cwd: opts.cwd,
      resume: opts.resume,
    })
    return result.run
  }
}

// ---------------------------------------------------------------------------
// Mutable in-memory store (fake)
// ---------------------------------------------------------------------------

function createFakeStore(): {
  store: AgentSessionStore
  rows: Map<string, AgentSessionRow>
} {
  const rows = new Map<string, AgentSessionRow>()
  const key = (discussionId: string, agentId: string) => `${discussionId}::${agentId}`

  return {
    rows,
    store: {
      getAgentSession(discussionId: string, agentId: string): AgentSessionRow | null {
        return rows.get(key(discussionId, agentId)) ?? null
      },
      setAgentSession(
        discussionId: string,
        agentId: string,
        sessionId: string,
        vendor?: string,
        lastSeq?: number,
      ): void {
        const k = key(discussionId, agentId)
        const existing = rows.get(k)
        rows.set(k, {
          discussionId,
          agentId,
          sessionId,
          vendor: vendor ?? '',
          lastSeq: lastSeq ?? (existing ? existing.lastSeq : 0),
          createdAt: existing?.createdAt ?? Date.now(),
        })
      },
      deleteAgentSession(discussionId: string, agentId: string): void {
        rows.delete(key(discussionId, agentId))
      },
      deleteAllByDiscussion(discussionId: string): void {
        for (const k of rows.keys()) {
          if (k.startsWith(`${discussionId}::`)) rows.delete(k)
        }
      },
    },
  }
}

function createFakeProjection(): {
  projection: DiscussionSessionProjection
  upserts: Array<Parameters<DiscussionSessionProjection['upsert']>[0]>
  deletes: Array<Parameters<DiscussionSessionProjection['delete']>[0]>
  deleteAlls: string[]
} {
  const upserts: Array<Parameters<DiscussionSessionProjection['upsert']>[0]> = []
  const deletes: Array<Parameters<DiscussionSessionProjection['delete']>[0]> = []
  const deleteAlls: string[] = []
  return {
    upserts,
    deletes,
    deleteAlls,
    projection: {
      upsert: (input) => upserts.push(input),
      delete: (input) => deletes.push(input),
      deleteAll: (discussionId) => deleteAlls.push(discussionId),
    },
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

const claudeAgent: AgentConfig = {
  id: 'agent-a',
  vendor: 'claude',
  configMode: 'system',
  displayName: 'Agent A',
  enabled: true,
  config: { baseUrl: '', apiKey: '', model: '' },
  icon: 'agent',
}

const codexAgent: AgentConfig = {
  ...claudeAgent,
  id: 'agent-b',
  vendor: 'codex',
  config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
  displayName: 'Agent B',
}

const cursorAgent: AgentConfig = {
  id: 'agent-c',
  vendor: 'cursor',
  configMode: 'system',
  displayName: 'Agent C',
  enabled: true,
  config: { apiKey: '', model: '' },
  icon: 'agent',
}

describe('AgentSessionManager', () => {
  // ── First call: create new session ──────────────────────────────────────
  describe('first call (no prior session)', () => {
    it('creates a new vendor session and persists the mapping', async () => {
      const { store, rows } = createFakeStore()
      const { projection, upserts } = createFakeProjection()
      const driver = new FakeDriver('claude', () => ({
        run: new FakeRun('session-new', [msg({ blocks: [textBlock('Hello from agent')] })]),
        sessionId: 'session-new',
      }))
      const adapter: VendorAdapter = {
        vendor: 'claude',
        capabilities: driver.capabilities,
        driver,
        approval: { onRequest: () => () => {} },
        sessions: { list: async () => [], read: async () => [] },
        skill: null!,
        listTools: () => [],
      }

      const mgr = new AgentSessionManager({
        getAdapter: (v) => (v === 'claude' ? adapter : (undefined as unknown as VendorAdapter)),
        store,
        projection,
      })

      const result = await mgr.ask(
        'disc-1',
        claudeAgent,
        'First turn prompt',
        '/cwd',
        new AbortController().signal,
      )

      expect(result).toBe('Hello from agent')
      // Driver received the call without resume
      expect(driver.startCalls).toHaveLength(1)
      expect(driver.startCalls[0].resume).toBeUndefined()
      expect(driver.startCalls[0].prompt).toBe('First turn prompt')

      // Mapping was persisted
      expect(rows.size).toBe(1)
      const row = rows.get('disc-1::agent-a')!
      expect(row.sessionId).toBe('session-new')
      expect(row.vendor).toBe('claude')
      expect(row.lastSeq).toBe(0)
      expect(upserts).toEqual([
        {
          discussionId: 'disc-1',
          workspacePath: '/cwd',
          agent: claudeAgent,
          sessionId: 'session-new',
          vendor: 'claude',
        },
      ])
    })
  })

  // ── Second call: resume ─────────────────────────────────────────────────
  describe('second call (resume existing session)', () => {
    it('resumes the stored session WITHOUT touching lastSeq (orchestrator owns it)', async () => {
      const { store, rows } = createFakeStore()
      const { projection, deletes, upserts } = createFakeProjection()

      // Pre-populate a stored session
      rows.set('disc-1::agent-a', {
        discussionId: 'disc-1',
        agentId: 'agent-a',
        sessionId: 'session-existing',
        vendor: 'claude',
        lastSeq: 3,
        createdAt: Date.now(),
      })

      const driver = new FakeDriver('claude', ({ resume }) => {
        // The driver receives resume=session-existing
        expect(resume).toBe('session-existing')
        return {
          run: new FakeRun('session-existing', [msg({ blocks: [textBlock('Resumed reply')] })]),
          sessionId: 'session-existing',
        }
      })
      const adapter: VendorAdapter = {
        vendor: 'claude',
        capabilities: driver.capabilities,
        driver,
        approval: { onRequest: () => () => {} },
        sessions: { list: async () => [], read: async () => [] },
        skill: null!,
        listTools: () => [],
      }

      const mgr = new AgentSessionManager({
        getAdapter: (v) => (v === 'claude' ? adapter : (undefined as unknown as VendorAdapter)),
        store,
        projection,
      })

      const result = await mgr.ask(
        'disc-1',
        claudeAgent,
        'Second turn',
        '/cwd',
        new AbortController().signal,
      )

      expect(result).toBe('Resumed reply')
      expect(driver.startCalls).toHaveLength(1)
      expect(driver.startCalls[0].resume).toBe('session-existing')
      expect(driver.startCalls[0].prompt).toBe('Second turn')

      // lastSeq is NOT a turn counter — resume leaves it untouched (the
      // orchestrator advances it via setLastSeq to the consumed message seq).
      const row = rows.get('disc-1::agent-a')!
      expect(row.lastSeq).toBe(3)
      expect(row.sessionId).toBe('session-existing')
      expect(deletes).toEqual([])
      expect(upserts).toEqual([])
    })
  })

  // ── Resume failure → degradation ────────────────────────────────────────
  describe('resume failure degradation', () => {
    it('falls back to a new session when resume throws', async () => {
      const { store, rows } = createFakeStore()
      const { projection, deletes, upserts } = createFakeProjection()

      // Pre-populate a stale session
      rows.set('disc-1::agent-a', {
        discussionId: 'disc-1',
        agentId: 'agent-a',
        sessionId: 'session-stale',
        vendor: 'claude',
        lastSeq: 1,
        createdAt: Date.now(),
      })

      let callCount = 0
      const driver = new FakeDriver('claude', () => {
        callCount++
        if (callCount === 1) {
          // First call (resume) throws
          throw new Error('session expired')
        }
        // Second call (fallback) succeeds
        return {
          run: new FakeRun('session-fresh', [msg({ blocks: [textBlock('Fallback reply')] })]),
          sessionId: 'session-fresh',
        }
      })
      const adapter: VendorAdapter = {
        vendor: 'claude',
        capabilities: driver.capabilities,
        driver,
        approval: { onRequest: () => () => {} },
        sessions: { list: async () => [], read: async () => [] },
        skill: null!,
        listTools: () => [],
      }

      const mgr = new AgentSessionManager({
        getAdapter: (v) => (v === 'claude' ? adapter : (undefined as unknown as VendorAdapter)),
        store,
        projection,
      })

      const result = await mgr.ask(
        'disc-1',
        claudeAgent,
        'Turn prompt',
        '/cwd',
        new AbortController().signal,
      )

      expect(result).toBe('Fallback reply')
      // Driver called twice: resume (throws) → create-new
      expect(driver.startCalls).toHaveLength(2)
      expect(driver.startCalls[0].resume).toBe('session-stale')
      expect(driver.startCalls[1].resume).toBeUndefined()

      // Stale entry was deleted, new one was created
      const row = rows.get('disc-1::agent-a')!
      expect(row.sessionId).toBe('session-fresh')
      expect(row.lastSeq).toBe(0)
      expect(deletes).toEqual([
        {
          discussionId: 'disc-1',
          agentId: 'agent-a',
          sessionId: 'session-stale',
          vendor: 'claude',
        },
      ])
      expect(upserts.map((u) => u.sessionId)).toEqual(['session-fresh'])
    })
  })

  // ── closeSession / closeAll ─────────────────────────────────────────────
  describe('closeSession / closeAll', () => {
    it('closeSession deletes one agent mapping', () => {
      const { store, rows } = createFakeStore()
      const { projection, deletes } = createFakeProjection()
      rows.set('disc-1::agent-a', {
        discussionId: 'disc-1',
        agentId: 'agent-a',
        sessionId: 's1',
        vendor: 'claude',
        lastSeq: 1,
        createdAt: Date.now(),
      })
      rows.set('disc-1::agent-b', {
        discussionId: 'disc-1',
        agentId: 'agent-b',
        sessionId: 's2',
        vendor: 'codex',
        lastSeq: 1,
        createdAt: Date.now(),
      })

      const mgr = new AgentSessionManager({
        getAdapter: () => undefined as unknown as VendorAdapter,
        store,
        projection,
      })

      mgr.closeSession('disc-1', 'agent-a')
      expect(rows.has('disc-1::agent-a')).toBe(false)
      // Other agent's mapping untouched
      expect(rows.has('disc-1::agent-b')).toBe(true)
      expect(deletes).toEqual([
        { discussionId: 'disc-1', agentId: 'agent-a', sessionId: 's1', vendor: 'claude' },
      ])
    })

    it('closeAll deletes all agent mappings for a discussion', () => {
      const { store, rows } = createFakeStore()
      const { projection, deleteAlls } = createFakeProjection()
      rows.set('disc-1::agent-a', {
        discussionId: 'disc-1',
        agentId: 'agent-a',
        sessionId: 's1',
        vendor: 'claude',
        lastSeq: 1,
        createdAt: Date.now(),
      })
      rows.set('disc-1::agent-b', {
        discussionId: 'disc-1',
        agentId: 'agent-b',
        sessionId: 's2',
        vendor: 'codex',
        lastSeq: 1,
        createdAt: Date.now(),
      })
      // Another discussion's mapping is NOT touched
      rows.set('disc-2::agent-a', {
        discussionId: 'disc-2',
        agentId: 'agent-a',
        sessionId: 's3',
        vendor: 'claude',
        lastSeq: 1,
        createdAt: Date.now(),
      })

      const mgr = new AgentSessionManager({
        getAdapter: () => undefined as unknown as VendorAdapter,
        store,
        projection,
      })

      mgr.closeAll('disc-1')
      expect(rows.size).toBe(1)
      expect(rows.has('disc-2::agent-a')).toBe(true)
      expect(deleteAlls).toEqual(['disc-1'])
    })
  })

  // ── Error handling ──────────────────────────────────────────────────────
  describe('error handling', () => {
    it('throws a clear error when no adapter is registered for the vendor', async () => {
      const { store } = createFakeStore()

      const mgr = new AgentSessionManager({
        // getAdapter returns undefined for every vendor
        getAdapter: (_v: VendorId) => undefined as unknown as VendorAdapter,
        store,
      })

      // First call with an agent whose vendor has no registered adapter
      await expect(
        mgr.ask('disc-1', claudeAgent, 'prompt', '/cwd', new AbortController().signal),
      ).rejects.toThrow(/no adapter registered for vendor "claude"/)
    })
  })

  // ── Text concatenation ──────────────────────────────────────────────────
  describe('text collection', () => {
    it('concatenates text blocks from assistant messages', async () => {
      const { store } = createFakeStore()

      const driver = new FakeDriver('claude', () => ({
        run: new FakeRun('s1', [
          msg({
            role: 'assistant',
            blocks: [textBlock('Part one. ')],
          }),
          msg({
            role: 'assistant',
            blocks: [textBlock('Part two.')],
          }),
          msg({
            role: 'user',
            // User messages are ignored by text collection
            blocks: [textBlock('should not appear')],
          }),
        ]),
        sessionId: 's1',
      }))
      const adapter: VendorAdapter = {
        vendor: 'claude',
        capabilities: driver.capabilities,
        driver,
        approval: { onRequest: () => () => {} },
        sessions: { list: async () => [], read: async () => [] },
        skill: null!,
        listTools: () => [],
      }

      const mgr = new AgentSessionManager({
        getAdapter: (v) => (v === 'claude' ? adapter : (undefined as unknown as VendorAdapter)),
        store,
      })

      const result = await mgr.ask(
        'disc-1',
        claudeAgent,
        'prompt',
        '/cwd',
        new AbortController().signal,
      )
      expect(result).toBe('Part one. Part two.')
    })
  })

  // ── Cross-vendor: codex ─────────────────────────────────────────────────
  describe('cross-vendor resume', () => {
    it('works with codex vendor adapter', async () => {
      const { store, rows } = createFakeStore()

      // Pre-populate a codex session
      rows.set('disc-1::agent-b', {
        discussionId: 'disc-1',
        agentId: 'agent-b',
        sessionId: 'codex-thread-1',
        vendor: 'codex',
        lastSeq: 2,
        createdAt: Date.now(),
      })

      const driver = new FakeDriver('codex', ({ resume }) => {
        expect(resume).toBe('codex-thread-1')
        return {
          run: new FakeRun('codex-thread-1', [
            msg({ vendor: 'codex', blocks: [textBlock('Codex reply')] }),
          ]),
          sessionId: 'codex-thread-1',
        }
      })
      const adapter: VendorAdapter = {
        vendor: 'codex',
        capabilities: driver.capabilities,
        driver,
        approval: { onRequest: () => () => {} },
        sessions: { list: async () => [], read: async () => [] },
        skill: null!,
        listTools: () => [],
      }

      const mgr = new AgentSessionManager({
        getAdapter: (v) => (v === 'codex' ? adapter : (undefined as unknown as VendorAdapter)),
        store,
      })

      const result = await mgr.ask(
        'disc-1',
        codexAgent,
        'Codex prompt',
        '/cwd',
        new AbortController().signal,
      )
      expect(result).toBe('Codex reply')

      // lastSeq unchanged by resume (orchestrator owns advancement).
      const row = rows.get('disc-1::agent-b')!
      expect(row.lastSeq).toBe(2)
    })
  })

  // ── Cross-vendor: cursor ────────────────────────────────────────────────
  describe('cross-vendor cursor', () => {
    const cursorAdapterFor = (driver: FakeDriver): VendorAdapter => ({
      vendor: 'cursor',
      capabilities: driver.capabilities,
      driver,
      approval: { onRequest: () => () => {} },
      sessions: { list: async () => [], read: async () => [] },
      skill: null!,
      listTools: () => [],
    })

    it('resolves a registered cursor adapter and returns its reply', async () => {
      const { store, rows } = createFakeStore()

      const driver = new FakeDriver('cursor', ({ resume }) => {
        expect(resume).toBeUndefined()
        return {
          run: new FakeRun('cursor-thread-1', [
            msg({ vendor: 'cursor', blocks: [textBlock('Cursor reply')] }),
          ]),
          sessionId: 'cursor-thread-1',
        }
      })

      const mgr = new AgentSessionManager({
        getAdapter: (v) =>
          v === 'cursor' ? cursorAdapterFor(driver) : (undefined as unknown as VendorAdapter),
        store,
      })

      const result = await mgr.ask(
        'disc-1',
        cursorAgent,
        'Cursor prompt',
        '/cwd',
        new AbortController().signal,
      )
      expect(result).toBe('Cursor reply')
      expect(driver.startCalls).toHaveLength(1)
      expect(rows.get('disc-1::agent-c')?.sessionId).toBe('cursor-thread-1')
      expect(rows.get('disc-1::agent-c')?.vendor).toBe('cursor')
    })

    it('resumes a persisted cursor session', async () => {
      const { store, rows } = createFakeStore()

      rows.set('disc-1::agent-c', {
        discussionId: 'disc-1',
        agentId: 'agent-c',
        sessionId: 'cursor-thread-1',
        vendor: 'cursor',
        lastSeq: 3,
        createdAt: Date.now(),
      })

      const driver = new FakeDriver('cursor', ({ resume }) => {
        expect(resume).toBe('cursor-thread-1')
        return {
          run: new FakeRun('cursor-thread-1', [
            msg({ vendor: 'cursor', blocks: [textBlock('Cursor resumed')] }),
          ]),
          sessionId: 'cursor-thread-1',
        }
      })

      const mgr = new AgentSessionManager({
        getAdapter: (v) =>
          v === 'cursor' ? cursorAdapterFor(driver) : (undefined as unknown as VendorAdapter),
        store,
      })

      const result = await mgr.ask(
        'disc-1',
        cursorAgent,
        'Cursor prompt',
        '/cwd',
        new AbortController().signal,
      )
      expect(result).toBe('Cursor resumed')
      expect(rows.get('disc-1::agent-c')!.lastSeq).toBe(3)
    })

    // The null guard at the assembly boundary: no cursor CLI ⇒ no registration ⇒
    // the lookup keeps failing exactly as it does today (no new error path).
    it('keeps the unregistered-vendor failure when no cursor adapter exists', async () => {
      const { store } = createFakeStore()

      // Mirrors the server-side assembly: a null adapter is never registered.
      const registry = new Map<VendorId, VendorAdapter>()
      const cursorAdapter: VendorAdapter | null = null
      if (cursorAdapter) registry.set('cursor', cursorAdapter)

      const mgr = new AgentSessionManager({
        getAdapter: (v) => registry.get(v) as unknown as VendorAdapter,
        store,
      })

      await expect(
        mgr.ask('disc-1', cursorAgent, 'prompt', '/cwd', new AbortController().signal),
      ).rejects.toThrow(/no adapter registered for vendor "cursor"/)
    })
  })

  // ── codex capability passthrough ────────────────────────────────────────
  describe('codex capability fields (2026-08-08-013)', () => {
    const codexCapsAgent: AgentConfig = {
      id: 'agent-caps',
      vendor: 'codex',
      configMode: 'custom',
      displayName: 'Codex Caps',
      enabled: true,
      config: {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-real',
        model: 'deepseek-v4-flash',
        wireApi: 'chat',
        contextWindow: 65536,
        maxOutputTokens: 8192,
      },
      icon: 'agent',
    }

    const adapterFor = (driver: FakeDriver): VendorAdapter => ({
      vendor: 'codex',
      capabilities: driver.capabilities,
      driver,
      approval: { onRequest: () => () => {} },
      sessions: { list: async () => [], read: async () => [] },
      skill: null!,
      listTools: () => [],
    })

    it('threads the codex capability fields into driver.start on a fresh session', async () => {
      const { store } = createFakeStore()
      const driver = new FakeDriver('codex', () => ({
        run: new FakeRun('session-caps', [msg({ vendor: 'codex', blocks: [textBlock('ok')] })]),
        sessionId: 'session-caps',
      }))
      const mgr = new AgentSessionManager({
        getAdapter: (v) =>
          v === 'codex' ? adapterFor(driver) : (undefined as unknown as VendorAdapter),
        store,
      })
      await mgr.ask('disc-caps', codexCapsAgent, 'prompt', '/cwd', new AbortController().signal)
      expect(driver.startCalls).toHaveLength(1)
      expect(driver.startCalls[0].contextWindow).toBe(65536)
      expect(driver.startCalls[0].maxOutputTokens).toBe(8192)
    })

    it('threads the codex capability fields on a resume too', async () => {
      const { store, rows } = createFakeStore()
      rows.set('disc-caps::agent-caps', {
        discussionId: 'disc-caps',
        agentId: 'agent-caps',
        sessionId: 'session-caps-existing',
        vendor: 'codex',
        lastSeq: 1,
        createdAt: Date.now(),
      })
      const driver = new FakeDriver('codex', ({ resume }) => {
        expect(resume).toBe('session-caps-existing')
        return {
          run: new FakeRun('session-caps-existing', [
            msg({ vendor: 'codex', blocks: [textBlock('ok')] }),
          ]),
          sessionId: 'session-caps-existing',
        }
      })
      const mgr = new AgentSessionManager({
        getAdapter: (v) =>
          v === 'codex' ? adapterFor(driver) : (undefined as unknown as VendorAdapter),
        store,
      })
      await mgr.ask('disc-caps', codexCapsAgent, 'prompt', '/cwd', new AbortController().signal)
      expect(driver.startCalls).toHaveLength(1)
      expect(driver.startCalls[0].contextWindow).toBe(65536)
      expect(driver.startCalls[0].maxOutputTokens).toBe(8192)
    })

    it('omits the capability fields when the agent has none configured', async () => {
      const { store } = createFakeStore()
      const driver = new FakeDriver('codex', () => ({
        run: new FakeRun('session-plain', [msg({ vendor: 'codex', blocks: [textBlock('ok')] })]),
        sessionId: 'session-plain',
      }))
      const mgr = new AgentSessionManager({
        getAdapter: (v) =>
          v === 'codex' ? adapterFor(driver) : (undefined as unknown as VendorAdapter),
        store,
      })
      // `codexAgent` is a system-mode agent — no custom provider, no capability fields.
      await mgr.ask('disc-plain', codexAgent, 'prompt', '/cwd', new AbortController().signal)
      expect(driver.startCalls).toHaveLength(1)
      expect(driver.startCalls[0].contextWindow).toBeUndefined()
      expect(driver.startCalls[0].maxOutputTokens).toBeUndefined()
    })
  })

  // ── setLastSeq: orchestrator-driven seq advancement ─────────────────────
  describe('setLastSeq', () => {
    const mgrWith = (store: AgentSessionStore): AgentSessionManager =>
      new AgentSessionManager({
        getAdapter: () => undefined as unknown as VendorAdapter,
        store,
      })

    it('writes the real consumed seq, preserving sessionId/vendor', () => {
      const { store, rows } = createFakeStore()
      rows.set('disc-1::agent-a', {
        discussionId: 'disc-1',
        agentId: 'agent-a',
        sessionId: 'session-x',
        vendor: 'claude',
        lastSeq: 2,
        createdAt: 111,
      })

      mgrWith(store).setLastSeq('disc-1', 'agent-a', 7)

      const row = rows.get('disc-1::agent-a')!
      expect(row.lastSeq).toBe(7)
      // sessionId / vendor / createdAt untouched
      expect(row.sessionId).toBe('session-x')
      expect(row.vendor).toBe('claude')
      expect(row.createdAt).toBe(111)
    })

    it('is monotonic — never regresses below the stored seq', () => {
      const { store, rows } = createFakeStore()
      rows.set('disc-1::agent-a', {
        discussionId: 'disc-1',
        agentId: 'agent-a',
        sessionId: 'session-x',
        vendor: 'claude',
        lastSeq: 5,
        createdAt: 111,
      })
      const mgr = mgrWith(store)

      mgr.setLastSeq('disc-1', 'agent-a', 3) // lower → ignored
      expect(rows.get('disc-1::agent-a')!.lastSeq).toBe(5)
      mgr.setLastSeq('disc-1', 'agent-a', 5) // equal → no-op
      expect(rows.get('disc-1::agent-a')!.lastSeq).toBe(5)
      mgr.setLastSeq('disc-1', 'agent-a', 9) // higher → advances
      expect(rows.get('disc-1::agent-a')!.lastSeq).toBe(9)
    })

    it('is a no-op when no session row exists yet', () => {
      const { store, rows } = createFakeStore()
      mgrWith(store).setLastSeq('disc-1', 'agent-missing', 4)
      expect(rows.size).toBe(0)
    })
  })
})
