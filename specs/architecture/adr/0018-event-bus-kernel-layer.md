# 0018 — In-Process Event Bus in the Kernel Layer

- **Status:** accepted
- **Date:** 2026-06-07

## Context

c3 had no generic publish/subscribe event mechanism. Communication between features relied on:

- **Dedicated point-to-point hooks**: `onStatusChange`, `onSessionId`, `onTeam`, `onDegradableError`,
  etc. — each a single-purpose callback wired at the composition root, one per event.
- **Single broadcast exit**: the `transport/Broadcaster.toAll` + `wiring/broadcasts.ts` set of named
  `broadcast*` closures, each hard-wired to a specific WebSocket frame.
- **`RunDomainEvent` via `LaunchCbs.onEvent`**: the only "domain event" seed — a sealed union
  (`bound`/`settled`) threaded through a single per-call callback on `launchRun`. It was the first
  step toward a generic event stream but remained a callback, not a bus.

This meant that two features that wanted to react to the same kernel event (e.g. a session binding)
could not do so through a neutral channel — each had to inject its own callback at the `launchRun`
call site via `onEvent`, tightly coupling the launcher to the scope of its consumer.

The run-lifecycle events (`bound`/`settled`) had exactly **5** consumers across `features/intents`,
`features/sessions`, and `wiring/dev-turn`, each passing a closure with per-connection state
(`conn`, `rt`, `devRt`, etc.) through the same callback. Adding a new lifecycle event meant either
extending the sealed union and updating every consumer's exhaustive switch, or adding yet another
dedicated callback.

## Options considered

### 1. Keep point-to-point callbacks

_Status quo._ Each new cross-feature event gets a new dedicated hook. The composition root grows
one more wiring line per hook.

_Con:_ linear growth of composition-root wiring; no type-level contract between producer and
consumer beyond the hook's own signature; a consumer that needs two events registers two hooks.

### 2. Extend the `RunDomainEvent` sealed-union bus without middleware

_Keep `onEvent` but promote it from a per-launch callback to a kernel-wide event stream._ The
launcher publishes to a shared bus; consumers subscribe.

_Pro:_ minimal diff from the current shape — the sealed union is already typed. Single change of
transport mechanism (callback → bus).

_Con:_ a sealed union switch (the consumer pattern) scatters event handling inside a single
function; a subscriber interested only in `bound` must still match `settled` in the default branch.
Adding a new event still touches every consumer.

### 3. Topic-based event bus with typed map (chosen)

_Each topic has its own payload type._ A consumer subscribes only to the topics it needs.
`publish(topic, payload)` is statically checked. New topics extend the event map interface without
touching existing subscribers.

_Pro:_ consumer code is focused (one handler per topic); the event map is a single extensible
interface; `subscribe` returns a typed handler with zero boilerplate; `unsubscribe` via a dispose
function is explicit and testable.

### 4. Microtask-async dispatch

_Deliver events on a microtask (via `queueMicrotask` or `Promise.resolve().then`)._ Producers never
block on consumers.

_Con:_ ordering between microtasks is non-deterministic from the producer's perspective; a
`launchRun` producer that needs `settled` side effects (e.g. session-list broadcast) to complete
before `launchRun` returns cannot rely on microtask ordering without an explicit barrier. Error
stack traces are fragmented across microtasks.

## Decision

Adopt **option 3**: a synchronous, in-order, error-isolated topic-based event bus in
`server/src/kernel/events/`.

### Key characteristics

| Aspect              | Decision                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dispatch**        | Synchronous, in subscriber-registration order. `publish()` returns `void`.                                                                   |
| **Error isolation** | Every handler is try/catch-wrapped. A throw is caught and logged; it does NOT stop subsequent handlers or propagate to `publish()`.          |
| **Async handlers**  | Fire-and-forget. If a handler returns a Promise, the bus catches unhandled rejections but does NOT await.                                    |
| **Cleanup**         | `subscribe()` returns a `() => void` dispose function. Per-launch subscriptions must be disposed after the `settled` event to prevent leaks. |
| **Type safety**     | The event map (`EventBusEvents` interface) maps topic to payload type. `publish` and `subscribe` are statically checked against it.          |
| **Location**        | `server/src/kernel/events/event-bus.ts` (module). Self-contained — no import of `features/` or `transport/` (ADR-0009 R1).                   |

### Event bus surface area

```ts
interface EventBusEvents {
  'run:bound': { prevId: string; realId: string }
  'run:settled': { workspacePath: string }
  // Degradation-chain event-化 bypass (2026-06-08, see agent-session AS-R25):
  'agent:error': {
    sessionId: string
    workspacePath: string
    agentId: string
    agentName: string
    error: string
    degradable: boolean
  }
  'agent:fallback': {
    sessionId: string
    workspacePath: string
    fromAgentId: string
    fromAgentName: string
    toAgentId: string
    toAgentName: string
  }
  'agent:all_failed': {
    sessionId: string
    workspacePath: string
    agents: ReadonlyArray<{ agentId: string; agentName: string; error: string }>
    crossVendorSkipped?: ReadonlyArray<{ agentId: string; agentName: string; vendor: VendorId }>
  }
}

class EventBus<T = EventBusEvents> {
  publish<K extends keyof T>(topic: K, payload: T[K]): void
  subscribe<K extends keyof T>(topic: K, handler: (payload: T[K]) => void): () => void
  clear(): void
}
```

### Retrofit: `RunDomainEvent` → bus topics

| Old `RunDomainEvent.kind` | New bus topic   | Payload              |
| ------------------------- | --------------- | -------------------- |
| `bound`                   | `'run:bound'`   | `{ prevId, realId }` |
| `settled`                 | `'run:settled'` | `{ workspacePath }`  |

The old `LaunchCbs.onEvent` callback is removed. All 5 consumers now subscribe via
`ctx.eventBus.subscribe(...)` or `launchDeps.eventBus.subscribe(...)`.

### Consumer subscription lifecycle

Each consumer subscribes **before** calling `launchRun`. Because published events are synchronous
and fire during the `await launchRun(...)` call (inside the SDK callback for `bound`, or in the
`finally` block for `settled`), the subscription is guaranteed to be active when the event fires.

**Cleanup pattern** (both `bound` and `settled`):

```
dispose both in the `settled` handler
+ safety-net cleanup in a `finally` block around `launchRun`
```

**Bound-only pattern**:

```
auto-dispose inside the `bound` handler
+ safety-net cleanup in a `finally` block around `launchRun`
```

### The bus on `KernelContext`

The EventBus instance is constructed once at startup (`server.ts`, composition root) and added to:

1. `KernelContext.eventBus` — for feature handlers to subscribe.
2. `LaunchRunDeps.eventBus` — for the `launchRun` and `runViaDriver` launchers to publish.

Both reference the **same** bus instance, so subscribers registered from KernelContext receive
events published from LaunchRunDeps.

## Consequences

- **Easier:** adding a new lifecycle event (e.g. `'run:agent-failed'`, `'run:team-upgraded'`) is one
  line in `EventBusEvents` + one `publish()` call in the launcher. Existing subscribers are
  untouched. **Realized (2026-06-08):** the degradation-chain event-化 (`agent:error` /
  `agent:fallback` / `agent:all_failed`, agent-session AS-R25) followed exactly this path — three
  topic lines + three thin `publish()` bypass calls in `launchRun`, zero change to the chain's
  control flow, FSM, or wire frames; every existing contract test stayed green.
- **Easier:** a feature that needs to react to `'run:bound'` (e.g. to update the sidebar when a
  session binds) subscribes at registration time — no composition-root wiring change.
- **Harder:** subscriptions are manual; a per-launch handler that forgets to dispose leaks a
  listener on the bus. The convention is: dispose in the `settled` handler; also dispose in a
  `finally` block after `launchRun`.
- **Zero policy change:** the production code, test assertions, and contract-test behavior are
  byte-for-byte identical with the old `onEvent` path. Only the transport mechanism changed.
- **Testability:** the bus is a plain class with no I/O — `publish`/`subscribe`/`dispose` are all
  unit-testable without mocks. The 19 dedicated event-bus tests cover error isolation, ordering,
  type safety (compile-time), and lifecycle.

## Compliance

- `pnpm typecheck` is green.
- `pnpm lint` is green.
- `pnpm vitest run` is green (130 files, 1588 tests).
- EventBus unit tests (19 tests in `server/src/kernel/events/event-bus.test.ts`) cover:
  - publish/subscribe/unsubscribe (7 tests)
  - error isolation (4 tests)
  - clear (2 tests)
  - type safety (compile-time assertions, 4 tests)
  - RunDomainEvent parity (2 tests)
- Contract tests (5 files) remain green — `launchRun` lifecycle behavior is unchanged.
- `server/src/kernel/` has no new import from `features/` or `transport/` (ADR-0009 R1).

## References

- [ADR 0009](0009-unidirectional-boundaries.md) — kernel/transport/features boundaries. This bus
  lives in `kernel/` and must not import `features/` or `transport/`.
- [EventBus source](../../../server/src/kernel/events/event-bus.ts) — class definition.
- [Architecture overview](../architecture.md) — system shape and module map.
- [ADR conventions](adr.md) — naming, numbering, index.
