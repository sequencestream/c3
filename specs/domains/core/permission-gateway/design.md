# permission-gateway — Design

Implements the [spec](spec.md). A registry of pending decisions, plus the sensitive-tool callback
that raises requests and passes the run's cancellation signal.

## Data model

In-memory only, scoped to the server process:

| Structure         | Shape                                         | Purpose                                      |
| ----------------- | --------------------------------------------- | -------------------------------------------- |
| Pending approvals | a map from `requestId` to a one-shot resolver | One entry per Pending request (PG-R1, PG-R2) |
| Decision          | `allow` \| `deny`                             | Outcome value                                |

## Decision flow

```mermaid
sequenceDiagram
    participant SDK
    participant GW as sensitive-tool callback
    participant REG as pending registry
    participant WS as WebSocket
    participant UI as browser

    SDK->>GW: tool wants to run (toolName, input)
    GW->>GW: mint a unique requestId
    GW->>WS: send permission_request{requestId,toolName,input}
    GW->>REG: wait for decision (requestId, cancellation signal)
    REG->>REG: on abort → delete entry, resolve as deny
    REG->>REG: register the pending resolver under requestId
    Note over REG: blocks indefinitely — no timeout
    UI->>WS: permission_response{requestId, decision}
    WS->>REG: resolve the pending decision
    REG->>REG: remove abort listener; delete entry; resolve(decision)
    REG-->>GW: decision
    alt allow
        GW-->>SDK: allow with the original, unchanged input
    else deny / abort
        GW-->>SDK: deny with message "User denied in c3 UI"
    end
```

## Key capabilities

| Capability          | Contract                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wait for a decision | Registers a resolver and returns a promise that resolves with the decision. Never resolves on its own — it blocks until the matching response arrives, or until the cancellation signal aborts (deletes entry, resolves as deny). Exactly one resolution. Implements PG-R2, PG-R3, PG-R4. |
| Resolve a decision  | Resolves a pending request. A no-op for an unknown/stale id (PG-R5).                                                                                                                                                                                                                      |
| Pending count       | In-flight request count; for tests/diagnostics.                                                                                                                                                                                                                                           |

## Technology choices

- **A blocking promise plus a cancellation signal** rather than a scheduler/queue: the gateway
  only ever holds a small number of concurrent requests for one local user. The request blocks
  indefinitely (like the CLI prompt); the run's abort signal is the only non-user resolution path.
  Rationale recorded informally; no ADR needed.
- **A cryptographically random UUID** for the request id — a collision-free correlation key.
- **Dependency-free registry.** The registry imports no SDK code so it is unit-testable in isolation.
- **Original input on allow** — the gateway returns the proposed input unchanged (PG-R6); it is not
  an input-rewriting layer.

## Non-functional considerations

- **Latency:** the only added wait is the human decision — unbounded by design, mirroring
  the CLI's blocking prompt (PERF-2).
- **Safety:** default-deny on abort and on stale ids (SEC-5); no input mutation.
- **Memory:** every resolution path deletes the map entry and removes the abort listener —
  no leak of pending entries or listeners, even when a run is aborted mid-prompt.

## Dependencies

- **Inbound:** agent-session calls the callback and provides the send channel.
- **Outbound:** none beyond the platform's crypto source. Degradation: if the send fails the request
  stays pending until the user aborts the run (which resolves it as deny).
