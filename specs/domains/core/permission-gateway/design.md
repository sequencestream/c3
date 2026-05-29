# permission-gateway — Design

Implements the [spec](spec.md). Lives in `server/src/permissions.ts` (registry) and
`server/src/claude.ts` (the `canUseTool` callback, which passes the run's `AbortSignal`).

## Data model

In-memory only, scoped to the server process:

| Structure          | Type                                                 | Purpose                                      |
| ------------------ | ---------------------------------------------------- | -------------------------------------------- |
| `pendingApprovals` | `Map<requestId: text, resolver: (Decision) => void>` | One entry per Pending request (PG-R1, PG-R2) |
| `Decision`         | enum `allow` \| `deny`                               | Outcome value                                |

## Decision flow

```mermaid
sequenceDiagram
    participant SDK
    participant GW as canUseTool (claude.ts)
    participant REG as registry (permissions.ts)
    participant WS as WebSocket
    participant UI as browser

    SDK->>GW: canUseTool(toolName, input)
    GW->>GW: requestId = randomUUID()
    GW->>WS: send permission_request{requestId,toolName,input}
    GW->>REG: waitForDecision(requestId, signal)  (Promise)
    REG->>REG: signal.addEventListener('abort' → delete entry, resolve 'deny')
    REG->>REG: pendingApprovals.set(requestId, resolver)
    Note over REG: blocks indefinitely — no timeout
    UI->>WS: permission_response{requestId, decision}
    WS->>REG: resolveDecision(requestId, decision)
    REG->>REG: remove abort listener; delete entry; resolve(decision)
    REG-->>GW: decision
    alt allow
        GW-->>SDK: {behavior:'allow', updatedInput: input}
    else deny / abort
        GW-->>SDK: {behavior:'deny', message:'User denied in c3 UI'}
    end
```

## Key functions

| Function                                                 | Contract                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waitForDecision(requestId, signal?): Promise<Decision>` | Registers a resolver and returns a promise that resolves with the decision. Never resolves on its own — it blocks until `resolveDecision`, or until `signal` aborts (deletes entry, resolves `'deny'`). Exactly one resolution. Implements PG-R2, PG-R3, PG-R4. |
| `resolveDecision(requestId, decision): boolean`          | Resolves a pending request. Returns `false` for an unknown/stale id and does nothing (PG-R5).                                                                                                                                                                   |
| `pendingCount(): number`                                 | In-flight request count; for tests/diagnostics.                                                                                                                                                                                                                 |

## Technology choices

- **Promise + `AbortSignal`** rather than a scheduler/queue: the gateway only ever holds a
  small number of concurrent requests for one local user. The request blocks indefinitely
  (like the CLI prompt); the run's abort signal is the only non-user resolution path.
  Rationale recorded informally; no ADR needed.
- **`crypto.randomUUID()`** for `requestId` — collision-free correlation key.
- **Dependency-free registry.** `permissions.ts` imports no SDK code so it is unit-testable
  in isolation.
- **`updatedInput: input`** on allow — the gateway returns the original input unchanged
  (PG-R6); it is not an input-rewriting layer.

## Non-functional considerations

- **Latency:** the only added wait is the human decision — unbounded by design, mirroring
  the CLI's blocking prompt (PERF-2).
- **Safety:** default-deny on abort and on stale ids (SEC-5); no input mutation.
- **Memory:** every resolution path deletes the map entry and removes the abort listener —
  no leak of pending entries or listeners, even when a run is aborted mid-prompt.

## Dependencies

- **Inbound:** `agent-session` calls the callback and provides the `send` channel.
- **Outbound:** none beyond `node:crypto`. Degradation: if `send` fails the request stays
  pending until the user aborts the run (which resolves it as `deny`).
