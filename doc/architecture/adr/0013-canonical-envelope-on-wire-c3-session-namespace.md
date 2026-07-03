# 0013 — Canonical envelope on the wire + c3 session namespace internalization

- **Status:** accepted
- **Date:** 2026-06-06

## Context

ADR-0011 introduced the vendor-neutral canonical message model, but it lived only inside
the kernel adapter layer. Two follow-on questions were left open:

1. **Where does the neutral envelope belong?** If each vendor's messages map to their own wire
   shape, the wire grows a second schema per vendor and the front-end learns three message
   models. The 010 field-diff already proved a single common envelope exists; it should be the
   one shape that crosses the wire, gaining only a `vendor` _dimension_, never a parallel schema.
2. **How are sessions named across vendors?** Claude keys transcripts by JSONL under
   the vendor name) leaks into c3's URLs and storage keys, the namespace is vendor-coupled and a
   session can't be addressed neutrally. The native stores must stay the source of truth — c3
   must not become a second copy of every transcript.

A third, smaller question: the two vendor message _forms_ differ. Claude emits a whole message
per frame; Codex emits incremental update frames that revise an earlier item in place. A
naive append-only consumer would duplicate blocks for the incremental form.

## Options considered

1. **Keep the envelope in the kernel; map per-vendor to bespoke wire events.** _Con:_ a second
   schema per vendor on the wire; the front-end branches on vendor; the "one common envelope"
   conclusion from 010 is thrown away at the boundary.
2. **Promote the envelope to the wire; persist a c3 session registry mapping c3 id ↔ vendor id.**
   _Con:_ a persisted registry is a second store that must be kept in sync with every vendor's
   native store — double-write, drift, and a migration surface, exactly what "native store is SoT"
   was meant to avoid.
3. **Promote the envelope to the shared protocol definitions (kernel re-exports); make the c3 id a
   deterministic vendor-free digest resolved by a read-only lazy accessor.** The envelope is
   defined once on the wire (SDK-free); the kernel re-exports it so existing consumers are
   unchanged. The c3 session id is a hash over the vendor and the vendor's session id — stable
   across restarts (no persistence) and containing neither the vendor name nor the raw id as a
   substring (URL/ storage safe). A read-only accessor wraps the per-vendor session stores,
   normalizing listings on demand and building the c3-id → vendor-ref index lazily from those
   listings. Block updates upsert by (session id, block id), so both vendor forms collapse to one
   rule.

## Decision

Adopt option 3.

- **Canonical envelope on the wire.** The vendor id, the adapter-capability set, the canonical
  role, the canonical tool result, the canonical block, and the canonical message are defined once
  in the shared protocol definitions — zero-runtime, SDK-free (ADR-0009). The kernel adapter layer
  re-exports them (single SoT). The wire gains a `vendor` dimension on one envelope; it does **not**
  start a per-vendor schema.
- **D-A — embedded tool result preserved.** 011's D3 ruling stands: there is **no standalone
  standalone tool-result block**; a tool's return is folded into the tool-use block's result field
  by id-upsert. The three-vendor common block set is text / thinking / tool-use.
  Other vendor-specific shapes are NOT promoted to their own block variant (no adapter produces
  them yet — 宁丢勿强塞). A future vendor-tag-discriminated escape variant is the extension point.
- **Two-form upsert.** The canonical accumulator keys blocks by (session id, block id) and upserts:
  a same-id block revises in place, an anonymous (id-less) block appends, a tool result back-fills
  its owning tool-use block monotonically (a later input-only revision never erases an arrived
  result). Claude's whole-message form and Codex's incremental form converge to the same normalized
  view.
- **D-C — c3 session namespace internalization.** The c3 session id is opaque
  (an opaque prefix plus a hash over the vendor and the vendor's session id), deterministic, and
  vendor-free — the only id that crosses out of the kernel. The vendor session reference (vendor +
  vendor session id) stays inside. The session accessor is a **read-only** union over the
  available vendors' session stores: listing merges across vendors (native id hidden in a vendor-
  extra field, never the top level), reading routes to the owning store via a lazily-built
  c3-id → vendor-ref index. **No double-write:** native stores are SoT; the index is a derived
  runtime cache rebuilt by listing, not a second copy of session content ("存储形态归一、位置不归一").
- **Approval stays off the message model.** Approval/permission events are NOT canonical messages
  — they ride the approval-bridge stream, so the envelope never becomes a god type.

This phase stops at the kernel + shared types and the read-only accessor; it does **not** rewire
the live wire frames, the Claude run path, or the web URL/storage layer (web currently holds the
session id in memory only, so there is no migration debt).

## Consequences

- **Easier:** one envelope on the wire; the front-end learns a single message model with a
  `vendor` tag. A new vendor maps its messages to the same shape and its sessions through the same
  accessor — no new wire schema, no new id namespace.
- **Honest storage:** native stores remain the single source of truth; c3 owns only a derived,
  rebuildable index — no sync/migration surface, no double-write.
- **URL/storage safety:** a vendor id can never leak into a URL or storage key because the only
  exposed handle is an opaque digest.
- **Boundary:** the shared protocol definitions and the adapter layer stay SDK-free (ADR-0009); the
  accessor depends only on the neutral session-store abstraction.
- **Deferred:** wiring the envelope/c3 id through the live wire frames, the front-end, and the URL/
  synthetic frames against the neutral reducer); explicit `reasoning`/`diff` blocks.

## Compliance

- The shared protocol definitions and the kernel adapter + session layers (excluding the Claude-
  specific adapter) MUST NOT import any vendor SDK type.
- Minting a c3 session id MUST be deterministic and its output MUST contain neither the vendor name
  nor the raw vendor id as a substring; pinned by an accessor test.
- The block upsert MUST revise a same-id block in place (no array growth) and MUST NOT erase an
  arrived tool result on a later input-only revision; pinned by an accumulator test.
- The session accessor MUST be read-only and route a read to the owning vendor store with the
  NATIVE id (never the c3 id); pinned by an accessor test.
- The kernel re-export MUST keep existing consumers behavior-equivalent: the existing adapter and
  Claude-adapter tests stay green.
- Typecheck, lint, and the server test suite MUST be green.

## References

- [ADR 0011](0011-vendor-neutral-agent-abstraction.md) — the canonical message model + D3
  embedded-result ruling this ADR promotes to the wire.
- [ADR 0012](0012-host-binary-probe-first-capability-gate.md) — the available-adapter resolution
  produces the vendor list the session accessor wraps.
- [ADR 0009](0009-unidirectional-boundaries.md) — the SDK-free boundary the shared layer and the
  adapter layer honor.
- [ADR 0004](0004-persist-workspace-session-registry.md) — the workspace/session registry the c3
  namespace will eventually front (deferred).
- [agent-session domain spec](../../domains/core/agent-session/agent-session-spec.md) — the envelope/namespace rules.

---

## Amendment: unified `session_metadata` projection table (2026-06-07; generalized 2026-06-28)

The cross-vendor `list_sessions` path was rewired from a per-request fan-out
to the accessor union (above) to a direct read of a session-metadata projection
table in the c3 runtime database. On 2026-06-28 the former
`work_session_metadata` table was renamed in place to `session_metadata` and
generalized to carry six business session classes: work, intent, spec,
discussion, automation, and tool. This amendment records the contract.

### Projection table contract

The session-metadata projection is a **rebuildable cache**, not a second copy of
session content. The native/vendor stores and each domain's business tables stay
the sources of truth for session _content_ and ownership facts. This projection
holds only addressing/lifecycle metadata for read-side aggregation:

| Field             | Purpose                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| c3 session id     | Opaque c3 session id (the deterministic vendor-free digest). Primary key.                                                                                                  |
| workspace         | The workspace this row belongs to; drives the daily read path's filter.                                                                                                    |
| vendor session id | The native vendor id (nullable for pending rows).                                                                                                                          |
| agent             | The agent the session runs on (binding fact or pending intent).                                                                                                            |
| title             | Display title; rewritten by lazy validation / run-end.                                                                                                                     |
| last modified     | UTC ms; stamped to the bind time on a real row (all vendors, incl. Codex — SR-R13), refined to the native transcript mtime by lazy validation; null only for pending rows. |
| state             | Lifecycle state (born / alive / stale / orphaned / ghost).                                                                                                                 |
| state updated at  | UTC ms; drives the STALE window and warmup policy.                                                                                                                         |
| kind              | Legacy binding marker retained for compatibility; read paths ignore it.                                                                                                    |
| session kind      | Business class: work / intent / spec / discussion / automation / tool.                                                                                                     |
| owner kind        | Nullable logical owner kind (currently intent / discussion / automation) used by client-side jump-back rules.                                                              |
| owner id          | Nullable logical owner id.                                                                                                                                                 |
| bound             | Integer boolean replacement for `kind`: real rows are `1`; work-only pending placeholders are `0`.                                                                         |

**No transcript, prompt, tool-call, tool-result, or block content is ever
written to this projection.** Pinned by a field-whitelist positive assertion
test.

### Lifecycle states

| State    | Meaning                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| born     | Just inserted; not yet seen by a native list.                                                |
| alive    | Written from a recent native list or validated by one in the last STALE window.              |
| stale    | Not validated in > STALE window (24h). Rendered with an "Unvalidated" tag.                   |
| orphaned | Confirmed absent from the native store (warmup: 2 janitor passes). Rendered grayed-out.      |
| ghost    | Native store errored (REST down, transcript unreadable). Rendered with a "Retry" affordance. |

### Read path

The daily `list_sessions` reads the projection in a single query per workspace
and `session_kind`. The session page can therefore render per-kind tabs and
running-count badges from one contract. Pending rows (`bound = 0`) are excluded
from the wire list — the per-connection "viewed session" badge is the pending
entry, not a list item. In this phase, work, intent, spec, and automation are wired
to real data; discussion/tool rows remain valid schema targets for later phases.

An environment flag (default ON) rolls the read path back to the legacy
claude-only listing path.

### Write triggers

| Trigger                     | Effect                                                                                                                                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create work session (UI)    | Insert a work-kind pending row (the new home for the ADR-0015 intent).                                                                                                                                                                                                                                    |
| Freeze session agent (bind) | Drop pending row, insert real row (single entry point for both run paths); intent-started dev sessions carry `owner_kind='intent'` and `owner_id=<intent id>`, manual work sessions keep owner null.                                                                                                      |
| Intent chat lifecycle       | Upsert intent-kind bound rows for intent communication sessions; rename/delete mirror the intent session list.                                                                                                                                                                                            |
| Same-vendor agent swap      | Update the real row's agent.                                                                                                                                                                                                                                                                              |
| Rename session              | Update the real row's title.                                                                                                                                                                                                                                                                              |
| Finalize run (run end)      | Update the real row's title (resolved from the native store — the SAME source as the title bar / janitor, not the baseline which is empty on the first run; first user prompt is the fallback), last-modified, and agent, then re-broadcast the list (the async native read lands after the run settles). |
| Remove session (delete)     | Delete the row.                                                                                                                                                                                                                                                                                           |

### Freshness & janitor

A lazy validation re-checks rows older than the validation window (24h)
against the native stores; Codex rows are explicitly skipped. A daily janitor
(half the STALE window = 12h) transitions born/alive → stale
and, after a warmup (2 passes), stale → orphaned.

### Schema-version rule

The projection store does NOT write a global schema-version pragma — the three
domain stores (intents, discussions, session-metadata) would clobber each
other. All domain stores should follow this posture going forward; migrations
key off per-table column introspection plus an additive ensure-column step,
never off a global schema-version pragma.

### Native-is-SoT invariant

When the projection disagrees with the native store (title mismatch, session
gone, store errored), the native store wins. The projection is refreshed, not
preferred. When the projection is empty (a fresh install or a deleted table),
the read path transparently rebuilds from the accessor plus the recorded
session-agent facts and re-reads; enumerable vendors such as Claude and Codex
both participate in this one-shot rebuild. The projection is a cache, not a gate —
it never blocks the wire.
