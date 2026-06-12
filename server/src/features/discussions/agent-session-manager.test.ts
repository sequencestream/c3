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
import { AgentSessionManager, type AgentSessionStore } from './agent-session-manager.js'

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
  }): Promise<AgentRun> {
    this.startCalls.push({
      prompt: opts.prompt,
      cwd: opts.cwd,
      resume: opts.resume,
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

describe('AgentSessionManager', () => {
  // ── First call: create new session ──────────────────────────────────────
  describe('first call (no prior session)', () => {
    it('creates a new vendor session and persists the mapping', async () => {
      const { store, rows } = createFakeStore()
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
    })
  })

  // ── Second call: resume ─────────────────────────────────────────────────
  describe('second call (resume existing session)', () => {
    it('resumes the stored session and updates lastSeq', async () => {
      const { store, rows } = createFakeStore()

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

      // lastSeq incremented
      const row = rows.get('disc-1::agent-a')!
      expect(row.lastSeq).toBe(4)
      expect(row.sessionId).toBe('session-existing')
    })
  })

  // ── Resume failure → degradation ────────────────────────────────────────
  describe('resume failure degradation', () => {
    it('falls back to a new session when resume throws', async () => {
      const { store, rows } = createFakeStore()

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
    })
  })

  // ── closeSession / closeAll ─────────────────────────────────────────────
  describe('closeSession / closeAll', () => {
    it('closeSession deletes one agent mapping', () => {
      const { store, rows } = createFakeStore()
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
      })

      mgr.closeSession('disc-1', 'agent-a')
      expect(rows.has('disc-1::agent-a')).toBe(false)
      // Other agent's mapping untouched
      expect(rows.has('disc-1::agent-b')).toBe(true)
    })

    it('closeAll deletes all agent mappings for a discussion', () => {
      const { store, rows } = createFakeStore()
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
      })

      mgr.closeAll('disc-1')
      expect(rows.size).toBe(1)
      expect(rows.has('disc-2::agent-a')).toBe(true)
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

      // lastSeq incremented
      const row = rows.get('disc-1::agent-b')!
      expect(row.lastSeq).toBe(3)
    })
  })
})
