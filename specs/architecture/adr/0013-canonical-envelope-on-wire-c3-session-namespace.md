# 0013 — Canonical envelope on the wire + c3 session namespace internalization

- **Status:** accepted
- **Date:** 2026-06-06

## Context

ADR-0011 introduced the vendor-neutral `CanonicalMessage` model, but it lived only inside
`server/src/kernel/agent/adapters/types.ts`. Two follow-on questions were left open:

1. **Where does the neutral envelope belong?** If each vendor's messages map to their own wire
   shape, the wire grows a second schema per vendor and the front-end learns three message
   models. The 010 field-diff already proved a single common envelope exists; it should be the
   one shape that crosses the wire, gaining only a `vendor` _dimension_, never a parallel schema.
2. **How are sessions named across vendors?** Claude keys transcripts by JSONL under
   the vendor name) leaks into c3's URLs and storage keys, the namespace is vendor-coupled and a
   session can't be addressed neutrally. The native stores must stay the source of truth — c3
   must not become a second copy of every transcript.

A third, smaller question: the two vendor message _forms_ differ. Claude emits a whole message
per frame; Codex emits incremental `ItemUpdated` frames that revise an earlier item in place. A
naive append-only consumer would duplicate blocks for the incremental form.

## Options considered

1. **Keep the envelope in the kernel; map per-vendor to bespoke wire events.** _Con:_ a second
   schema per vendor on the wire; the front-end branches on vendor; the "one common envelope"
   conclusion from 010 is thrown away at the boundary.
2. **Promote the envelope to the wire; persist a c3 session registry mapping c3 id ↔ vendor id.**
   _Con:_ a persisted registry is a second store that must be kept in sync with every vendor's
   native store — double-write, drift, and a migration surface, exactly what "native store is SoT"
   was meant to avoid.
3. **Promote the envelope to `shared/protocol.ts` (kernel re-exports); make the c3 id a
   deterministic vendor-free digest resolved by a read-only lazy accessor.** The envelope is
   defined once on the wire (SDK-free); the kernel re-exports it so existing consumers are
   unchanged. The c3 session id is `hash(vendor \0 vendorSessionId)` — stable across restarts
   (no persistence) and containing neither the vendor name nor the raw id as a substring (URL/
   storage safe). A `SessionAccessor` wraps the per-vendor `SessionStore`s read-only, normalizing
   listings on demand and building the `c3 → ref` index lazily from those listings. Block updates
   upsert by `(sessionId, block.id)`, so both vendor forms collapse to one rule.

## Decision

Adopt option 3.

- **Canonical envelope on the wire.** `VendorId`, `AdapterCapability` (the capability enum),
  `CanonicalRole`, `CanonicalToolResult`, `CanonicalBlock`, and `CanonicalMessage` are defined in
  `shared/src/protocol.ts` — zero-runtime, SDK-free (ADR-0009). The kernel's `adapters/types.ts`
  re-exports them (single SoT); `adapters/index.ts` surfaces them. The wire gains a `vendor`
  dimension on one envelope; it does **not** start a per-vendor schema.
- **D-A — embedded tool result preserved.** 011's D3 ruling stands: there is **no standalone
  `tool_result` block**; a tool's return is folded into `tool_use.result` by id-upsert. The
  three-vendor common block set is `text` / `thinking` / `tool_use`.
  NOT promoted to their own block variant (no adapter produces them yet — 宁丢勿强塞). A future
  `vendorTag`-discriminated escape variant is the extension point.
- **Two-form upsert.** `CanonicalAccumulator` / `upsertBlock` (`adapters/canonical-accumulator.ts`)
  key blocks by `(sessionId, block.id)` and upsert: a same-id block revises in place, an anonymous
  (id-less) block appends, a tool result back-fills its `tool_use` monotonically (a later
  input-only revision never erases an arrived result). Claude's whole-message form and Codex's
  incremental form converge to the same normalized view.
- **D-C — c3 session namespace internalization.** `C3SessionId` is opaque
  (`mintC3SessionId(ref) = "c3s_" + sha256(vendor \0 vendorSessionId)[:32]`), deterministic, and
  vendor-free — the only id that crosses out of the kernel. `SessionRef = { vendor, vendorSessionId }`
  stays inside. `SessionAccessor` (`agent/session/accessor.ts`) is a **read-only** union over the
  available vendors' `SessionStore`s: `list` merges across vendors (native id hidden in
  `vendorExtra`, never the top level), `read` routes to the owning store via a lazily-built
  `c3 → ref` index. **No double-write:** native stores are SoT; the index is a derived runtime
  cache rebuilt by listing, not a second copy of session content ("存储形态归一、位置不归一").
- **Approval stays off the message model.** Approval/permission events are NOT `CanonicalMessage`s
  — they ride the `ApprovalBridge` stream, so the envelope never becomes a god type.

This phase stops at the kernel + shared types and the read-only accessor; it does **not** rewire
the live wire frames, `runClaude`, or the web URL/storage layer (web currently holds `sessionId`
in memory only, so there is no migration debt).

## Consequences

- **Easier:** one envelope on the wire; the front-end learns a single message model with a
  `vendor` tag. A new vendor maps its messages to the same shape and its sessions through the same
  accessor — no new wire schema, no new id namespace.
- **Honest storage:** native stores remain the single source of truth; c3 owns only a derived,
  rebuildable index — no sync/migration surface, no double-write.
- **URL/storage safety:** a vendor id can never leak into a URL or storage key because the only
  exposed handle is an opaque digest.
- **Boundary:** `shared/protocol.ts` and `adapters/` stay SDK-free (ADR-0009); the accessor depends
  only on the neutral `SessionStore`.
- **Deferred:** wiring the envelope/c3 id through the live wire frames, the front-end, and the URL/
  synthetic frames against the neutral reducer); explicit `reasoning`/`diff` blocks.

## Compliance

- `shared/src/protocol.ts` and `server/src/kernel/agent/{adapters,session}/` (excluding `claude/`)
  MUST NOT import any vendor SDK type (`git grep '@anthropic'` shows only comments).
- `mintC3SessionId` MUST be deterministic and its output MUST contain neither the vendor name nor
  the raw vendor id as a substring; pinned by `session/accessor.test.ts`.
- `upsertBlock` MUST revise a same-id block in place (no array growth) and MUST NOT erase an
  arrived `tool_use.result` on a later input-only revision; pinned by `canonical-accumulator.test.ts`.
- `SessionAccessor` MUST be read-only and route `read` to the owning vendor store with the NATIVE
  id (never the c3 id); pinned by `session/accessor.test.ts`.
- The kernel re-export MUST keep existing consumers behavior-equivalent: `types.test.ts` /
  `claude.test.ts` stay green.
- `pnpm typecheck` + `pnpm lint` + `pnpm vitest run server` MUST be green.

## References

- [ADR 0011](0011-vendor-neutral-agent-abstraction.md) — the `CanonicalMessage` model + D3
  embedded-result ruling this ADR promotes to the wire.
- [ADR 0012](0012-host-binary-probe-first-capability-gate.md) — `resolveAvailableAdapters().available`
  is the vendor list `SessionAccessor` wraps.
- [ADR 0009](0009-unidirectional-boundaries.md) — the SDK-free boundary `shared/` and `adapters/` honor.
- [ADR 0004](0004-persist-workspace-session-registry.md) — the workspace/session registry the c3
  namespace will eventually front (deferred).
- [agent-session domain spec](../../domains/core/agent-session/spec.md) — the envelope/namespace rules.
- This phase's spec:
  `changes/2026/06/06/2026-06-06-001-protocol-vendor-tag-canonical-envelope/spec.md`.

---

## Amendment: `work_session_metadata` projection table (2026-06-07; renamed from `session_metadata` 2026-06-08)

The cross-vendor `list_sessions` path was rewired from a per-request fan-out
to the accessor union (above) to a direct read of a `work_session_metadata`
projection table in `c3.db`. This amendment records the contract.

### Projection table contract

The `work_session_metadata` table is a **rebuildable cache**, not a second copy of
session content. The only source of truth for session _content_ (transcript,
prompt, tool_use, tool_result, blocks) is the vendor's native store (Claude
metadata:

| Column              | Purpose                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c3_id`             | Opaque c3 session id (the `C3SessionId` from `mintC3SessionId`). PK.                                                                                                       |
| `workspace_path`    | The workspace this row belongs to; drives the daily read path's SQL filter.                                                                                                |
| `vendor_session_id` | The native vendor id (nullable for pending rows).                                                                                                                          |
| `agent_id`          | The agent the session runs on (binding fact or pending intent).                                                                                                            |
| `title`             | Display title; rewritten by lazy validation / run-end.                                                                                                                     |
| `last_modified`     | UTC ms; stamped to the bind time on a real row (all vendors, incl. Codex — SR-R13), refined to the native transcript mtime by lazy validation; null only for pending rows. |
| `state`             | Lifecycle state (`born` / `alive` / `stale` / `orphaned` / `ghost`).                                                                                                       |
| `state_updated_at`  | UTC ms; drives the STALE window and warmup policy.                                                                                                                         |
| `kind`              | `'real'` for post-bind rows, `'pending'` for pre-bind rows.                                                                                                                |

**No transcript, prompt, tool_use, tool_result, or block content is ever
written to this table.** Pinned by the column-whitelist positive assertion
test in `features/works/work-session-store.test.ts`.

### Lifecycle states

| State      | Meaning                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `born`     | Just inserted; not yet seen by a native list.                                           |
| `alive`    | Written from a recent native list or validated by one in the last STALE window.         |
| `stale`    | Not validated in > STALE_MS (24h). Rendered with an "Unvalidated" tag.                  |
| `orphaned` | Confirmed absent from the native store (warmup: 2 janitor passes). Rendered grayed-out. |
| `ghost`    | Native store errored (REST down, JSONL unreadable). Rendered with a "Retry" affordance. |

### Read path

The daily `list_sessions` reads the projection at the SQL level (one query per
workspace). The `isHiddenSession` / `isToolSession` filters are applied
downstream, not denormalized into the row. Pending rows (`kind='pending'`) are
excluded from the wire list — the per-connection "viewed session" badge is the
pending entry, not a list item.

The env flag `C3_LIST_FROM_PROJECTION` (default ON) rolls the read path back
to the legacy `listWorkspaceSessions` (claude-only) path.

### Write triggers

| Trigger                              | Effect                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSession` (UI)                 | Insert a pending row (the new home for the ADR-0015 intent).                                                                                                                                                                                                                                                            |
| `freezeSessionAgent` (bind)          | Drop pending row, insert real row (single entry point for both run paths).                                                                                                                                                                                                                                              |
| `setSessionAgent` (same-vendor swap) | Update real row's `agent_id`.                                                                                                                                                                                                                                                                                           |
| `renameWorkspaceSession`             | Update real row's `title`.                                                                                                                                                                                                                                                                                              |
| `finalizeRun` (run end)              | Update real row's `title` (resolved from the native store — the SAME source as the title bar / janitor, not `baseline` which is empty on the first run; first user prompt is the fallback) / `last_modified` / `agent_id`, then re-broadcast the list (the async native read lands after `run:settled → sendSessions`). |
| `removeSession` (delete)             | Delete the row.                                                                                                                                                                                                                                                                                                         |

### Freshness & janitor

A lazy `validateLazy` re-checks rows older than `LAZY_VALIDATE_MS` (24h)
against the native stores; Codex rows are explicitly skipped. A daily janitor
(`JANITOR_INTERVAL_MS = STALE_MS/2 = 12h`) transitions `born/alive → stale`
and, after a warmup (2 passes), `stale → orphaned`.

### `user_version` rule

The projection store does NOT write `PRAGMA user_version` — the three domain
stores (`intents`, `discussions`, `work_session_metadata`) would clobber each
other (see `discussions/store.ts:25-30`). All domain stores should follow this
posture going forward; migrations key off `PRAGMA table_info` +
`ensureColumn`, never off `user_version`.

### Native-is-SoT invariant

When the projection disagrees with the native store (title mismatch, session
gone, store errored), the native store wins. The projection is refreshed, not
preferred. When the projection is empty (a fresh install or a deleted table),
the read path transparently rebuilds from the accessor + `sessionAgents`
facts and re-reads. The projection is a cache, not a gate — it never blocks
the wire.

### References

- `server/src/features/works/work-session-store.ts` — the projection store.
- `server/src/kernel/agent/session/list-sessions.ts` — the read path.
- `changes/2026/06/07/2026-06-07-001-session-metadata-projection/spec.md` — the
  functional spec for this amendment.
