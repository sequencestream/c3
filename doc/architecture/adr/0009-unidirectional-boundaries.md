# 0009 — Unidirectional Boundaries: kernel → transport/features, transport → kernel, no back-edges

- **Status:** accepted
- **Date:** 2026-06-04

## Context

The server's single entry file had grown into one oversized module that owned the WebSocket
upgrade, the per-connection viewing state, ~40 message cases in one giant dispatch switch, and the
many module-level closures that bridged them: the run launcher, the development-turn driver, the
discussion and research run starters, and the family of broadcasters and snapshot helpers for
statuses, intents, discussions, schedules, discussion/research messages and run status, and
automation — plus the shared mutable state (the connection set, the run-status cache, the
judged-session set, the live discussion/research run maps) and the launch / automation hooks. That
file was the only place that knew how the SDK message stream, the persistence stores, the
session-runtime registry, the discussion / schedule subsystems, and the WebSocket protocol fit
together. A change to any one drifts all the others.

We are about to split this file along three planes:

- **kernel layer** — pure domain: the session-runtime registry, settings lookup, the intents /
  discussions / schedules stores, the run launcher, automation hooks. No WebSocket / HTTP / JSON
  knowledge, no module-level singleton for transport-owned state.
- **transport layer** — WebSocket / HTTP plumbing. The handler registry keyed by client message
  type, the one-line dispatcher, the connection-side broadcaster. Consumes kernel events to
  produce wire frames.
- **features layer** — one unit per top-level user action, mirroring the client message-type
  union. Each feature registers exactly one (or a small, named set of) handler(s) at startup.
  Handlers receive an explicit application context and a connection handle, not a global socket
  set.

For this split to be reversible one slice at a time (slice 1/3 = skeleton + zero-behavior-change
shim; slice 2/3 = real moves; slice 3/3 = kernel event bus) the boundaries between the three
planes have to be enforceable **today**, before any move. Otherwise the next slice will quietly
grow a back-edge ("just one more import from the features layer") that later slices cannot un-knot.

The existing ADR-0006 already pins one direction: every live event flows through the runtime's emit
path (buffer + viewers), never straight to a socket. ADR-0009 widens that to all three layers and
all six edge cases that have been seen — and would re-appear — during refactor.

## Options considered

1. **No ADR, rely on code review.** _Con:_ the oversized switch has ~40 cut-points; reviewers
   cannot police every back-edge across that many units, and the rules are not in a place a future
   agent can consult. The first accidental import of transport state into a feature will silently
   re-couple them. Same trap ADR-0006 was written to prevent.
2. **ADR with prose-only rules.** _Con:_ review-time only, drift inevitable. Without a lint rule or
   a test gate the rules become folklore.
3. **ADR with lint-enforced rules for the automatable subset, code-review + tests for the rest.**
   _Pro:_ enforceable where the type checker + linter can see it (cross-layer imports, layer
   locations, entry sinking); an explicit boot-time guard asserting kernel events carry no
   transport fields; review + contract tests for the semantic edges (derivation purity,
   mode-narrowing, pure-domain kernel events). _Con:_ R4/R5/R6 stay review-time in this slice. They
   become lint rules once the moves in 2/3 make them mechanically checkable.

## Decision

Adopt option 3. The three layers are the kernel, transport, and features layers. The boundaries are
**single-direction** and codified as six rules:

| #   | Rule                                                                                                                                                                                                                                                                         | Enforcement                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The kernel layer MUST NOT import from the features or transport layers.                                                                                                                                                                                                      | a restricted-imports lint rule scoped to the kernel layer.                                                                                           |
| R2  | The kernel layer MUST NOT touch WebSocket / HTTP semantics (sending frames, JSON serialization, the web framework, the raw socket type). Broadcasting lives in the transport layer, which subscribes to a kernel event bus (hooked in slice 2/3; the shell exists from 1/3). | restricted-imports + restricted-syntax lint rules on the kernel layer; a boot-time no-transport-fields assertion in the application-context factory. |
| R3  | Entry files MUST stay at the server source root, not sink into subdirectories. The application context is constructed **once** at startup and injected, not a module-level singleton.                                                                                        | a layout lint rule + a single context-construction call site, grep-checked.                                                                          |
| R4  | Derived/enrichment functions MUST be pure: read-only over their inputs, never writing back to a registry, a module-level cache, or a runtime field.                                                                                                                          | review + dedicated unit tests; becomes a lint rule in 2/3 once the move makes it mechanically checkable.                                             |
| R5  | A new mode (permission mode, run kind, etc.) MUST NOT cross a kernel boundary as an implicit switch — every kernel function that depends on mode MUST narrow it explicitly at the call site (narrow the run kind inside the kernel, not the message mode inside a feature).  | review + contract tests pinning the narrow; becomes a lint rule in 2/3.                                                                              |
| R6  | Kernel events (what the emit path and any future event bus carry) MUST contain only pure domain facts. No viewer / socket / connection-set / serialized-payload field — those are transport concerns that travel downstream, not upstream.                                   | the boot-time no-transport-fields assertion + the R2 lint rule keeps the producer side clean.                                                        |

The handler dispatcher is the new structural centerpiece. It is **not** itself a rule — it is the
mechanism R1 + R2 + R5 hang on: the handler registry is a compile-time-complete map keyed by every
client message type, so adding a new client message type without adding a handler fails type
checking. The server's message-receive path becomes a one-line dispatch into that registry.

The old monolithic switch body is delegated, in this slice, to a per-message-type handler set still
living in the same file. **Slice 1/3 is zero behavior change**: the 40+ case bodies still live in
the entry file, just behind a thin dispatch. Slice 2/3 moves each body into its feature unit and
registers it. The dispatcher never sees the move — that's the point.

## Consequences

- **Easier:** every cross-layer violation is grep-checkable (a kernel-layer import of a feature or
  transport module should return nothing). The handler registry turns the 40-case switch into a
  compile-time-complete map; new client message types are refused until registered. The
  application-context boundary lets slices 2/3 and 3/3 move shared state out of module-level
  closures one field at a time without disturbing handlers.
- **Harder:** a feature handler that wants to "just send a status to one connection" can no longer
  reach into the kernel's connection set — it has to go through the transport-owned per-connection
  send. That is the rule, not a leak. Some one-line handlers grow a small plumbing cost in slice
  1/3 (delegation through the in-file handler set); that is the price of the boundary.
- **Migration:** slice 1/3 ships re-export shims for the three layers so any future import path is
  already valid. The entry import wiring is unchanged. The old switch is gone from the file; the old
  case bodies live as exported functions next to it. Reverting slice 1/3 returns the codebase to the
  pre-slice state with all tests green (the validation step in the slice spec is exactly this).
- **Testability:** five golden-standard contract tests (C1–C5) assert end-to-end behavior. They are
  written to survive any implementation move; only the public contract (the emit path, the run
  launcher, store-availability checks, etc.) is pinned.

## Compliance

- A kernel-layer import of a feature or transport module MUST NOT exist.
- A kernel-layer reference to WebSocket / HTTP-framework / JSON-serialization semantics MUST NOT
  exist.
- `pnpm typecheck` MUST be green; adding a client message type without a matching handler-registry
  entry MUST fail typecheck immediately.
- `pnpm test` MUST be green for the 5 contract tests on every slice merge.
- `pnpm lint` MUST be green; the kernel-layer restricted-imports rule is the mechanical guard.
- Slice 1/3 ships with a tagged "bisect anchor" commit — any future slice that breaks a contract
  test points bisect straight here.

## References

- [ADR 0002](0002-websocket-as-permission-transport.md) — WebSocket as the permission transport.
- [ADR 0006](0006-decouple-runs-from-connections.md) — runs decoupled from connections (the
  spiritual predecessor: one boundary, one rule, machine-checked at the runtime layer).
- [architecture overview](../architecture.md) — module map, current shape.
- [agent-session spec](../../domains/core/agent-session/agent-session-spec.md) — the socket auto-resume decision
  and run launch path (the "AS-R18 / AVAIL-7" the slice 1/3 contract test C2 pins).
