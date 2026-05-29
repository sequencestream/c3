/**
 * WebSocket wire protocol shared between server and web.
 * Path: /ws
 */

/**
 * Permission modes the c3 UI can switch between. These are a subset of the
 * Agent SDK's `PermissionMode` union, all valid values to pass to `query()`'s
 * `permissionMode` option and `setPermissionMode()`.
 */
export type PermissionMode = 'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'

// Client → Server
export type ClientToServer =
  | { type: 'user_prompt'; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'set_mode'; mode: PermissionMode }
  | { type: 'ping' }

// Server → Client
export type ServerToClient =
  | { type: 'ready'; mode: PermissionMode }
  | { type: 'mode_changed'; mode: PermissionMode }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'permission_request'; requestId: string; toolName: string; input: unknown }
  | { type: 'session_end'; reason: 'complete' | 'error'; error?: string }
  | { type: 'pong' }
  | { type: 'echo'; text: string }
