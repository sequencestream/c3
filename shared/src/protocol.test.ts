import { describe, it, expect } from 'vitest'
import type { ClientToServer, ServerToClient } from './protocol.js'

/**
 * The protocol module is types-only, so there is no runtime behavior to test.
 * These tests act as a compile-time + JSON round-trip guard: each representative
 * message must remain assignable to its union and survive JSON serialization
 * unchanged (the WS wire format).
 */
describe('protocol wire format', () => {
  const clientMessages: ClientToServer[] = [
    { type: 'user_prompt', text: 'hello' },
    { type: 'permission_response', requestId: 'r1', decision: 'allow' },
    { type: 'permission_response', requestId: 'r2', decision: 'deny' },
    { type: 'set_mode', mode: 'plan' },
    { type: 'add_workspace', path: '/abs/proj' },
    { type: 'remove_workspace', path: '/abs/proj' },
    { type: 'list_sessions', workspacePath: '/abs/proj' },
    { type: 'create_session', workspacePath: '/abs/proj' },
    { type: 'delete_session', workspacePath: '/abs/proj', sessionId: 's1' },
    { type: 'select_session', workspacePath: '/abs/proj', sessionId: 's1' },
    { type: 'rename_session', workspacePath: '/abs/proj', sessionId: 's1', title: 'New' },
    { type: 'stop_run' },
    { type: 'request_session_status' },
    { type: 'ping' },
  ]

  const serverMessages: ServerToClient[] = [
    { type: 'ready', workspaces: [], activeSessionId: null, statuses: [] },
    {
      type: 'session_status',
      statuses: [{ sessionId: 's1', status: 'awaiting_permission' }],
    },
    {
      type: 'workspaces',
      workspaces: [{ path: '/abs/proj', name: 'proj', lastAccessed: 1 }],
    },
    {
      type: 'sessions',
      workspacePath: '/abs/proj',
      sessions: [
        { sessionId: 's1', title: 't', lastModified: 2, mode: 'default', isToolSession: false },
      ],
    },
    {
      type: 'session_selected',
      workspacePath: '/abs/proj',
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
