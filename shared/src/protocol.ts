/**
 * WebSocket wire protocol shared between server and web.
 * Path: /ws
 */

// Client → Server
export type ClientToServer =
  | { type: 'user_prompt'; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'ping' }

// Server → Client
export type ServerToClient =
  | { type: 'ready' }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; input: unknown }
  | { type: 'session_end'; reason: 'complete' | 'error'; error?: string }
  | { type: 'pong' }
  | { type: 'echo'; text: string }
