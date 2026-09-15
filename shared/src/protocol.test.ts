import { describe, it, expect } from 'vitest'
import {
  AUTH_PROVIDER_KINDS,
  AUTOMATION_VENDORS,
  CREATE_PR_STAGES,
  IMAGE_MEDIA_TYPES,
  SPEED_TEST_CALIBRATION_VERSION,
  SPEED_TEST_DEFAULT_REQUESTS,
  SPEED_TEST_ERROR_CATEGORIES,
  SPEED_TEST_HISTORY_PAGE_SIZE,
  SPEED_TEST_MAX_OUTPUT_TOKENS,
  SPEED_TEST_MAX_REQUESTS,
  SPEED_TEST_MIN_REQUESTS,
  SPEED_TEST_REQUEST_TIMEOUT_MS,
  SPEED_TEST_TEMPERATURE,
  SYSTEM_AGENT_ID,
  VENDOR_IDS,
  isVendorId,
  vendorSupportsAutomation,
} from './protocol.js'
import type {
  AgentConfig,
  AuthConfig,
  AuthProvider,
  ClientToServer,
  CreatePrStage,
  QueueIntentDetail,
  SpeedTestActiveRun,
  SpeedTestErrorCode,
  SpeedTestRun,
  SpeedTestRunDetail,
  ServerToClient,
  SystemSettings,
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
    { type: 'add_workspace', workspaceName: 'proj', path: '/abs/proj' },
    { type: 'remove_workspace', workspaceName: 'ws-1' },
    { type: 'list_sessions', workspaceName: 'ws-1' },
    { type: 'list_dir', workspaceName: 'ws-1', rel: 'src' },
    { type: 'read_file', workspaceName: 'ws-1', rel: 'src/index.ts' },
    { type: 'search_files', workspaceName: 'ws-1', query: 'handler', mode: 'content' },
    { type: 'create_session', workspaceName: 'ws-1' },
    // With an explicit agent (recorded as the pending session's intent, ADR-0015).
    { type: 'create_session', workspaceName: 'ws-1', agentId: 'claude-b' },
    { type: 'delete_session', workspaceName: 'ws-1', sessionId: 's1' },
    { type: 'select_session', workspaceName: 'ws-1', sessionId: 's1' },
    { type: 'rename_session', workspaceName: 'ws-1', sessionId: 's1', title: 'New' },
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
      selfUpdate: {
        phase: 'idle',
        capable: false,
        incapableReason: 'dev-runtime',
        currentVersion: '0.0.0-dev',
        targetVersion: null,
        downloadedBytes: 0,
        totalBytes: 0,
      },
    },
    {
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'awaiting_permission' }],
    },
    {
      type: 'workspaces',
      workspaces: [{ name: 'proj', path: '/tmp/proj', lastAccessed: 1 }],
    },
    {
      type: 'sessions',
      workspaceName: 'ws-1',
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
      workspaceName: 'ws-1',
      rel: '',
      entries: [{ name: 'src', path: 'src', type: 'directory' }],
    },
    {
      type: 'file_read',
      workspaceName: 'ws-1',
      file: {
        path: 'src/index.ts',
        size: 12,
        binary: false,
        truncated: false,
        content: 'export {}',
      },
    },
    {
      type: 'files_searched',
      workspaceName: 'ws-1',
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
      workspaceName: 'ws-1',
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
        specReviewAgentId: '',
        automationAgentId: '',
        reviewAgentId: '',
        fixAgentId: '',
        workAgentId: '',
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
      vendorRuntime: {
        claude: { vendor: 'claude', available: true, runtime: 'host-cli', runtimeId: 'claude' },
        codex: {
          vendor: 'codex',
          available: false,
          runtime: 'host-cli',
          runtimeId: 'codex',
          reason: 'host-cli-missing',
        },
        // A vendor c3 launches but does not distribute answers in the same terms,
        // and reports where the binary it found came from.
        cursor: {
          vendor: 'cursor',
          available: true,
          runtime: 'host-cli',
          runtimeId: 'cursor-agent',
          origin: 'host-path',
        },
      },
      bindingStats: { bound: 3, pending: 1 },
      sessionCapabilities: {
        claude: { list: 'full', read: 'full', resume: 'full', rename: 'full', delete: 'full' },
        codex: { list: 'full', read: 'full', resume: 'full', rename: 'none', delete: 'none' },
        cursor: {
          list: 'partial',
          read: 'partial',
          resume: 'full',
          rename: 'none',
          delete: 'none',
        },
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

describe('sandbox runs share the unified agent configuration', () => {
  // Compile-time guards: `vue-tsc` fails these assignments if a sandbox-only role
  // field or a sandbox-conflict frame is ever reintroduced.
  it('exposes no sandbox-only role field on SystemSettings', () => {
    type SandboxRoleKey = Extract<keyof SystemSettings, `sandbox${string}AgentId`>
    const noSandboxRoles: [SandboxRoleKey] extends [never] ? true : false = true
    expect(noSandboxRoles).toBe(true)
  })

  it('carries no sandbox-conflict message in either direction', () => {
    type ConflictFrame = Extract<
      ClientToServer | ServerToClient,
      { type: `sandbox_conflict${string}` }
    >
    const noConflictFrames: [ConflictFrame] extends [never] ? true : false = true
    expect(noConflictFrames).toBe(true)
  })
})

describe('create_pr staged progress', () => {
  it('declares the four one-way stages in execution order', () => {
    expect(CREATE_PR_STAGES).toEqual(['analyzing-changes', 'committing', 'pushing', 'creating-pr'])
  })

  it('carries every stage on a connection-directed frame that survives JSON round-trip', () => {
    const frames: ServerToClient[] = CREATE_PR_STAGES.map((stage) => ({
      type: 'create_pr_progress',
      intentId: 'intent-1',
      stage,
    }))
    expect(JSON.parse(JSON.stringify(frames))).toEqual(frames)
  })

  it('rejects an off-protocol stage value', () => {
    // Compile-time guard: `failed` / `done` are terminals of other frames, never
    // stages here. `vue-tsc` fails this assignment if the union ever widens.
    const offProtocol = 'failed'
    expect(CREATE_PR_STAGES).not.toContain(offProtocol)
    // @ts-expect-error 'failed' is not a CreatePrStage
    const bad: CreatePrStage = 'failed'
    expect(bad).toBe('failed')
  })

  it('carries the run token on the request and on all three reply frames', () => {
    // The correlation contract: whatever a client puts on `create_pr` can come
    // back on progress, on success and on the failure error — that is what lets
    // it separate its own terminals from an unrelated error or a stale retry.
    const request: ClientToServer = {
      type: 'create_pr',
      workspaceName: 'ws-1',
      intentId: 'intent-1',
      requestId: 'req-1',
    }
    const replies: ServerToClient[] = [
      { type: 'create_pr_progress', intentId: 'intent-1', stage: 'pushing', requestId: 'req-1' },
      { type: 'create_pr_response', intentId: 'intent-1', prId: '42', requestId: 'req-1' },
      { type: 'error', error: { code: 'intent.prCreateFailed' }, requestId: 'req-1' },
    ]
    expect(JSON.parse(JSON.stringify([request, ...replies]))).toEqual([request, ...replies])
  })

  it('keeps the token optional so an uncorrelated client still type-checks', () => {
    const request: ClientToServer = {
      type: 'create_pr',
      workspaceName: 'ws-1',
      intentId: 'intent-1',
    }
    const reply: ServerToClient = { type: 'create_pr_response', intentId: 'intent-1', prId: '42' }
    expect([request, reply].every((m) => !('requestId' in m))).toBe(true)
  })
})

describe('AUTOMATION_VENDORS — which vendors can execute automations', () => {
  it('lists only real vendors', () => {
    expect(AUTOMATION_VENDORS.every(isVendorId)).toBe(true)
  })

  it('covers every vendor that has a dispatcher execution path', () => {
    expect(vendorSupportsAutomation('claude')).toBe(true)
    expect(vendorSupportsAutomation('codex')).toBe(true)
    // cursor's dispatcher branch runs its adapter in-process; the console offers
    // it from this same list, so the offer and the hard-fail agree.
    expect(vendorSupportsAutomation('cursor')).toBe(true)
  })

  it('answers for every registered vendor', () => {
    for (const vendor of VENDOR_IDS) expect(typeof vendorSupportsAutomation(vendor)).toBe('boolean')
  })
})

describe('queue_detail — queue position', () => {
  const base: QueueIntentDetail = {
    intentId: 'i-1',
    title: 'intent',
    status: 'todo',
    priority: 'P2',
    blockedReason: 'blocked_concurrency_gate',
    blockedDetail: '全局并发闸门',
    nextWakeupAt: null,
    lastAction: 'block',
    lastDecidedAt: null,
    attemptCount: 0,
    backoffCount: 0,
    backoffUntil: null,
    parked: false,
    parkReason: null,
    parkDetail: null,
    forceSkipped: false,
    queuePosition: 1,
  }

  it('carries a positive integer while the gate blocks, and null otherwise', () => {
    const frame: ServerToClient = {
      type: 'queue_detail',
      detail: {
        workspaceName: 'ws-1',
        state: 'awaiting_gate',
        tickId: 't-1',
        nextWakeupAt: null,
        items: [
          base,
          { ...base, intentId: 'i-2', queuePosition: 2 },
          // Not blocked by the gate → no place in line, and no placeholder value.
          {
            ...base,
            intentId: 'i-3',
            blockedReason: 'blocked_dependency',
            queuePosition: null,
          },
        ],
      },
    }
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame)
    const positions = frame.detail.items.map((i) => i.queuePosition)
    expect(positions).toEqual([1, 2, null])
  })
})

describe('model_provider_speed_test — the speed-test wire contract', () => {
  const run: SpeedTestRun = {
    runId: 'run-1',
    providerId: 'p1',
    providerDisplayName: 'Example',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_012_000,
    plannedCount: 10,
    protocolType: 'openai',
    apiDialect: 'chat',
    model: 'gpt-x',
    calibrationVersion: SPEED_TEST_CALIBRATION_VERSION,
    maxOutputTokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
    temperature: SPEED_TEST_TEMPERATURE,
    outcome: 'completed',
    summary: {
      completedCount: 10,
      successCount: 10,
      failureCount: 0,
      cancelledCount: 0,
      successRate: 1,
      // A metric with no eligible sample reports null, never 0.
      ttft: { sampleCount: 10, avgMs: 112.5, p50Ms: 100, p95Ms: 210, p99Ms: 210 },
      tpot: { sampleCount: 0, avgMs: null, p50Ms: null, p95Ms: null, p99Ms: null },
      endToEnd: { sampleCount: 10, avgMs: 1_050, p50Ms: 1_000, p95Ms: 1_400, p99Ms: 1_400 },
      successfulWallTimeMs: 10_500,
      outputTokensTotal: 100,
      tokensPerSecond: 9.52,
      requestsPerSecond: 0.95,
      estimatedSampleCount: 0,
    },
  }
  const detail: SpeedTestRunDetail = {
    run,
    requests: [
      {
        sequence: 1,
        startedAt: 1_700_000_000_000,
        outcome: 'success',
        failureCategory: null,
        httpStatus: 200,
        ttftMs: 100,
        endToEndMs: 1_000,
        outputTokens: 10,
        tokenCountSource: 'usage',
        tpotMs: 100,
      },
      // A failure keeps its category and status; a cancelled one is neither.
      {
        sequence: 2,
        startedAt: 1_700_000_001_000,
        outcome: 'failure',
        failureCategory: 'http',
        httpStatus: 503,
        ttftMs: null,
        endToEndMs: 240,
        outputTokens: null,
        tokenCountSource: null,
        tpotMs: null,
      },
    ],
  }
  const active: SpeedTestActiveRun = {
    runId: 'run-1',
    providerId: 'p1',
    providerDisplayName: 'Example',
    protocolType: 'openai',
    apiDialect: 'chat',
    model: 'gpt-x',
    plannedCount: 10,
    completedCount: 3,
    successCount: 3,
    failureCount: 0,
    startedAt: 1_700_000_000_000,
    state: 'running',
  }

  it('accepts every client action, carrying no endpoint, credential or dialect', () => {
    const messages: ClientToServer[] = [
      {
        type: 'model_provider_speed_test',
        requestId: 'q1',
        action: 'start',
        providerId: 'p1',
        protocolType: 'openai',
        model: 'gpt-x',
        requestCount: 10,
      },
      { type: 'model_provider_speed_test', requestId: 'q2', action: 'interrupt', runId: 'run-1' },
      { type: 'model_provider_speed_test', requestId: 'q3', action: 'active', providerId: 'p1' },
      { type: 'model_provider_speed_test', requestId: 'q4', action: 'retry_save', runId: 'run-1' },
      {
        type: 'model_provider_speed_test',
        requestId: 'q5',
        action: 'list',
        providerId: 'p1',
        offset: 20,
      },
      { type: 'model_provider_speed_test', requestId: 'q6', action: 'detail', runId: 'run-1' },
      { type: 'model_provider_speed_test', requestId: 'q7', action: 'history_providers' },
    ]
    expect(JSON.parse(JSON.stringify(messages))).toEqual(messages)

    // The target is never named by the client: a start that could carry a URL or
    // a key would be a way to aim the account credential at an arbitrary host.
    type Start = Extract<ClientToServer, { type: 'model_provider_speed_test'; action: 'start' }>
    const start: Start = {
      type: 'model_provider_speed_test',
      requestId: 'q8',
      action: 'start',
      providerId: 'p1',
      protocolType: 'openai',
      model: 'gpt-x',
      requestCount: 1,
    }
    expect(JSON.parse(JSON.stringify(start))).toEqual(start)
    // Spelled out rather than inferred: a field quietly added here is exactly the
    // kind of widening this test exists to catch.
    expect(Object.keys(start).sort()).toEqual([
      'action',
      'model',
      'protocolType',
      'providerId',
      'requestCount',
      'requestId',
      'type',
    ])
    // @ts-expect-error a start has no endpoint field to aim at another host
    const endpoint: Start['url'] = 'https://evil.example/v1'
    expect(endpoint).toBe('https://evil.example/v1')
  })

  it('accepts every server event and survives the wire unchanged', () => {
    const frames: ServerToClient[] = [
      { type: 'model_provider_speed_test_result', requestId: 'q1', event: 'accepted', run: active },
      // Progress is unsolicited, so it carries no requestId to correlate.
      { type: 'model_provider_speed_test_result', event: 'progress', run: active },
      { type: 'model_provider_speed_test_result', event: 'finished', detail },
      {
        type: 'model_provider_speed_test_result',
        requestId: 'q3',
        event: 'active',
        providerId: 'p1',
        run: null,
      },
      {
        type: 'model_provider_speed_test_result',
        requestId: 'q5',
        event: 'list',
        page: { providerId: 'p1', runs: [run], hasMore: true },
      },
      { type: 'model_provider_speed_test_result', requestId: 'q6', event: 'detail', detail },
      {
        type: 'model_provider_speed_test_result',
        requestId: 'q7',
        event: 'history_providers',
        providers: [
          {
            providerId: 'p1',
            displayName: 'Example',
            runCount: 3,
            lastStartedAt: 1,
            present: true,
          },
          // A provider that no longer exists stays listed — dropping it is what
          // would make its history unreachable.
          {
            providerId: 'gone',
            displayName: 'Removed',
            runCount: 1,
            lastStartedAt: 0,
            present: false,
          },
        ],
      },
      // A refusal names a reason and nothing else — no upstream body is forwarded.
      // A `save_failed` carries the held run as the SAME snapshot `active` answers
      // with, so a console that missed the frame can rebuild the retry from
      // `active` instead of remembering this one.
      {
        type: 'model_provider_speed_test_result',
        requestId: 'q9',
        event: 'error',
        code: 'save_failed',
        runId: 'run-1',
        run: { ...active, state: 'save_failed' },
      },
    ]
    expect(JSON.parse(JSON.stringify(frames))).toEqual(frames)
  })

  it('pins the refusal codes the console localizes', () => {
    const codes: SpeedTestErrorCode[] = [
      'invalid_count',
      'provider_unknown',
      'protocol_unavailable',
      'invalid_url',
      'models_empty',
      'model_unavailable',
      'busy',
      'not_found',
      'db_unavailable',
      'save_failed',
    ]
    const categories = codes.map((code) => SPEED_TEST_ERROR_CATEGORIES[code])
    expect(categories).toEqual([
      'validation',
      'validation',
      'validation',
      'validation',
      'validation',
      'validation',
      'conflict',
      'not_found',
      'storage',
      'storage',
    ])
  })

  it('keeps the request-count bound and the calibration constants in one place', () => {
    expect(SPEED_TEST_MIN_REQUESTS).toBe(1)
    expect(SPEED_TEST_MAX_REQUESTS).toBe(100)
    expect(SPEED_TEST_DEFAULT_REQUESTS).toBe(10)
    expect(SPEED_TEST_MAX_OUTPUT_TOKENS).toBe(128)
    expect(SPEED_TEST_TEMPERATURE).toBe(0)
    expect(SPEED_TEST_REQUEST_TIMEOUT_MS).toBe(60_000)
    expect(SPEED_TEST_HISTORY_PAGE_SIZE).toBe(20)
  })
})
