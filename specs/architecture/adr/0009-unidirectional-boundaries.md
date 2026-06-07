# 0009 — Unidirectional Boundaries: kernel → transport/features, transport → kernel, no back-edges

- **Status:** accepted
- **Date:** 2026-06-04

## Context

`server/src/server.ts` is now a 2060-line file that owns the WebSocket upgrade, the per-connection
viewing state, ~40 message cases in one giant `switch`, and the module-level closures that bridge
them: `launchRun`, `runDevTurn`, `startDiscussionRun`, `startResearchRun`, `broadcastStatuses`,
`broadcastIntents`, `broadcastDiscussions`, `broadcastSchedules`, `broadcastDiscussionMessage`,
`broadcastDiscussionRunStatus`, `broadcastResearchMessage`, `broadcastResearchRunStatus`,
`broadcastAutomation`, `discussionRunSnapshot`, `researchRunSnapshot`, plus `connections`,
`runStatusCache`, `judgedSessions`, `discussionRuns`, `researchRuns`, and the launch / automation
hooks. The file is the only place that knows how the SDK message stream, the persistence stores,
the session-runtime registry, the discussion / schedule subsystems, and the WebSocket protocol
fit together. A change to any one drifts all the others.

We are about to split this file along three planes:

- **kernel/** — pure domain: the session-runtime registry, settings lookup, intents /
  discussions / schedules stores, the run launcher, automation hooks. No `ws` / `Hono` / `JSON`
  knowledge, no module-level singleton for transport-owned state.
- **transport/** — WebSocket / HTTP plumbing. The handler registry (`Record<ClientToServer['type'],
Handler>`), the one-line dispatcher, the connection-side broadcaster. Consumes kernel events to
  produce wire frames.
- **features/** — one directory per top-level user action, mirroring the `ClientToServer['type']`
  union. Each feature registers exactly one (or a small, named set of) handler(s) at startup.
  Handlers receive an explicit `AppContext` and a `Conn`, not a global socket set.

For this split to be reversible one slice at a time (slice 1/3 = skeleton + zero-behavior-change
shim; slice 2/3 = real moves; slice 3/3 = kernel event bus) the boundaries between the three
planes have to be enforceable **today**, before any move. Otherwise the next slice will quietly
grow a back-edge ("just one more import from features/") that later slices cannot un-knot.

The existing ADR-0006 already pins one direction: every live event flows through `emit()` (buffer

- viewers), never straight to a socket. ADR-0009 widens that to all three layers and all
  six edge cases that have been seen — and would re-appear — during refactor.

## Options considered

1. **No ADR, rely on code review.** _Con:_ a 2060-line switch has ~40 cut-points; reviewers cannot
   police every back-edge across 40 files, and the rules are not in a place a future agent can
   consult. The first accidental `import { ws } from '...features/...'` will silently re-couple
   them. Same trap ADR-0006 was written to prevent.
2. **ADR with prose-only rules.** _Con:_ review-time only, drift inevitable. Without eslint / a
   test gate the rules become folklore.
3. **ADR with lint-enforced rules for the automatable subset, code-review + tests for the rest.**
   _Pro:_ enforceable where TypeScript + eslint can see it (cross-layer imports, file locations,
   entry sinking); explicit `assertNoTransportFields` boot-time guard for kernel events;
   review + contract tests for the semantic edges (enrich purity, mode-narrowing,
   pure-domain kernel events). _Con:_ R4/R5/R6 stay review-time in this slice. They become lint
   rules once the moves in 2/3 make them mechanically checkable.

## Decision

Adopt option 3. The three layers are `server/src/kernel/`, `server/src/transport/`,
`server/src/features/`. The boundaries are **single-direction** and codified as six rules:

| #   | Rule                                                                                                                                                                                                                                                                                             | Enforcement                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `kernel/` MUST NOT import from `features/` or `transport/`.                                                                                                                                                                                                                                      | eslint `no-restricted-imports` (glob `server/src/kernel/**`).                                                                                     |
| R2  | `kernel/` MUST NOT touch ws / HTTP semantics (`send`, `JSON.stringify`, `@hono/*`, raw `WebSocket`). `broadcast*` lives in `transport/`, which subscribes to a kernel event bus (hooked in slice 2/3; the shell exists from 1/3).                                                                | eslint `no-restricted-imports` + `no-restricted-syntax` on `server/src/kernel/**`; boot-time `assertNoTransportFields` in the AppContext factory. |
| R3  | Entry files (`server/src/cli.ts`, `server/src/server.ts`) MUST stay at `server/src/`, not sink into subdirectories. `AppContext` is constructed **once** at startup and injected, not a module-level singleton.                                                                                  | layout rule (path glob in eslint) + a single `createAppContext(...)` call site, grep-checked.                                                     |
| R4  | `enrich*` derived functions MUST be pure: read-only over their inputs, never write back to a registry, a module-level cache, or a runtime field.                                                                                                                                                 | review + dedicated unit tests; becomes a lint rule in 2/3 once the move makes it mechanically checkable.                                          |
| R5  | A new `mode` (permission mode, run `kind`, etc.) MUST NOT cross a kernel boundary as an implicit switch — every kernel function that depends on mode MUST narrow it explicitly at the call site (`if (rt.kind === 'intent') ...` in the kernel, not `if (msg.mode === 'default')` in a feature). | review + contract tests pinning the narrow; becomes a lint rule in 2/3.                                                                           |
| R6  | Kernel events (the things `emit(...)` and any future event bus carry) MUST contain only pure domain facts. No `Viewer` / `sock` / `connections` / `JSON.stringify` payload — those are transport concerns that travel downstream, not upstream.                                                  | boot-time `assertNoTransportFields(kernelEventSchema)` + the R2 eslint rule keeps the producer side clean.                                        |

The handler dispatcher is the new structural centerpiece. It is **not** itself a rule — it is the
mechanism R1 + R2 + R5 hang on:

```ts
// server/src/transport/handler-registry.ts (slice 1/3)
export type HandlerMap = { [K in ClientToServer['type']]: Handler<K> }
// Adding a new ClientToServer['type'] without adding a handler ⇒ pnpm typecheck red.
```

`server.ts`'s onMessage becomes a one-liner:

```ts
await dispatch(reg, ctx, conn, msg)
```

The old `switch (msg.type) { case 'ping': ... case 'user_prompt': ... }` body is delegated, in
this slice, to `serverHandlers[msg.type](ctx, conn, msg)` where `serverHandlers` is an exported
namespace inside the same file. **Slice 1/3 is zero behavior change**: the 40+ case bodies still
live in `server.ts`, just behind a thin dispatch. Slice 2/3 moves each body into
`features/<feature>/index.ts` and registers it via `register(reg, ...)`. The dispatcher never
sees the move — that's the point.

## Consequences

- **Easier:** every cross-layer violation is grep-checkable (`git grep "from '@ccc/server/features"`
  server/src/kernel/`should return nothing). The handler registry turns the 40-case switch into a
compile-time-complete map; new ClientToServer types are refused until registered. The`AppContext` boundary lets slice 2/3 and 3/3 move shared state out of module-level closures
  one field at a time without disturbing handlers.
- **Harder:** a feature handler that wants to "just send a status to one connection" can no longer
  reach into the kernel's `connections` set — it has to go through the transport-owned
  `Conn.send`. That is the rule, not a leak. Some one-line handlers grow a 3-line plumbing cost
  in slice 1/3 (delegation through `serverHandlers`); that is the price of the boundary.
- **Migration:** slice 1/3 ships a re-export shim (`server/src/{kernel,transport,features}/index.ts`)
  so any future import path is already valid. The `cli.ts` import line stays
  `from './server.js'`. The old `switch` is gone from the file; the old case bodies live as
  exported functions next to it. A `git revert HEAD` of slice 1/3 returns the codebase to the
  pre-slice state with all tests green (the validation step in the slice spec is exactly this).
- **Testability:** the five golden-standard contract tests (C1–C5) under
  `server/test/contracts/` assert end-to-end behavior. They are written to survive any
  implementation move; only the public contract (emit, launchRun, isStoreAvailable, etc.) is
  pinned.

## Compliance

- A `git grep` for `from '\./\(features\|transport\)'` inside `server/src/kernel/**` MUST be empty.
- A `git grep` for `@hono` / `WebSocket` / `JSON.stringify` inside `server/src/kernel/**` MUST
  be empty.
- `pnpm typecheck` MUST be green; adding a `ClientToServer['type']` without a matching
  `HandlerMap` entry MUST fail typecheck immediately.
- `pnpm test` MUST be green for the 5 contract tests (`server/test/contracts/*.contract.test.ts`)
  on every slice merge.
- `pnpm lint` MUST be green; the `no-restricted-imports` rule for `server/src/kernel/**` is the
  mechanical guard.
- Slice 1/3 ships with a "bisect anchor" commit tagged `bisect-anchor: server-refactor-1-3-foundation`
  — any future slice that breaks a contract test points bisect straight here.

## References

- [ADR 0002](0002-websocket-as-permission-transport.md) — WebSocket as the permission transport.
- [ADR 0006](0006-decouple-runs-from-connections.md) — runs decoupled from connections (the
  spiritual predecessor: one boundary, one rule, machine-checked at the runtime layer).
- [architecture overview](../architecture.md) — module map, current shape.
- [agent-session spec](../../domains/core/agent-session/spec.md) — `decideSocketResume`,
  `launchRun`, the socket auto-resume contract (the "AS-R18 / AVAIL-7" the slice 1/3 contract
  test C2 pins).
- Slice 1/3 spec: `changes/2026/06/04/2026-06-04-017-server-refactor-1-of-3-foundation/spec.md`.
