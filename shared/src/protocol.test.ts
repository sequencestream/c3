import { describe, it, expect } from 'vitest'
import {
  resolveDefaultAgentId,
  isImageMediaType,
  IMAGE_MEDIA_TYPES,
  SYSTEM_AGENT_ID,
  AUTH_PROVIDER_KINDS,
} from './protocol.js'
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
    { type: 'remove_workspace', path: '/abs/proj' },
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
    },
    {
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'awaiting_permission' }],
    },
    {
      type: 'workspaces',
      workspaces: [{ id: 'ws-1', name: 'proj', lastAccessed: 1 }],
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
    // Consensus scoped to one vendor, noting the cross-vendor advisors it excluded.
    {
      type: 'consensus_auto',
      toolName: 'Write',
      input: {},
      outcome: {
        kind: 'tool',
        votes: [],
        summary: 'ok',
        unanimous: true,
        decision: 'allow',
        vendorScope: 'claude',
        crossVendorExcluded: 2,
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
})

describe('auth provider kinds (ADR-0023)', () => {
  it('exposes none, basic, and oauth as the provider kinds', () => {
    expect(AUTH_PROVIDER_KINDS).toEqual(['none', 'basic', 'oauth'])
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
