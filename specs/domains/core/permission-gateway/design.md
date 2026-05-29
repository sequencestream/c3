# permission-gateway — Design

Implements the [spec](spec.md). Lives in `server/src/permissions.ts` (registry, timeout)
and `server/src/claude.ts` (the `canUseTool` callback).

## Data model

In-memory only, scoped to the server process:

| Structure               | Type                                                 | Purpose                                      |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `pendingApprovals`      | `Map<requestId: text, resolver: (Decision) => void>` | One entry per Pending request (PG-R1, PG-R2) |
| `Decision`              | enum `allow` \| `deny`                               | Outcome value                                |
| `PERMISSION_TIMEOUT_MS` | number = `60_000`                                    | Auto-deny window (PG-R4)                     |

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
    GW->>REG: waitForDecision(requestId)  (Promise)
    REG->>REG: setTimeout(60s → resolve 'deny', delete entry)
    REG->>REG: pendingApprovals.set(requestId, resolver)
    UI->>WS: permission_response{requestId, decision}
    WS->>REG: resolveDecision(requestId, decision)
    REG->>REG: clearTimeout; delete entry; resolve(decision)
    REG-->>GW: decision
    alt allow
        GW-->>SDK: {behavior:'allow', updatedInput: input}
    else deny / timeout
        GW-->>SDK: {behavior:'deny', message:'User denied in c3 UI'}
    end
```

## Key functions

| Function                                                            | Contract                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `waitForDecision(requestId, timeoutMs = 60_000): Promise<Decision>` | Registers a resolver and returns a promise that resolves with the decision, or `'deny'` on timeout. Exactly one resolution (clears timer + deletes entry). Implements PG-R2, PG-R3, PG-R4. |
| `resolveDecision(requestId, decision): boolean`                     | Resolves a pending request. Returns `false` for an unknown/stale id and does nothing (PG-R5).                                                                                              |
| `pendingCount(): number`                                            | In-flight request count; for tests/diagnostics.                                                                                                                                            |

## Technology choices

- **Promise + `setTimeout`** rather than a scheduler/queue: the gateway only ever holds a
  small number of concurrent requests for one local user. Rationale recorded informally;
  no ADR needed.
- **`crypto.randomUUID()`** for `requestId` — collision-free correlation key.
- **Dependency-free registry.** `permissions.ts` imports no SDK code so it is unit-testable
  in isolation.
- **`updatedInput: input`** on allow — the gateway returns the original input unchanged
  (PG-R6); it is not an input-rewriting layer.

## Non-functional considerations

- **Latency:** the only added wait is the human decision, bounded at 60 s (PERF-2).
- **Safety:** default-deny on timeout and on stale ids (SEC-5); no input mutation.
- **Memory:** every resolution path deletes the map entry and clears the timer — no leak
  of pending entries or timers.

## Dependencies

- **Inbound:** `agent-session` calls the callback and provides the `send` channel.
- **Outbound:** none beyond `node:crypto`. Degradation: if `send` fails the request will
  simply time out and auto-deny.
