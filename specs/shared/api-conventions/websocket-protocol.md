# WebSocket Protocol

The single wire contract between browser and server. Endpoint: `ws://<host>/ws`
(`wss://` when the page is HTTPS). All traffic is JSON envelopes with a `type` discriminant.

**Source of truth:** `shared/src/protocol.ts`. This document describes that file; it does
not redefine shapes. Both ends import the same types (`@ccc/shared`).

## Conventions

- Every message is a JSON object with a string `type` field; consumers narrow on `type`.
- The server ignores any client message it cannot parse or whose `type` it does not
  recognize — an unparseable message is **never** treated as a permission approval.
- Correlation is by `requestId`: a `permission_request` carries one; the matching
  `permission_response` echoes it.

## Client → Server (`ClientToServer`)

| type                  | fields                                             | meaning                                                                                                                     |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `user_prompt`         | `text: string`                                     | New user turn. Aborts any in-flight run, then starts a new agent run.                                                       |
| `permission_response` | `requestId: string`, `decision: 'allow' \| 'deny'` | Answer to a prior `permission_request`.                                                                                     |
| `set_mode`            | `mode: PermissionMode`                             | Change permission mode. Applies to the live run immediately if one is in flight; otherwise takes effect on the next prompt. |
| `ping`                | —                                                  | Keepalive.                                                                                                                  |

## Server → Client (`ServerToClient`)

| type                 | fields                                             | meaning                                                                                             |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ready`              | `mode: PermissionMode`                             | Handshake complete; carries the current mode.                                                       |
| `mode_changed`       | `mode: PermissionMode`                             | Confirms a mode change.                                                                             |
| `assistant_text`     | `text: string`                                     | A streamed text block from the model.                                                               |
| `tool_use`           | `toolUseId`, `toolName`, `input: unknown`          | Model is calling a tool (already authorized when this fires).                                       |
| `tool_result`        | `toolUseId`, `content: string`, `isError: boolean` | A tool finished; `content` is the flattened display string.                                         |
| `permission_request` | `requestId`, `toolName`, `input: unknown`          | **Block point** — the run waits until a `permission_response` arrives (or the timeout auto-denies). |
| `session_end`        | `reason: 'complete' \| 'error'`, `error?: string`  | The agent run ended.                                                                                |
| `pong`               | —                                                  | Reply to `ping`.                                                                                    |
| `echo`               | `text: string`                                     | Diagnostic echo.                                                                                    |

## PermissionMode

`'default' | 'auto' | 'plan' | 'acceptEdits' | 'bypassPermissions'` — a subset of the SDK's
`PermissionMode`, valid for both the `query()` `permissionMode` option and
`setPermissionMode()`. See the [agent-session spec](../../domains/core/agent-session/spec.md)
for what each mode means for tool gating.

## Notes

- There is no message acknowledging `user_prompt` directly; the run's first
  `assistant_text` / `tool_use` / `permission_request` is the observable start, and
  `session_end` is the observable end.
- The browser sends optimistic UI updates for `set_mode` and confirms on `mode_changed`.
