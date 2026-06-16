# 0018 — In-Process Event Bus in the Kernel Layer

- **Status:** accepted
- **Date:** 2026-06-07

## Context

c3 had no generic publish/subscribe event mechanism. Communication between features relied on:

- **Dedicated point-to-point hooks**: one single-purpose callback per event (status change, session
  id, team, degradable error, etc.), each wired at the composition root.
- **Single broadcast exit**: a set of named broadcast closures in the transport/wiring layer, each
  hard-wired to a specific WebSocket frame.
- **The run-domain event via a per-launch callback**: the only "domain event" seed — a sealed union
  (bound/settled) threaded through a single per-call callback on the run launcher. It was the first
  step toward a generic event stream but remained a callback, not a bus.

This meant that two features that wanted to react to the same kernel event (e.g. a session binding)
could not do so through a neutral channel — each had to inject its own callback at the launcher's
call site, tightly coupling the launcher to the scope of its consumer.

The run-lifecycle events (bound/settled) had exactly **5** consumers across the intents feature, the
works feature, and the dev-turn wiring, each passing a closure with per-connection state through the
same callback. Adding a new lifecycle event meant either extending the sealed union and updating
every consumer's exhaustive switch, or adding yet another dedicated callback.

## Options considered

### 1. Keep point-to-point callbacks

_Status quo._ Each new cross-feature event gets a new dedicated hook. The composition root grows
one more wiring line per hook.

_Con:_ linear growth of composition-root wiring; no type-level contract between producer and
consumer beyond the hook's own signature; a consumer that needs two events registers two hooks.

### 2. Extend the run-domain sealed-union bus without middleware

_Keep the existing callback but promote it from a per-launch callback to a kernel-wide event stream._
The launcher publishes to a shared bus; consumers subscribe.

_Pro:_ minimal diff from the current shape — the sealed union is already typed. Single change of
transport mechanism (callback → bus).

_Con:_ a sealed union switch (the consumer pattern) scatters event handling inside a single
function; a subscriber interested only in `bound` must still match `settled` in the default branch.
Adding a new event still touches every consumer.

### 3. Topic-based event bus with typed map (chosen)

_Each topic has its own payload type._ A consumer subscribes only to the topics it needs.
Publishing is statically checked against the topic's payload type. New topics extend the event map
without touching existing subscribers.

_Pro:_ consumer code is focused (one handler per topic); the event map is a single extensible
contract; subscribing returns a typed handler with zero boilerplate; unsubscribing via a dispose
function is explicit and testable.

### 4. Microtask-async dispatch

_Deliver events on a microtask._ Producers never block on consumers.

_Con:_ ordering between microtasks is non-deterministic from the producer's perspective; a
launcher that needs settled side effects (e.g. session-list broadcast) to complete
before it returns cannot rely on microtask ordering without an explicit barrier. Error
stack traces are fragmented across microtasks.

## Decision

Adopt **option 3**: a synchronous, in-order, error-isolated topic-based event bus in the kernel
layer.

### Key characteristics

| Aspect              | Decision                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Dispatch**        | Synchronous, in subscriber-registration order. Publishing returns nothing.                                                            |
| **Error isolation** | Every handler is try/catch-wrapped. A throw is caught and logged; it does NOT stop subsequent handlers or propagate to the publisher. |
| **Async handlers**  | Fire-and-forget. If a handler returns a promise, the bus catches unhandled rejections but does NOT await.                             |
| **Cleanup**         | Subscribing returns a dispose function. Per-launch subscriptions must be disposed after the settled event to prevent leaks.           |
| **Type safety**     | The event map maps each topic to its payload type. Publish and subscribe are statically checked against it.                           |
| **Location**        | A self-contained kernel module — no import of the features or transport layers (ADR-0009 R1).                                         |

### Event bus surface area

The bus exposes a typed event map and three operations:

- A set of run-lifecycle topics (2026-06-08): every payload carries enough run identity for a
  domain listener to match without a side lookup. The run-started and run-settled topics carry the
  session id + workspace; the run-bound topic carries the previous id, real id, and workspace.
  Run-settled also carries the run-end reason. Each carries the unified run kind (see below).
- A set of degradation-chain topics (2026-06-08, see agent-session AS-R25): an agent-error topic
  (session id, workspace, the failing agent's id + name, error, and a degradable flag), an
  agent-fallback topic (session id, workspace, the from/to agent ids + names), and an
  agent-all-failed topic (session id, workspace, the list of attempted agents with their errors, and
  an optional list of cross-vendor agents that were skipped with their vendor).

The three operations are: publish a payload to a topic (statically checked); subscribe a handler to a
topic, returning a dispose function; and clear all subscriptions.

### RunKind taxonomy (2026-06-08)

The run kind carried by run-started/run-settled (and threaded through the session runtime) is the
single source-of-truth run-kind enumeration, defined in the shared protocol definitions. It replaces
the old two-value normal/intent session kind so listeners can route by run origin instead of
collapsing six distinct sources into two:

| RunKind      | Origin                                                                             |
| ------------ | ---------------------------------------------------------------------------------- |
| `session`    | general dev session (user console, intent→dev hand-off, dev-turn). Was `'normal'`. |
| `intent`     | read-only intent-communication session.                                            |
| `discussion` | discussion orchestrator + its research pass.                                       |
| `schedule`   | a run launched by the scheduler **with no socket** (e.g. an `llm` task).           |
| `consensus`  | a consensus vote.                                                                  |
| `tool`       | an internal tool call: completion judging (judge) + title derivation.              |

**`schedule` is a trigger source, not a run type a session morphs into.** An
event-triggered schedule fires off a run-started/run-settled whose kind is
`session` (a user/dev run) — the scheduler reacts to that. `schedule` only tags
the scheduler's _own_ socket-less run. Event-triggered schedules therefore filter
on the `session` kind (migrated verbatim from the old `normal`-kind guard;
semantics unchanged).

Today `session`, `intent`, `discussion`, and `schedule` flow through the run bus.

- `session`/`intent` via a session runtime (the run-launcher path; `intent` was the
  first non-`session` kind, 2026-06-08).
- `discussion` via the discussion run starters, which publish run-started/run-bound/
  run-settled with the `discussion` kind around the research and orchestrator calls
  without creating a session runtime (2026-06-08-010).
- `schedule` via the scheduler's dispatch-and-track step, which publishes
  run-started/run-bound/run-settled with the `schedule` kind around each scheduled
  execution (2026-06-08-010).

The remaining two (`consensus`, `tool`) still tag socket-less internal invocations
with their run kind as a typed annotation + log tag but do NOT yet go through the
bus.

### Retrofit: run-domain callback → bus topics

| Old run-domain event kind | New bus topic | Payload                                 |
| ------------------------- | ------------- | --------------------------------------- |
| bound                     | run-bound     | previous id, real id, workspace         |
| settled                   | run-settled   | session id, workspace, reason, run kind |

The old per-launch callback is removed. All 5 consumers now subscribe through the
event bus (made available on the kernel context and the launcher's dependencies).

### Consumer subscription lifecycle (original pattern, deprecated 2026-06-08)

Each consumer subscribes **before** invoking the run launcher. Because published events are
synchronous and fire during the launch (inside the bind callback for the bound event, or in the
finalize step for the settled event), the subscription is guaranteed to be active when the event
fires.

**Cleanup pattern** (both bound and settled): dispose both subscriptions in the settled handler,
with a safety-net cleanup once the launch returns.

**Bound-only pattern**: auto-dispose inside the bound handler, with a safety-net cleanup once the
launch returns.

**⚠️ 2026-06-08: per-launch subscription is deprecated for run lifecycle.** See
[Resident domain subscriptions](#resident-domain-subscriptions-2026-06-08) below.

### Resident domain subscriptions (2026-06-08)

The per-launch subscribe/dispose pattern described above has been **replaced** by a set of
**application-lifetime, single-responsibility resident subscriptions** that are registered once
at the composition root and **never disposed**. This change addresses a concurrency bug where
a settled run would dispose its subscription AND every other pending run's subscription
(because the run topics are a global broadcast iterated in registration order), causing subsequent
run-bound events to be lost.

The resident subscriptions are registered once at the composition root, after the event bus
and broadcast closures are constructed.

**Design principles:**

| Aspect               | Decision                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Registration**     | Once at composition root; never disposed.                                                          |
| **Matching**         | Each subscription uses the event's session id / previous id to look up domain state (runtime kind, |
|                      | the intent's last dev-session id, the pending dev-link) — NOT a subscription id.                   |
| **Idempotency**      | No-ops on events that do not match the owning domain's state (e.g. a run-bound for an unknown      |
|                      | session, or a run-settled whose session id does not match any intent's last dev-session id).       |
| **Per-connection**   | The viewed-session repointing is driven by the client (echoes the view-rebind message on receiving |
|                      | the broadcast session-started when its active session matches the client id). No per-launch sub.   |
| **Schedule trigger** | The existing schedule-dispatch subscription was always resident (the model template). Its run-kind |
|                      | filter changed from "not session" to an explicit whitelist of the `session` kind for testability.  |

**Four resident subscriptions (2026-06-08-010 adds discussion + schedule):**

1. **Run-bound (intent-session + session/dev domain):**
   - Obtains the session runtime via the real id, falling back to the previous id.
   - If the kind is `intent` and the runtime exists under the real id (genuine pending→real path, not
     the resume edge): rebinds the chat session and broadcasts intent sessions.
   - Otherwise (session/dev): persists the action mode, checks the pending dev-link for a manual
     start-development linkage, and fans out the session-started broadcast to all connections.

2. **Run-settled (intents-automation domain):**
   - Broadcasts the session list refresh immediately.
   - For the `session` kind: scans the workspace's intents for one whose last dev-session id matches
     the settled session. If found, broadcasts the intent list and notifies the workspace's
     automation controller that the turn settled (no-op if automation is idle).

3. **Run-settled (discussion domain)** — added 2026-06-08-010:
   - Filter: the `discussion` kind.
   - Broadcasts the discussion list refresh.
   - Discussion starters publish run-started/run-bound/run-settled with the `discussion` kind; this
     subscription replaces their old per-run finalize broadcast.

4. **Run-settled (schedule domain)** — added 2026-06-08-010:
   - Filter: the `schedule` kind.
   - Broadcasts the schedule list refresh.
   - The scheduler engine publishes run-started/run-bound/run-settled with the `schedule` kind; this
     subscription replaces the old store-level broadcast.

**Automation orchestrator (event-driven FSM):**

The automation controller no longer uses an internal await loop. Instead, it is an
event-driven state machine that transitions on a turn-settled notification from the resident
subscription. The old sequential develop loop (with continuation cap) and the old
await-project-running concurrency gate were removed; their logic was absorbed into:

- a turn-result processor — async: judge → commit → next / continue / fail, triggered by
  a run-settled matching the current developing intent.
- a fix-turn-settled handler — retry commit after a lint-fix agent turn settles.
- a development launcher — determines fresh/resume/attach strategy per intent.
- a next-intent picker — picks the next eligible intent (or defers if the concurrency gate is active).
- a blocking-intent finder — the RM-A12 gate: checks if any non-automate intent's dev session is
  truly running; if yes, defers the new intent until the blocking session settles (event-driven
  analogue of the old await-project-running gate).

The concurrency gate, the continuation cap (10), lint-heal retry, and commit
sequencing are preserved — only the driving mechanism changed (event → async chain instead of
loop → await).

**Five per-launch subscription sites removed:**

| Site            | Removed subscription(s)         | Replacement                                                     |
| --------------- | ------------------------------- | --------------------------------------------------------------- |
| Works feature   | run-bound + run-settled         | Resident sub (intent-session/dev domains) + view-rebind handler |
| Intents feature | run-bound (refine intent)       | Resident run-bound (intent-kind branch)                         |
| Intents feature | run-bound (discussion → intent) | Same as above                                                   |
| Intents feature | run-bound + run-settled         | Pending dev-link + resident run-bound + run-settled             |
| Dev-turn wiring | run-bound + run-settled         | Resident subs + pending dev-link registration                   |

**New protocol message:** a view-rebind message (client→server). The client sends it from the
session-started handler when its active session matches its client id. The server handler repoints
the connection's viewed session, preserving the only truly per-connection state.

**Pending dev-link:** a minimal in-memory map (previous id → intent id)
that is the sole piece of registration state required by the resident model. It is registered by
the manual start-development handler and consumed (and deleted) by the resident run-bound
subscription. A safety-net sweep on run-settled cleans any entry whose run settled without
binding. (The automation orchestrator uses the same mechanism for fresh launches, generating
the pending id externally.)

### The bus on the kernel context

The event bus instance is constructed once at startup (the composition root) and added to:

1. the kernel context — for feature handlers to subscribe.
2. the launcher dependencies — for the run launchers to publish.

Both reference the **same** bus instance, so subscribers registered from the kernel context receive
events published from the launchers.

**2026-06-08-010 extension:** discussion and schedule runs also publish to this bus.
The discussion starters publish around each research/orchestrator run; the scheduler publishes
around each scheduled execution. Both reference the same bus instance (injected via their respective
dependencies at the composition root), so all subscribers receive discussion + schedule lifecycle
events too.

## Consequences

- **Easier:** adding a new lifecycle event (e.g. an agent-failed or team-upgraded topic) is one
  line in the event map + one publish call in the launcher. Existing subscribers are
  untouched. **Realized (2026-06-08):** the degradation-chain event-化 (the agent-error /
  agent-fallback / agent-all-failed topics, agent-session AS-R25) followed exactly this path — three
  topic lines + three thin publish bypass calls in the launcher, zero change to the chain's
  control flow, FSM, or wire frames; every existing contract test stayed green.
- **Easier:** a feature that needs to react to a run-bound (e.g. to update the sidebar when a
  session binds) subscribes at registration time — no composition-root wiring change.
- **Safer:** the resident subscription model eliminates the class of concurrency bugs where a settled
  run disposes another pending run's subscription (the original motivation). Subscriptions are never
  disposed, so there is no "wrong connection's cleanup" attack surface. The pending dev-link map is
  the only intentional registration state; it is consumed on the first run-bound and swept on settle.
- **Lighter:** the automation orchestrator's internal viewer (added viewers, removed on turn end)
  and the bus subscriptions were separate concerns that both reacted to the same lifecycle. With
  the bus subscriptions removed from the dev-turn wiring, the viewer only tracks permission requests
  and assistant text for the awaiting-permission callback — a pure runtime observation role.
- **Testability:** the bus is a plain class with no I/O — publish/subscribe/dispose are all
  unit-testable without mocks. The dedicated event-bus tests cover error isolation, ordering,
  type safety (compile-time), and lifecycle. New resident-subscription tests (2026-06-08) cover
  concurrent run scenarios, dev-link matching, and schedule run-kind whitelist filtering.
  **2026-06-08-010:** new tests cover discussion + schedule subscription dispatch, cross-kind
  isolation, and the run-started guard.

## Compliance

- Typecheck is green.
- Lint is green.
- The full test suite is green (2026-06-08-010).
- The event-bus unit tests cover:
  - publish/subscribe/unsubscribe
  - error isolation
  - clear
  - type safety (compile-time assertions)
  - run-domain parity
- Contract tests remain green — the launcher lifecycle behavior is unchanged.
- The kernel layer has no new import from the features or transport layers (ADR-0009 R1).

## References

- [ADR 0009](0009-unidirectional-boundaries.md) — kernel/transport/features boundaries. This bus
  lives in the kernel and must not import the features or transport layers.
- [Architecture overview](../architecture.md) — system shape and module map.
- [ADR conventions](adr.md) — naming, numbering, index.
