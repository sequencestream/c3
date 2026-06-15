# 0015 — Two-key session→agent binding + frozen vendor ownership

- **Status:** accepted
- **Date:** 2026-06-07

## Context

c3's ordinary session domain is evolving from "100% read-only Claude directory" to multi-agent /
runs on was a single map — `sessionAgents: Record<sessionId, agentId>` in
`server/src/kernel/config/index.ts` — keyed by whatever id a session currently has. A new session
starts life as `pending:<uuid>` (SR-R6/SR-R7) and is re-keyed to the real SDK `sessionId` on its
first run by `bindPending` (`server/src/runs.ts`), which moves only the _runtime_ (buffer, viewers,
in-flight run). The binding map carried no vendor and was never updated at bind time.

Two problems followed:

1. **No vendor invariant.** A session's transcript lives **only** in its vendor's native store
   `SessionAccessor` routes reads by vendor — ADR-0013). c3 itself **never stores any session
   content**. So once a session has produced a transcript, re-binding it to an agent of a
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
   `pendingIntents` (pending id → desired agent, with a timestamp) and `sessionAgents` _facts_ (real
   id → the agent that ran + its **frozen** vendor). The bind copies the intent into a fact, pins the
   vendor, and drops the intent. A janitor reaps abandoned intents. _Pro:_ the invariant is durable
   and self-evident; intent death never produces an orphan fact. _Con:_ a state-file schema bump +
   migration.
3. **Store facts but allow vendor changes with a transcript-migration ("replay-seed") path.** _Con:_
   the cross-vendor replay-seed hand-off is explicitly deferred by ADR-0011; building it now is out
   of scope.

## Decision

Adopt option 2. **The session→agent binding is a two-key space, and a session's vendor is an
immutable invariant frozen at its first bind.**

- **Storage layer (`kernel/config/index.ts`), vendor-blind.** `state.json` becomes `version: 2` with
  two maps:
  - `pendingIntents: Record<pendingId, { agentId, createdAt }>` — the **intent**: mutable, may be
    re-targeted or cleared, never carries a vendor.
  - `sessionAgents: Record<realId, { agentId, vendor }>` — the **fact**: the agent that actually ran
    plus its frozen vendor.
    Operations: `getSessionAgentId` reads both spaces (pending id → intent, real id → fact);
    `getSessionVendor` reads the frozen vendor; `setPendingIntent` sets/clears an intent (stamping
    `createdAt`); `bindSessionAgent(pendingId, realId, agentId, vendor)` is the **first-bind freeze**
    (writes the fact iff absent, always drops the intent — idempotent, never re-freezes);
    `changeSessionAgentFact(realId, agentId, vendor)` enforces the invariant (same-vendor swap →
    `true`; cross-vendor → `false`, fact untouched); `cleanupStalePendingIntents(now, maxAgeMs)` is the
    janitor. The storage layer takes vendor as a plain argument so it never imports the agent registry —
    the `config → agent-config` boundary stays acyclic (ADR-0009).
- **Resolution layer (`kernel/agent-config/index.ts`).** `freezeSessionAgent(pendingId, realId,
agentId)` resolves the agent's vendor and calls `bindSessionAgent`; `setSessionAgent(sessionId,
agentId)` routes a pending id to `setPendingIntent` and a real id through `changeSessionAgentFact`,
  returning `{ ok }` so a cross-vendor attempt is reported, not silently dropped.
- **Bind timing.** The freeze fires at the same moment as the runtime `bindPending`, on the first
  real `sessionId`, in both run paths: `run/run-lifecycle.ts` (claude) and `run/run-via-driver.ts`
  not merely an explicit intent.
- **Janitor.** `server.ts` sweeps `pendingIntents` older than `PENDING_INTENT_TTL_MS` (7 days) at boot
  and hourly. Clearing an intent never touches `sessionAgents`, so it cannot orphan a fact.
- **Migration (v1 → v2).** A legacy single map is split by key shape: `pending:`-prefixed keys become
  intents (stamped now); all other keys become facts frozen to `vendor: 'claude'` — the only vendor
  that existed before multi-vendor, so the freeze is historically correct.

The invariants, stated plainly: **a session's vendor cannot change; within the same vendor its agent
can be swapped freely; c3 never stores any session content; cross-vendor Fork / replay-seed is not
supported this cycle** (deferred per ADR-0011).

## Consequences

- Re-binding a session across vendors is now structurally impossible — the transcript a session
  produced is always readable from its frozen vendor's store. Same-vendor agent swaps remain free.
- Pending intents are garbage-collected; an abandoned new session no longer leaves a permanent entry,
  and intent death never yields an orphan fact.
- `state.json` schema bumped to v2; old installs migrate transparently on first read.
- The cross-vendor context hand-off (replay-seed, heterogeneous teammates) stays deferred; a user who
  wants a different vendor starts a new session.

## Compliance

- **ADR-0009 R1** — `config` (storage) does not import `agent-config` (resolution); vendor crosses the
  boundary as a plain argument. The resolution wrappers live in `agent-config`, which already depends
  on `config`. The boundary stays acyclic.
- The frozen-vendor invariant is unit-tested in `server/src/kernel/session-agent-binding.test.ts`:
  two-key writes, bind-freeze + idempotence, same-vendor swap vs cross-vendor reject, intent death
  without orphan facts, janitor reaping, and v1→v2 migration.
- `pnpm typecheck` / `pnpm lint` / the vitest suite stay green.

## References

- ADR-0011 (vendor-neutral agents; deferred replay-seed / heterogeneous teammates), ADR-0013 (c3
  session namespace + per-vendor stores), ADR-0009 (unidirectional boundaries), ADR-0004 (session
  registry).
- `specs/domains/system-config/agent-config/` (AC-R\* binding rules), `specs/domains/core/session-registry/`
  (pending-session lifecycle), `specs/domains/core/agent-session/` (AS-R10 re-key).
- `kernel/config/index.ts`, `kernel/agent-config/index.ts`, `kernel/run/{run-lifecycle,run-via-driver}.ts`,
  `server.ts`.
