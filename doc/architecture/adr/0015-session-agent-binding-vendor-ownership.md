# 0015 — Two-key session→agent binding + frozen vendor ownership

- **Status:** accepted
- **Date:** 2026-06-07

## Context

c3's ordinary session domain is evolving from "100% read-only Claude directory" to multi-agent /
multi-vendor. The record of which agent a session runs on was a single map — session id → agent id,
held in the kernel config layer — keyed by whatever id a session currently has. A new session
starts life with a pending id (SR-R6/SR-R7) and is re-keyed to the real session id on its
first run by the bind step, which moves only the _runtime_ (buffer, viewers,
in-flight run). The binding map carried no vendor and was never updated at bind time.

Two problems followed:

1. **No vendor invariant.** A session's transcript lives **only** in its vendor's native store
   (the read-only session accessor routes reads by vendor — ADR-0013). c3 itself **never stores any
   session content**. So once a session has produced a transcript, re-binding it to an agent of a
   _different_ vendor would read nothing back — the history would silently vanish. Nothing enforced
   this.
2. **Intent and fact were conflated.** A pending session's _desired_ agent (mutable, may never run)
   and a real session's _actual_ agent (settled, vendor-bearing) shared one map and one key space.
   A pending entry that never ran could linger forever, and a bind never copied the desired agent
   into a durable fact.

## Options considered

1. **Keep one map; derive vendor from the bound agent on demand.** _Con:_ the agent record can be
   edited or deleted, so the "frozen" vendor would be unstable / unrecoverable; nothing distinguishes
   a still-mutable pending intent from a settled fact, so abandoned pendings accumulate.
2. **Two key spaces; freeze vendor explicitly at first bind (chosen).** Split the map into a mutable
   pending-intents space (pending id → desired agent, with a timestamp) and a session-agent _facts_
   space (real id → the agent that ran + its **frozen** vendor). The bind copies the intent into a
   fact, pins the vendor, and drops the intent. A janitor reaps abandoned intents. _Pro:_ the
   invariant is durable and self-evident; intent death never produces an orphan fact. _Con:_ a
   state-file schema bump + migration.
3. **Store facts but allow vendor changes with a transcript-migration ("replay-seed") path.** _Con:_
   the cross-vendor replay-seed hand-off is explicitly deferred by ADR-0011; building it now is out
   of scope.

## Decision

Adopt option 2. **The session→agent binding is a two-key space, and a session's vendor is an
immutable invariant frozen at its first bind.**

- **Storage layer (kernel config), vendor-blind.** The persisted state file bumps to schema version 2
  with two maps:
  - the **intent** map (pending id → desired agent + creation timestamp): mutable, may be
    re-targeted or cleared, never carries a vendor.
  - the **fact** map (real id → the agent that actually ran + its frozen vendor).
    Operations: a single read resolves both spaces (pending id → intent, real id → fact); a read of
    the frozen vendor; a set/clear of an intent (stamping the creation time); a **first-bind freeze**
    that writes the fact iff absent and always drops the intent (idempotent, never re-freezes); a
    fact-change that enforces the invariant (same-vendor swap → success; cross-vendor → rejected, fact
    untouched); and a janitor that reaps stale intents. The storage layer takes vendor as a plain
    argument so it never imports the agent registry — the config → agent-config boundary stays acyclic
    (ADR-0009).
- **Resolution layer (kernel agent-config).** The freeze wrapper resolves the agent's vendor and calls
  the storage-layer first-bind freeze; the set-agent wrapper routes a pending id to the intent setter
  and a real id through the fact-change, returning a success/failure result so a cross-vendor attempt
  is reported, not silently dropped.
- **Bind timing.** The freeze fires at the same moment as the runtime bind, on the first
  real session id, in both run paths (the Claude run path and the driver run path) — so the fact is
  always written from a real run, not merely an explicit intent.
- **Janitor.** The composition root sweeps pending intents older than the pending-intent TTL (7 days)
  at boot and hourly. Clearing an intent never touches the fact map, so it cannot orphan a fact.
- **Migration (v1 → v2).** A legacy single map is split by key shape: pending-prefixed keys become
  intents (stamped now); all other keys become facts frozen to the Claude vendor — the only vendor
  that existed before multi-vendor, so the freeze is historically correct.

The invariants, stated plainly: **a session's vendor cannot change; within the same vendor its agent
can be swapped freely; c3 never stores any session content; cross-vendor Fork / replay-seed is not
supported this cycle** (deferred per ADR-0011).

## Consequences

- Re-binding a session across vendors is now structurally impossible — the transcript a session
  produced is always readable from its frozen vendor's store. Same-vendor agent swaps remain free.
- Pending intents are garbage-collected; an abandoned new session no longer leaves a permanent entry,
  and intent death never yields an orphan fact.
- The persisted state schema bumped to v2; old installs migrate transparently on first read.
- The cross-vendor context hand-off (replay-seed, heterogeneous teammates) stays deferred; a user who
  wants a different vendor starts a new session.

## Compliance

- **ADR-0009 R1** — the storage layer does not import the resolution layer; vendor crosses the
  boundary as a plain argument. The resolution wrappers live in the agent-config layer, which already
  depends on the config layer. The boundary stays acyclic.
- The frozen-vendor invariant is unit-tested: two-key writes, bind-freeze + idempotence, same-vendor
  swap vs cross-vendor reject, intent death without orphan facts, janitor reaping, and v1→v2 migration.
- Typecheck, lint, and the test suite stay green.

## References

- ADR-0011 (vendor-neutral agents; deferred replay-seed / heterogeneous teammates), ADR-0013 (c3
  session namespace + per-vendor stores), ADR-0009 (unidirectional boundaries), ADR-0004 (session
  registry).
- [agent-config domain spec](../../domains/system-config/agent-config/) (AC-R\* binding rules),
  [session-registry domain spec](../../domains/core/session-registry/) (pending-session lifecycle),
  [agent-session domain spec](../../domains/core/agent-session/) (AS-R10 re-key).
