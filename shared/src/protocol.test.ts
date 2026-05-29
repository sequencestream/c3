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
    { type: 'ping' },
  ]

  const serverMessages: ServerToClient[] = [
    { type: 'ready', workspaces: [], activeSessionId: null },
    {
      type: 'workspaces',
      workspaces: [{ path: '/abs/proj', name: 'proj', lastAccessed: 1 }],
    },
    {
      type: 'sessions',
      workspacePath: '/abs/proj',
      sessions: [{ sessionId: 's1', title: 't', lastModified: 2, mode: 'default' }],
    },
    {
      type: 'session_selected',
      workspacePath: '/abs/proj',
      sessionId: 's1',
      title: 't',
      mode: 'plan',
      history: [{ kind: 'user', text: 'hi' }],
    },
    { type: 'session_started', clientId: 'pending:1', sessionId: 's1' },
    { type: 'mode_changed', mode: 'acceptEdits' },
    { type: 'assistant_text', text: 'hi' },
    { type: 'tool_use', toolUseId: 't1', toolName: 'Bash', input: { command: 'ls' } },
    { type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false },
    { type: 'permission_request', requestId: 'r1', toolName: 'Write', input: {} },
    { type: 'session_end', reason: 'complete' },
    { type: 'session_end', reason: 'error', error: 'boom' },
    { type: 'error', message: 'bad path' },
    { type: 'pong' },
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
