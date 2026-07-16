import { describe, it, expect } from 'vitest'
import {
  resolveDefaultAgentId,
  isImageMediaType,
  IMAGE_MEDIA_TYPES,
  SYSTEM_AGENT_ID,
  AUTH_PROVIDER_KINDS,
  isJsonValue,
  validateGenericEvent,
  normalizeGenericEventFilter,
  genericEventFilterMatches,
} from './protocol.js'
import type { GenericEventFilter, GenericEventView } from './protocol.js'
import type {
  AgentConfig,
  AuthConfig,
  AuthProvider,
  ClientToServer,
  ServerToClient,
} from './protocol.js'

/**
 * The protocol module is types-only, so there is no runtime behavior to test.
 * These tests act as a compile-time + JSON round-trip guard: each representative
 * message must remain assignable to its union and survive JSON serialization
 * unchanged (the WS wire format).
 */
describe('protocol wire format', () => {
  const clientMessages: ClientToServer[] = [
    { type: 'user_prompt', text: 'hello' },
    // A prompt carrying images (2026-06-16): base64 + media type per attachment.
    {
      type: 'user_prompt',
      text: 'look',
      images: [{ mediaType: 'image/png', data: 'AAAA' }],
    },
    { type: 'permission_response', requestId: 'r1', decision: 'allow' },
    { type: 'permission_response', requestId: 'r2', decision: 'deny' },
    { type: 'set_mode', mode: 'plan' },
    { type: 'add_workspace', path: '/abs/proj' },
    { type: 'remove_workspace', workspaceId: 'ws-1' },
    { type: 'list_sessions', workspaceId: 'ws-1' },
    { type: 'list_dir', workspaceId: 'ws-1', rel: 'src' },
    { type: 'read_file', workspaceId: 'ws-1', rel: 'src/index.ts' },
    { type: 'search_codes', workspaceId: 'ws-1', query: 'handler', mode: 'content' },
    { type: 'create_session', workspaceId: 'ws-1' },
    // With an explicit agent (recorded as the pending session's intent, ADR-0015).
    { type: 'create_session', workspaceId: 'ws-1', agentId: 'claude-b' },
    { type: 'delete_session', workspaceId: 'ws-1', sessionId: 's1' },
    { type: 'select_session', workspaceId: 'ws-1', sessionId: 's1' },
    { type: 'rename_session', workspaceId: 'ws-1', sessionId: 's1', title: 'New' },
    { type: 'stop_run' },
    { type: 'request_session_status' },
    { type: 'ping' },
    // Auth wire messages (ADR-0023). `password` is plaintext in transit only.
    { type: 'login', request: { username: 'admin', password: 'pw' } },
    { type: 'logout' },
  ]

  const serverMessages: ServerToClient[] = [
    {
      type: 'ready',
      workspaces: [],
      activeSessionId: null,
      statuses: [],
      isAdmin: true,
      subject: null,
      updateStatus: { available: false, latestVersion: null, checkedAt: null },
    },
    {
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'awaiting_permission' }],
    },
    {
      type: 'workspaces',
      workspaces: [{ id: 'ws-1', name: 'proj', path: '/tmp/proj', lastAccessed: 1 }],
    },
    {
      type: 'sessions',
      workspaceId: 'ws-1',
      sessions: [
        {
          sessionId: 's1',
          title: 't',
          lastModified: 2,
          mode: 'default',
          isToolSession: false,
          vendor: 'claude',
        },
      ],
    },
    {
      type: 'dir_listed',
      workspaceId: 'ws-1',
      rel: '',
      entries: [{ name: 'src', path: 'src', type: 'directory' }],
    },
    {
      type: 'file_read',
      workspaceId: 'ws-1',
      file: {
        path: 'src/index.ts',
        size: 12,
        binary: false,
        truncated: false,
        content: 'export {}',
      },
    },
    {
      type: 'codes_searched',
      workspaceId: 'ws-1',
      query: 'handler',
      mode: 'content',
      hits: [
        { path: 'src/index.ts', type: 'file', line: 1, lineText: 'handler', match: 'handler' },
      ],
      truncated: false,
      timedOut: false,
    },
    {
      type: 'session_selected',
      workspaceId: 'ws-1',
      sessionId: 's1',
      title: 't',
      mode: 'plan',
      history: [{ kind: 'user', text: 'hi' }],
      status: 'idle',
    },
    { type: 'session_started', clientId: 'pending:1', sessionId: 's1' },
    { type: 'mode_changed', mode: 'acceptEdits' },
    { type: 'user_text', text: 'hi' },
    { type: 'assistant_text', text: 'hi' },
    { type: 'tool_use', toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
    { type: 'permission_request', requestId: 'r1', toolName: 'Write', input: {} },
    { type: 'turn_end', reason: 'complete' },
    { type: 'turn_end', reason: 'error', error: 'boom' },
    // Socket auto-resume telemetry (AS-R18): a turn that survived a reconnect.
    { type: 'turn_end', reason: 'complete', reconnect_attempted: true, retry_count: 1 },
    // A socket disconnect the side-effect gate refused (AS-R19) → manual continue.
    {
      type: 'turn_end',
      reason: 'error',
      original_error: 'socket connection was closed unexpectedly',
      side_effect_pending: true,
      reconnect_attempted: false,
      retry_count: 0,
    },
    // The transient reconnecting status (AS-R18).
    { type: 'session_status', statuses: [{ sessionId: 's1', status: 'reconnecting' }] },
    { type: 'error', error: { code: 'workspace.unknown', params: { path: '/bad' } } },
    { type: 'pong' },
    { type: 'agent_failed', agentId: 'sys', agentName: 'System', error: 'rate limit' },
    {
      type: 'all_agents_failed',
      agents: [{ agentId: 'sys', agentName: 'System', error: 'rate limit' }],
      message: 'All agents failed: rate limit',
    },
    // Heterogeneous tolerance (2026-06-06-006): a degradation chain that dropped a
    // cross-vendor fallback (it cannot carry context, so it is skipped, not tried).
    {
      type: 'all_agents_failed',
      agents: [{ agentId: 'sys', agentName: 'System', error: 'rate limit' }],
      message: 'All agents failed: rate limit',
      crossVendorSkipped: [{ agentId: 'cx', agentName: 'Codex', vendor: 'codex' }],
    },
    // System settings reply with its runtime companions: per-vendor host-CLI
    // presence (ADR-0012) and the session→agent binding counts (ADR-0015).
    {
      type: 'settings',
      settings: {
        agents: [],
        defaultAgentId: 'system',
        toolAgentId: '',
        intentAgentId: '',
        specAgentId: '',
        automationAgentId: '',
        sandboxDefaultAgentId: '',
        sandboxToolAgentId: '',
        sandboxIntentAgentId: '',
        sandboxSpecAgentId: '',
        sandboxAutomationAgentId: '',
      },
      hostStatus: [
        {
          vendor: 'claude',
          present: true,
          binary: 'claude',
          path: '/usr/local/bin/claude',
          installHint: 'install claude',
        },
        {
          vendor: 'codex',
          present: false,
          binary: 'codex',
          path: null,
          installHint: 'install codex',
        },
      ],
      bindingStats: { bound: 3, pending: 1 },
      sessionCapabilities: {
        claude: { list: 'full', read: 'full', resume: 'full', rename: 'full', delete: 'full' },
        codex: { list: 'full', read: 'full', resume: 'full', rename: 'none', delete: 'none' },
      },
    },
    // Auth replies (ADR-0023): a successful login carries the issued token +
    // expiry; a failure carries a structured code; `unauthenticated` is the 401.
    { type: 'login_result', result: { ok: true, token: 'tok', expiresAt: 1000 } },
    { type: 'login_result', result: { ok: false, code: 'invalid_credentials' } },
    { type: 'unauthenticated', reason: 'expired' },
    // Cross-vendor consensus over a normalized tool request: voters of two vendors,
    // judging the vendor-neutral risk payload rather than the native tool name.
    {
      type: 'consensus_auto',
      toolName: 'Write',
      input: {},
      outcome: {
        kind: 'tool',
        votes: [
          { agentId: 'a', agentName: 'A', vendor: 'claude', decision: 'allow', reason: 'safe' },
          { agentId: 'x', agentName: 'X', vendor: 'codex', decision: 'allow', reason: 'ok' },
        ],
        summary: 'ok',
        unanimous: true,
        decision: 'allow',
        normalized: {
          operationIntent: 'write-file: Create or overwrite a file',
          resourceScope: { kind: 'file', targets: ['/ws/a.ts'] },
          risks: { read: false, write: true, execute: false, network: false },
          normalizationVersion: 1,
        },
      },
    },
    // A request that could not be normalized: every voter abstains, defers to human.
    {
      type: 'permission_request',
      requestId: 'r1',
      toolName: 'mcp__unknown__do',
      input: {},
      consensus: {
        kind: 'tool',
        votes: [
          {
            agentId: 'x',
            agentName: 'X',
            vendor: 'codex',
            decision: 'abstain',
            reason: 'request not normalizable (unknown-tool)',
          },
        ],
        summary: 'deferred',
        unanimous: false,
        decision: null,
        normalizationFailure: 'unknown-tool',
      },
    },
  ]

  it('round-trips every client message through JSON unchanged', () => {
    for (const msg of clientMessages) {
      expect(JSON.parse(JSON.stringify(msg))).toEqual(msg)
    }
  })

  it('round-trips every server message through JSON unchanged', () => {
    for (const msg of serverMessages) {
      expect(JSON.parse(JSON.stringify(msg))).toEqual(msg)
    }
  })

  it('discriminates messages by their `type` tag', () => {
    const decisions = clientMessages
      .filter(
        (m): m is Extract<ClientToServer, { type: 'permission_response' }> =>
          m.type === 'permission_response',
      )
      .map((m) => m.decision)
    expect(decisions).toEqual(['allow', 'deny'])
  })
})

describe('isImageMediaType — prompt-image boundary guard (2026-06-16)', () => {
  it('accepts every declared image media type', () => {
    for (const t of IMAGE_MEDIA_TYPES) expect(isImageMediaType(t)).toBe(true)
  })

  it('rejects non-image media types (the server refuses these attachments)', () => {
    expect(isImageMediaType('application/pdf')).toBe(false)
    expect(isImageMediaType('text/plain')).toBe(false)
    expect(isImageMediaType('image/svg+xml')).toBe(false) // not in the allowlist
    expect(isImageMediaType('')).toBe(false)
  })
})

describe('resolveDefaultAgentId — fall through to next enabled (AC-R2/AC-R10, 2026-06-15-001)', () => {
  /** A minimal claude agent in `order_seq` array position; `enabled` defaults true. */
  function agent(id: string, enabled?: boolean): AgentConfig {
    return {
      id,
      vendor: 'claude',
      configMode: 'system',
      displayName: id,
      ...(enabled === undefined ? {} : { enabled }),
      config: { baseUrl: '', apiKey: '', model: '' },
    }
  }

  it('keeps the current default when it exists and is enabled', () => {
    const agents = [agent('a'), agent('b'), agent('c')]
    expect(resolveDefaultAgentId(agents, 'b')).toBe('b')
  })

  it('falls through to the NEXT enabled agent after a disabled default', () => {
    const agents = [agent('a'), agent('b', false), agent('c')]
    expect(resolveDefaultAgentId(agents, 'b')).toBe('c')
  })

  it('skips further disabled agents when scanning forward', () => {
    const agents = [agent('a'), agent('b', false), agent('c', false), agent('d')]
    expect(resolveDefaultAgentId(agents, 'b')).toBe('d')
  })

  it('wraps to the first enabled agent when nothing enabled follows the default', () => {
    const agents = [agent('a'), agent('b'), agent('c', false)]
    expect(resolveDefaultAgentId(agents, 'c')).toBe('a')
  })

  it('falls to the first enabled agent when the current default was removed', () => {
    const agents = [agent('a', false), agent('b'), agent('c')]
    expect(resolveDefaultAgentId(agents, 'gone')).toBe('b')
  })

  it('returns SYSTEM_AGENT_ID when every agent is disabled', () => {
    const agents = [agent('a', false), agent('b', false)]
    expect(resolveDefaultAgentId(agents, 'a')).toBe(SYSTEM_AGENT_ID)
  })

  it('treats a missing `enabled` flag as enabled (back-compat)', () => {
    const agents = [agent('a'), agent('b')]
    expect(resolveDefaultAgentId(agents, 'a')).toBe('a')
  })

  it('keeps a group ref default while the group still has an enabled member (ADR-0029)', () => {
    const grouped = { ...agent('a'), group: 'fast' }
    const agents = [grouped, agent('b')]
    expect(resolveDefaultAgentId(agents, '_c3_claude_fast')).toBe('_c3_claude_fast')
  })

  it('falls a group ref default through to the first enabled agent when the group emptied', () => {
    const agents = [agent('a'), agent('b')] // no member carries `fast`
    expect(resolveDefaultAgentId(agents, '_c3_claude_fast')).toBe('a')
  })
})

describe('auth provider kinds (ADR-0023)', () => {
  it('exposes none and basic as the provider kinds', () => {
    expect(AUTH_PROVIDER_KINDS).toEqual(['none', 'basic'])
  })

  it('accepts a none provider (no-auth) in an AuthConfig and survives JSON round-trip', () => {
    // The `none` arm carries no config — `kind` alone is the whole shape, and
    // `enabled` is pinned false (the C-SEC-5 localhost-only default).
    const provider: AuthProvider = { kind: 'none' }
    const auth: AuthConfig = {
      enabled: false,
      provider,
      session: { ttlSeconds: 900, signingKeyRef: 'C3_AUTH_KEY' },
    }
    expect(JSON.parse(JSON.stringify(auth))).toEqual(auth)
  })
})

describe('generic event contract — validateGenericEvent / isJsonValue', () => {
  it('accepts a flat metadata + multi-level JSON data core', () => {
    const res = validateGenericEvent({
      type: 'pr:operation',
      status: 'success',
      description: 'ok',
      metadata: { operation: 'create', actor: 'model' },
      data: { pr: { number: 7, nested: { deep: [1, 2, { k: 'v' }] } } },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.metadata).toEqual({ operation: 'create', actor: 'model' })
    expect(res.value.data).toEqual({ pr: { number: 7, nested: { deep: [1, 2, { k: 'v' }] } } })
  })

  it('rejects an empty / missing type', () => {
    expect(validateGenericEvent({ type: '' }).ok).toBe(false)
    expect(validateGenericEvent({ type: '   ' }).ok).toBe(false)
    expect(validateGenericEvent({}).ok).toBe(false)
    expect(validateGenericEvent(null).ok).toBe(false)
  })

  it('rejects nested (non-string) metadata values', () => {
    const res = validateGenericEvent({ type: 't', metadata: { nested: { a: 'b' } } })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/metadata/)
  })

  it('rejects non-JSON data values (undefined, non-finite, function)', () => {
    expect(validateGenericEvent({ type: 't', data: { a: undefined } }).ok).toBe(false)
    expect(validateGenericEvent({ type: 't', data: { a: Number.POSITIVE_INFINITY } }).ok).toBe(
      false,
    )
    expect(validateGenericEvent({ type: 't', data: { a: () => 1 } }).ok).toBe(false)
  })

  it('rejects a data that is an array or primitive (must be an object)', () => {
    expect(validateGenericEvent({ type: 't', data: [1, 2] as unknown as object }).ok).toBe(false)
    expect(validateGenericEvent({ type: 't', data: 5 as unknown as object }).ok).toBe(false)
  })

  it('drops unknown top-level keys from the validated copy', () => {
    const res = validateGenericEvent({ type: 't', extra: 'x', workspacePath: 'evil' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value).toEqual({ type: 't' })
  })

  it('isJsonValue detects cycles and class instances', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isJsonValue(cyclic)).toBe(false)
    expect(isJsonValue(new Date())).toBe(false)
    expect(isJsonValue({ a: 1, b: [true, null, 'x'] })).toBe(true)
  })
})

describe('generic event filter — normalizeGenericEventFilter', () => {
  it('rejects a filter with no valid type (never widens to "any type")', () => {
    expect(normalizeGenericEventFilter(null)).toBeNull()
    expect(normalizeGenericEventFilter({})).toBeNull()
    expect(normalizeGenericEventFilter({ type: '' })).toBeNull()
    expect(normalizeGenericEventFilter({ type: '   ' })).toBeNull()
    expect(normalizeGenericEventFilter({ type: 'x'.repeat(65) })).toBeNull()
  })

  it('keeps a bare type, dropping empty status/metadata dimensions', () => {
    expect(normalizeGenericEventFilter({ type: 'run:settled' })).toEqual({ type: 'run:settled' })
    expect(
      normalizeGenericEventFilter({ type: 'run:settled', statuses: [], metadata: null }),
    ).toEqual({ type: 'run:settled' })
  })

  it('trims, dedups, and caps statuses; drops empty/over-long entries', () => {
    const res = normalizeGenericEventFilter({
      type: 'run:settled',
      statuses: [' complete ', 'complete', 'error', '', '   ', 'x'.repeat(257)],
    })
    expect(res).toEqual({ type: 'run:settled', statuses: ['complete', 'error'] })
  })

  it('normalizes the metadata dimension via the shared metadata filter', () => {
    const res = normalizeGenericEventFilter({
      type: 'pr:operation',
      metadata: {
        combinator: 'OR',
        conditions: [
          { key: 'operation', value: 'create' },
          { key: 'operation', value: 'merge' },
          { key: '', value: 'bad' },
        ],
      },
    })
    expect(res).toEqual({
      type: 'pr:operation',
      metadata: {
        combinator: 'OR',
        conditions: [
          { key: 'operation', value: 'create' },
          { key: 'operation', value: 'merge' },
        ],
      },
    })
  })
})

describe('generic event filter — genericEventFilterMatches', () => {
  const ws = '/abs/workspace'
  const view = (event: GenericEventView['event'], workspacePath = ws): GenericEventView => ({
    workspacePath,
    event,
  })

  it('matches on all four dimensions when every one passes', () => {
    const filter: GenericEventFilter = {
      type: 'run:settled',
      statuses: ['complete'],
      metadata: { combinator: 'AND', conditions: [{ key: 'src', value: 'ci' }] },
    }
    const res = genericEventFilterMatches(
      ws,
      filter,
      view({ type: 'run:settled', status: 'complete', metadata: { src: 'ci' } }),
    )
    expect(res.matched).toBe(true)
    expect(res.breakdown.map((b) => b.name)).toEqual(['workspace', 'type', 'status', 'metadata'])
  })

  it('fails closed on a null filter (type never matches)', () => {
    const res = genericEventFilterMatches(ws, null, view({ type: 'run:settled' }))
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(false)
  })

  it('fails on a workspace mismatch', () => {
    const res = genericEventFilterMatches(
      ws,
      { type: 'run:settled' },
      view({ type: 'run:settled' }, '/other/workspace'),
    )
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'workspace')?.passed).toBe(false)
  })

  it('fails on a type mismatch', () => {
    const res = genericEventFilterMatches(
      ws,
      { type: 'run:settled' },
      view({ type: 'run:started' }),
    )
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(false)
  })

  it('absent/empty statuses matches any status (including no status)', () => {
    expect(
      genericEventFilterMatches(ws, { type: 't' }, view({ type: 't', status: 'anything' })).matched,
    ).toBe(true)
    expect(genericEventFilterMatches(ws, { type: 't' }, view({ type: 't' })).matched).toBe(true)
  })

  it('non-empty statuses requires an exact, case-sensitive membership', () => {
    const filter: GenericEventFilter = { type: 't', statuses: ['complete', 'error'] }
    expect(
      genericEventFilterMatches(ws, filter, view({ type: 't', status: 'error' })).matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(ws, filter, view({ type: 't', status: 'Complete' })).matched,
    ).toBe(false)
    // An event that carries no status fails a non-empty statuses filter.
    expect(genericEventFilterMatches(ws, filter, view({ type: 't' })).matched).toBe(false)
  })

  it('metadata AND requires every condition; OR requires at least one', () => {
    const andFilter: GenericEventFilter = {
      type: 't',
      metadata: {
        combinator: 'AND',
        conditions: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
      },
    }
    expect(
      genericEventFilterMatches(ws, andFilter, view({ type: 't', metadata: { a: '1', b: '2' } }))
        .matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(ws, andFilter, view({ type: 't', metadata: { a: '1' } })).matched,
    ).toBe(false)

    const orFilter: GenericEventFilter = {
      type: 't',
      metadata: {
        combinator: 'OR',
        conditions: [
          { key: 'operation', value: 'create' },
          { key: 'operation', value: 'merge' },
        ],
      },
    }
    expect(
      genericEventFilterMatches(ws, orFilter, view({ type: 't', metadata: { operation: 'merge' } }))
        .matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(ws, orFilter, view({ type: 't', metadata: { operation: 'close' } }))
        .matched,
    ).toBe(false)
  })

  it('missing event metadata key fails a metadata condition', () => {
    const filter: GenericEventFilter = {
      type: 't',
      metadata: { combinator: 'AND', conditions: [{ key: 'a', value: '1' }] },
    }
    expect(genericEventFilterMatches(ws, filter, view({ type: 't' })).matched).toBe(false)
  })

  it('requires ALL dimensions together — one failing dimension fails the match', () => {
    const filter: GenericEventFilter = { type: 't', statuses: ['ok'] }
    // type + status pass individually but a workspace mismatch still fails overall.
    const res = genericEventFilterMatches(ws, filter, view({ type: 't', status: 'ok' }, '/other'))
    expect(res.matched).toBe(false)
    expect(res.breakdown.filter((b) => b.passed).map((b) => b.name)).toEqual([
      'type',
      'status',
      'metadata',
    ])
  })
})

describe('normalizeGenericEventFilter — save-boundary hygiene', () => {
  it('requires a non-empty type; a missing/blank type yields null (never "match all")', () => {
    expect(normalizeGenericEventFilter(null)).toBeNull()
    expect(normalizeGenericEventFilter({})).toBeNull()
    expect(normalizeGenericEventFilter({ type: '' })).toBeNull()
    expect(normalizeGenericEventFilter({ type: '   ' })).toBeNull()
    expect(normalizeGenericEventFilter({ statuses: ['a'] })).toBeNull()
  })

  it('trims the type and rejects an over-long one', () => {
    expect(normalizeGenericEventFilter({ type: '  pr:operation  ' })).toEqual({
      type: 'pr:operation',
    })
    expect(normalizeGenericEventFilter({ type: 'x'.repeat(65) })).toBeNull()
  })

  it('trims, dedupes, and drops empty/over-long statuses; empties → undefined (any)', () => {
    expect(
      normalizeGenericEventFilter({
        type: 'run:settled',
        statuses: [' complete ', 'complete', '', '   ', 'error'],
      }),
    ).toEqual({ type: 'run:settled', statuses: ['complete', 'error'] })
    expect(normalizeGenericEventFilter({ type: 't', statuses: ['', '   '] })).toEqual({ type: 't' })
    expect(normalizeGenericEventFilter({ type: 't', statuses: 'nope' })).toEqual({ type: 't' })
  })

  it('folds a valid metadata filter and drops an empty one', () => {
    expect(
      normalizeGenericEventFilter({
        type: 'pr:operation',
        metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'OR' },
      }),
    ).toEqual({
      type: 'pr:operation',
      metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'OR' },
    })
    expect(
      normalizeGenericEventFilter({ type: 't', metadata: { conditions: [], combinator: 'AND' } }),
    ).toEqual({ type: 't' })
  })
})

describe('genericEventFilterMatches — pure matcher semantics', () => {
  const WS = '/abs/ws'
  const view = (event: GenericEventView['event'], workspacePath = WS): GenericEventView => ({
    workspacePath,
    event,
  })
  const F = (f: Partial<GenericEventFilter> & { type: string }): GenericEventFilter => f

  it('a null filter never matches (fails closed on type)', () => {
    const res = genericEventFilterMatches(WS, null, view({ type: 'x' }))
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(false)
  })

  it('matches when every dimension passes, with a stable breakdown order', () => {
    const res = genericEventFilterMatches(
      WS,
      F({
        type: 'pr:operation',
        statuses: ['success'],
        metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'AND' },
      }),
      view({ type: 'pr:operation', status: 'success', metadata: { operation: 'merge' } }),
    )
    expect(res.matched).toBe(true)
    expect(res.breakdown.map((b) => b.name)).toEqual(['workspace', 'type', 'status', 'metadata'])
  })

  it('fails on a workspace mismatch', () => {
    const res = genericEventFilterMatches(WS, F({ type: 'x' }), view({ type: 'x' }, '/abs/other'))
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'workspace')?.passed).toBe(false)
  })

  it('fails on a type mismatch', () => {
    expect(genericEventFilterMatches(WS, F({ type: 'a' }), view({ type: 'b' })).matched).toBe(false)
  })

  it('status: absent/empty statuses matches any (incl. an event with no status)', () => {
    expect(genericEventFilterMatches(WS, F({ type: 't' }), view({ type: 't' })).matched).toBe(true)
    expect(
      genericEventFilterMatches(WS, F({ type: 't', statuses: [] }), view({ type: 't' })).matched,
    ).toBe(true)
  })

  it('status: a non-empty statuses requires an exact, case-sensitive membership', () => {
    const f = F({ type: 't', statuses: ['complete', 'error'] })
    expect(genericEventFilterMatches(WS, f, view({ type: 't', status: 'error' })).matched).toBe(
      true,
    )
    expect(genericEventFilterMatches(WS, f, view({ type: 't', status: 'aborted' })).matched).toBe(
      false,
    )
    expect(genericEventFilterMatches(WS, f, view({ type: 't', status: 'Error' })).matched).toBe(
      false,
    )
    // An event that carries no status fails a non-empty statuses filter.
    expect(genericEventFilterMatches(WS, f, view({ type: 't' })).matched).toBe(false)
  })

  it('metadata: AND requires all, OR requires one, missing key fails, exact case', () => {
    const and = F({
      type: 't',
      metadata: {
        conditions: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
        combinator: 'AND',
      },
    })
    expect(
      genericEventFilterMatches(WS, and, view({ type: 't', metadata: { a: '1', b: '2' } })).matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(WS, and, view({ type: 't', metadata: { a: '1' } })).matched,
    ).toBe(false)
    const or = F({
      type: 't',
      metadata: {
        conditions: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
        combinator: 'OR',
      },
    })
    expect(
      genericEventFilterMatches(WS, or, view({ type: 't', metadata: { b: '2' } })).matched,
    ).toBe(true)
    expect(
      genericEventFilterMatches(WS, or, view({ type: 't', metadata: { a: 'X' } })).matched,
    ).toBe(false)
    // Exact case on the value.
    expect(
      genericEventFilterMatches(WS, or, view({ type: 't', metadata: { a: '1' } })).matched,
    ).toBe(true)
  })

  it('all dimensions must pass together (type ok but status wrong → no match)', () => {
    const res = genericEventFilterMatches(
      WS,
      F({ type: 't', statuses: ['ok'] }),
      view({ type: 't', status: 'bad' }),
    )
    expect(res.matched).toBe(false)
    expect(res.breakdown.find((b) => b.name === 'type')?.passed).toBe(true)
    expect(res.breakdown.find((b) => b.name === 'status')?.passed).toBe(false)
  })
})
