# Non-Functional — Security

Security is c3's primary value (constitution § Mission & values). Targets here refine the
constitution's `C-SEC-*` rules into checkable expectations.

## Threat model

- **Trusted:** the local OS user running c3 and the browser on the same machine.
- **Untrusted:** anything off-host. c3 is not designed to be exposed to a network.
- **Out of scope:** protecting against a malicious local user; sandboxing the `claude`
  process; protecting the project directory contents.

## Requirements

| ID    | Requirement                                                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-1 | The server binds to `localhost` only. Binding to a non-loopback interface requires an ADR and an auth design (constitution C-SEC-5).                                               |
| SEC-2 | No persistent store, no logging of tool inputs/outputs to disk by c3. State lives in memory for the connection's lifetime only.                                                    |
| SEC-3 | The SDK runs with `settingSources: []` — no external settings, hooks, or allow-rules are inherited (C-SEC-1).                                                                      |
| SEC-4 | A sensitive tool executes only on an explicit `allow`, or under a mode the user explicitly selected that authorizes auto-execution (`acceptEdits`, `bypassPermissions`) (C-SEC-2). |
| SEC-5 | The default outcome of an unanswered or unrecognized decision is **deny** (C-SEC-3).                                                                                               |
| SEC-6 | c3 never reads, stores, or transmits Claude credentials; the `claude` CLI owns auth (C-SEC-4).                                                                                     |
| SEC-7 | Switching into `bypassPermissions` is always the result of an explicit, observable UI action; it is never set silently by c3.                                                      |

## Anti-scenarios (must never happen)

- A sensitive tool runs because a user `settings.json` allow-rule was inherited.
- A malformed WebSocket frame is interpreted as an `allow`.
- A permission request hangs forever with no resolution.
- Credentials appear in a log line, error message, or wire message.
