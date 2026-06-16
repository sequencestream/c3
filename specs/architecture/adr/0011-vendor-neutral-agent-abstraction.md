# 0011 — Vendor-neutral Agent abstraction: three-piece interface + capability ledger

- **Status:** accepted
- **Date:** 2026-06-05
- **Amended:** 2026-06-07 — the capability ledger extended with structured session-lifecycle
  capability states (list / read / resume / rename / delete, each a graded capability state).
  See the _Amendment_ paragraph under "Capability ledger" below for the matrix and rationale.
- **Amended:** 2026-06-07 — a task-store capability flag added to the ledger (7th boolean
  flag — all three current vendors true). A 4th neutral interface, a task store, added to the
  adapter surface (create / list / update / get).
- **Amended:** 2026-06-07 — the Claude task-store reference implementation landed. See the
  _Claude task store_ paragraph under "Decision".
- **Amended:** 2026-06-07 (012) — the neutral permission grid (action mode / tool gate) promoted
  to the wire representation of session mode via a per-vendor mode catalog. See the _Vendor mode
  catalog_ paragraph.

## Context

Through ADR-0010 c3 was a Claude-only product: the run loop imported the Claude Agent SDK
directly, the permission gateway returned the SDK's permission-result type, session history was
read straight from Claude's transcripts, and the wire permission-mode value was the SDK's
five-way union verbatim. To support more than one vendor we need a neutral agent layer the rest
of the kernel can drive, with each vendor's SDK quirks sealed behind it.

Three Phase-0 probes established the ground truth that any neutral interface must respect — the
vendors do **not** share one mechanism:

- **008 (Codex) — NO-GO on per-tool runtime approval.** The Codex SDK closes the child's stdin
  after dispatching a turn; its event stream is read-only with no write-back half-channel and no
  "approval request" event. A tool can only be allowed/denied for the **whole turn** via an abort
  signal. There is no in-the-loop interception point.
- A third vendor's approval is a remote REST write-back (`POST /session/{id}/permissions/{permissionID}`),
  needing a Promise bridge, a timeout default-deny (~600 ms), and reconnect reconciliation. Its
  lifecycle is a remote long-running server, not an in-process child.
- **010 (message diff) — narrow common set.** Across the three vendors only the session id is an
  unconditional common field; role (Codex must synthesize it) and blocks (append-with-upsert, not
  carry) come at a discount. Everything else ("宁丢勿强塞") belongs in a vendor-extra overflow, not
  a faked top-level union.

A naïve "make everyone look like Claude" interface would lie about all three. The boundary rule
from ADR-0009 (SDK types never leave the kernel, never enter the shared wire contract) must also
hold for whatever shape we pick.

## Options considered

1. **Widen the Claude types into the shared interface.** Promote the permission mode, the SDK
   message shapes, and the per-tool approval callback to the neutral surface. _Con:_ enshrines
   Claude-isms the other vendors can't honor (Codex has no per-tool approval; nobody else has a
   five-way mode), and drags SDK types toward the wire contract — a direct ADR-0009 violation.
2. **One fat interface with every capability required.** Force every adapter to implement
   interrupt / fork / in-process MCP / per-tool approval. _Con:_ Codex physically cannot do
   per-tool approval (008); a required method it can only throw on is worse than an absent one —
   the upper layer can't degrade gracefully because it can't tell.
3. **A required common subset + a probed capability ledger for everything divergent.** Three
   neutral interfaces (driver / approval / session-store) whose _required_ surface every vendor
   satisfies, plus a probed capability ledger of optional/degradable flags the upper layer checks
   before reaching for a divergent control. Permission collapses to an orthogonal 2-axis grid; SDK
   values cross as `unknown` and are narrowed inside each vendor's adapter. _Pro:_ honest about the
   probes, keeps SDK types in the kernel, lets the upper layer degrade per-vendor. _Con:_ the
   additive phase ships the Claude adapter delegating to the existing run loop rather than replacing
   it; the full rewrite (folding the gateway + run loop through the driver) is a later phase.

## Decision

Adopt option 3. Establish a vendor-adapter layer with:

- **Three neutral interfaces:**
  - **Agent driver** — lifecycle + streaming canonical-message iteration. Required: starting a
    run, and on the returned run handle: reading the session id, iterating messages, aborting.
    Optional run controls (interrupt / set-action-mode / push-input / fork-session) exist iff the
    capability flag is set.
  - **Approval bridge** — intercept → suspend → write back. Required: registering a request
    handler that returns a disposer. For vendors with per-tool approval the handler fires per tool
    and the verdict is written back; without it, it degrades to launch-time policy.
  - **Session store** — the dirtiest coupling (direct transcript reads) sealed behind list / read
    (returning neutral canonical messages), with optional rename / delete.
- **Neutral permission policy** — given a tool name, its input, and context, decide allow / ask /
  deny. The five-way permission-mode 1:1 mapping is **abandoned**; it collapses to two orthogonal
  axes: an action mode (plan / build) × a tool gate (always-ask / on-sensitive / trusted-prefix /
  never-ask). Each adapter translates its native mode(s) into the grid (table below); the grid never
  round-trips back 1:1 (Claude `auto`'s bias and `always-ask`'s lack of a Claude peer are documented
  losses).
- **Capability ledger** — required capabilities have **no flag** (they are the interface contract);
  the ledger holds exactly seven **optional/degradable** flags: interrupt, set-action-mode,
  streaming-push, in-process MCP, fork-session, per-tool-approval, and task-store. The sixth
  (per-tool-approval) is added beyond the original five Claude-proprietary controls because 008
  proved per-tool approval is **not** universal. The seventh (task-store) is the SDK task-tool
  surface, true for all three current vendors.
- **Amendment (this phase) — structured session-lifecycle capability states.** The six flags above
  are honestly boolean (a vendor either has a mid-turn interrupt point or it does not). The
  **session-lifecycle** operations (list / read / resume / rename / delete) are **not**: 008 proved
  the Codex SDK has no listing/reading API; later local transcript readers made Codex rename/delete
  exist behind a REST write-back that is not yet wired, and a remote server that is briefly down
  would be the same shape. A boolean cannot tell "none" (structural NO) apart from
  "temporarily-unavailable" (mechanism exists, not currently reachable), and that distinction is
  exactly what the UI must render. So these ops are graded honestly as a capability state per op:
  none / partial / full / temporarily-unavailable, carried on the ledger as a structured
  session-capabilities sub-ledger. The method _contract_ (every vendor exposes list/read on its
  session store) stays the unconditional interface — methods always _exist_, what each method can
  deliver is what the ledger honestly reports. A new vendor that self-reports its grades is correctly
  degraded with **zero per-vendor branching** in the upper layer. The authoritative matrix as of this
  amendment:

  | op     | Claude | Codex                   | remote |
  | ------ | ------ | ----------------------- | ------ |
  | list   | full   | full                    | full   |
  | read   | full   | full                    | full   |
  | resume | full   | full                    | full   |
  | rename | full   | temporarily-unavailable | none   |
  | delete | full   | temporarily-unavailable | none   |

  The console renders the rename/delete row buttons by capability _state_ (hide on none, disabled
  on temporarily-unavailable, enabled on full/partial) — one degradation function, no vendor
  branching. The wire carries the same matrix on a new top-level session-capabilities-by-vendor
  companion field (parallel to host status / binding stats), orthogonal to host-CLI presence
  (ability vs availability).

- **Canonical message model** — per 010: a required vendor tag; the session id unconditional;
  role / blocks / timestamp / turn id discounted; a two-level vendor-extra overflow (envelope +
  block). Tool returns are **embedded** on the tool-use block (a result field), back-filled by
  id-upsert — there is **no standalone tool-result canonical block** (ruling D3; the incremental
  vendors revise a block in place, which Claude's two-block split folds inward).

**Permission translation (informative):**

| Source                     | → action mode        | → tool gate              |
| -------------------------- | -------------------- | ------------------------ |
| Claude `default`           | build                | on-sensitive             |
| Claude `auto`              | build                | on-sensitive (bias lost) |
| Claude `plan`              | plan                 | on-sensitive             |
| Claude `acceptEdits`       | build                | trusted-prefix           |
| Claude `bypassPermissions` | build                | never-ask                |
| Codex sandbox + approval   | sandbox ⇒ plan/build | approval policy ⇒ gate   |

**Scope (decision D1 — additive-only):** this phase ships the interfaces + a **Claude reference
adapter** that delegates to the existing run loop / permission gateway / session reads (untouched);
folding the live gateway through the approval bridge is a later phase.

> integration (2026-06-06-003): a supervised-server vendor, with out-of-loop per-tool approval and
> a pre-approved audit. The **Codex** adapter shipped as c3's **read-only advisor seat**
> (2026-06-06-005), honouring the 008 NO-GO verbatim: capability ledger **all-false** (per-tool
> approval false), a launch-time sandbox + approval-policy gate substituting for per-tool approval,
> a run-time read-only monitor + whole-turn abort, and a structural pre-approved stamp on every tool
> item (each is auto-allowed by the sandbox gate, never a c3 decision). The MCP-approval fallback
> (§4 escape hatch 2) is left an inert skeleton — Phase 0 judged it a narrow lever (cannot gate
> Codex's built-in shell / apply-patch). Fork-session stays false: 008 killed the branch that would
> have used Codex's thread resume as a fork; that resume instead serves neutral session resume.
>
> **Codex as a primary session driver (2026-06-06-007).** The read-only advisor framing is
> **widened**: a Codex agent can now be a session's primary driver, not only a consensus voter. The
> run launcher forks a Codex run via a host-binary-gated factory. This does **not** reverse 008:
> there is still no per-tool runtime approval (per-tool approval false, the approval bridge never
> fires) — the launch-time sandbox/approval gate is the accepted substitute.
>
> **Codex policy derived from the default mode, not per-agent (2026-06-06-008).** The per-agent
> sandbox/approval-policy config (and its plumbing) of 007 is removed. The launch-time gate is
> derived from the session permission mode the same way every vendor's is — the session's default
> mode → the neutral action-mode × tool-gate grid → the Codex policy translation → Codex's
> sandbox/approval-policy — so one permission knob drives the whole table and a Codex agent needs no
> separate permission configuration. Rationale: the neutral grid already expresses the permission
> intent and the translation already existed as the fallback; 007's explicit override duplicated that
> knob. Accepted trade-off: `default`'s "ask on sensitive" intent has no live channel in Codex's
> non-interactive exec, so it degrades to a static sandbox (the sandbox is the real enforcement). The
> tighter cells dominate — plan / always-ask → read-only.
>
> **Upper-domain heterogeneous tolerance (2026-06-06-006).** The capability ledger also gates the
> _upper_ domains, vendor-homogeneity being their organizing principle: (1) **consensus** votes only
> within the session's own vendor — cross-vendor tool/risk semantics are incomparable, so the outcome
> carries a vendor-scope marker for an honest UI rather than faking a cross-vendor vote; (2)
> **agent-teams** are locked to the streaming-push capability — only Claude can host a resident lead,
> so a non-Claude session never upgrades to a team; (3) the **degradation chain** keeps only
> same-vendor fallbacks — a different vendor cannot resume context, so cross-vendor entries are
> skipped and reported. The heavier cross-vendor machinery (risk-tag-neutralized voting,
> heterogeneous teammates, a replay-seed degradation hand-off with UI-marked context discontinuity)
> is deferred — spec'd, not built, until a real need appears. The principle is **honest UI over faked
> capability** (PG-R13, AS-R21/R22).

> **Claude task store reference implementation (2026-06-07).** The 4th neutral interface (the task
> store) gets its Claude reference, with pure parsing factored out. The Claude Agent SDK has **no
> programmatic single-tool entry point** — its built-in `TaskCreate`/`TaskList`/`TaskUpdate`/`TaskGet`
> tools run only when the model calls them inside a query — so the Claude task store is a **shadow**
> of the SDK task system: every method drives the matching SDK tool through an injected executor and
> folds the parsed result into an in-memory shadow map (keyed by task id). The production executor
> delegates to a minimal one-shot query in the run loop that instructs the model to call exactly one
> task tool while every other tool is disallowed and the gate auto-allows only the driven tool,
> **forcing its exact input** (so the prompt needs no JSON serialization — the JSON-serialization ban
> under the kernel, ADR-0009 R2, stands). Keeping the SDK import in the run loop (not the adapter
> layer) preserves the boundary, exactly as the driver delegates to the existing run loop.
>
> The SDK serializes a task result as a **string**, not a typed object, and the exact format is not
> pinned (a structured result may arrive serialized; the create confirmation is a human line like
> "Created task 1: …"). So each parser is **dual-mode** — JSON first, text regex as fallback — and
> **degrades safely**: an error/garbage output yields empty/absent values, never a throw, and the
> shadow keeps the last good state (a list parse-miss is NOT a clear, mirroring the web task list's
> "无法解析快照时保持现状" rule). Update returns only a confirmation, so the store merges the patch onto
> its shadow entry to return a full task record. A live update push channel is **omitted**: it is
> absent and the upper layer degrades to pull-based list/get (the probe protocol). The store is
> **session-scoped** (it binds its executor to a cwd/model/env/resume context), so it is built per
> session by the upper layer rather than wired onto the stateless no-arg adapter factory — the same
> additive-phase parallel as interrupt / fork-session being vendor-true yet not yet exposed as run
> controls. Tests are hermetic: the executor is mocked, no `claude` process spawns, and they cover the
> JSON+text parse matrix and the shadow-merge/degradation rules.

> **imperative**: the Claude store _drives_ the SDK task tools, so create / update / get all do real
> work. The incremental vendors instead expose the agent's own running plan, which c3 _watches_ but
> does not author. The Codex task store consumes the Codex todo-list thread item — a stable list id
> with a list of text/completed items, a **full snapshot** re-emitted on the item start/update/complete
> events (the driver maps it to a null canonical stream, ADR-0013). The remote vendor's store seeds
> from a REST full-fetch of the session todo list (an init step) then tracks the todo-updated event.
> Both stores: list / get serve an in-memory snapshot; the update-push channel is the **live push
> channel** (present ⇒ the optional-method probe is true, unlike Claude which omits it); and create /
> update **reject** — neither vendor exposes an external write path into the agent's plan, and the
> honesty rule (present ≠ fabricate) bans a fake one.
>
> Three mapping decisions. (1) **Feed seam, not a second stream:** both stores are FED by the driver's
> own event stream the approval bridges are dispatched into, so there is one connection and one
> jitter-recovery, not two. Tests drive these seams directly, hermetic with no process/server. (2)
> **Id synthesis (Codex):** a todo item carries no id, so a stable id is synthesised from the list id
>
> - index (ordering is the only stable handle). (3) **Status mapping:** native statuses map onto the
>   neutral task status — cancelled → completed (no longer active) and any unknown value → pending, both
>   preserving the raw string in a vendor-extra field; priority rides a vendor-extra field. Each
>   frame/event is a full snapshot ⇒ the cache is replaced wholesale and the update-push fires only for
>   **new or changed** tasks (subject/status diff), not the whole list. Like the Claude store, both are
>   **session-scoped** (bound to a session/event stream) and built per session.

> **Vendor mode catalog — token ⇄ grid translation (2026-06-07-012).** The neutral permission grid
> (action mode × tool gate) had been the kernel's internal permission truth since Phase 1, but the
> wire representation of session mode was still Claude's five-value permission mode. The
> generalization replaces it with a **per-vendor vendor mode catalog** — the single source of truth
> for one vendor's native mode tokens. Each mode descriptor pairs a vendor's native token (e.g. Claude
> `plan`, a Codex token) with the grid cell it maps to. Generic token-to-grid / grid-to-token helpers
> turn that declaration into the bidirectional translation every adapter needs.
>
> Three design rules hold. (1) **Catalog IS the interface, no hand-written switches.** Claude's former
> permission map is refactored onto the generic translators driven by Claude's catalog; Codex
> registers its catalog the same way. A by-vendor catalog record provides the compile-time
> exhaustiveness pin — adding a vendor without registering its catalog stops type-checking. (2) **Lossy
> reverse but safe.** The grid → token direction picks the closest declared token (exact cell → same
> action mode → default token) and never crosses the plan/build action boundary. An unknown token on
> the forward path degrades to the vendor's default-token grid — so a stored token from an older/other
> vendor never throws. (3) **Wire always carries the vendor's catalog.** The vendor-modes wire field
> ships the entire record to the web, where the console reads the active session's vendor catalog to
> label the mode and build the dropdown — the same by-vendor, no-branching pattern as the capability
> ledgers.

**Probe protocol.** A capability flag reports the **vendor** ability. A caller reaching for an
optional control checks the flag **and** that the run handle actually exposes the method (the
build-wiring probe), then degrades when either is false. The reference Claude adapter wires the
controls reachable through the run handle this phase (set-action-mode, push-input); interrupt /
fork-session are vendor-true but exposed only after the rewrite phase. The invariant the contract
test pins is the safe direction: a method **present ⇒ its flag is true** (no false method without
capability).

## Consequences

- **Easier:** a new vendor adds a sibling adapter implementing the three interfaces and declaring its
  capability ledger; the upper layer drives it through the neutral faces with no new Claude
  assumptions. The required-vs-optional line is mechanically checked (a contract test pins that the
  capability ledger is exactly the seven optional flags and the required surface is always present).
- **Harder:** the neutral permission grid is coarser than Claude's five modes — `auto`'s bias and an
  always-ask gate have no exact Claude peer (documented losses, surfaced at the translation site).
  A future UI that wants the lost nuance must re-introduce it as a vendor extra, not the neutral grid.
- **Boundary:** no vendor SDK type appears in the neutral interface surface or the shared wire
  contract; SDK values cross as `unknown` and are narrowed inside each vendor's adapter. A grep gate
  enforces this (Compliance below).
- **Migration:** additive — the existing run loop and gateway are unchanged, so this phase is a pure
  add with all existing behavior intact. The reference adapter is the conformance witness; the
  run-loop rewrite that makes the driver the _only_ path is a separate, revertible phase.

## Compliance

- The Claude Agent SDK import MUST NOT appear in the shared wire contract (SDK never enters the wire
  contract). The grep targets the **import** form, not the bare string — a prose mention in a doc
  comment is allowed.
- The Claude Agent SDK import MUST NOT appear in the vendor-adapter layer (SDK types never reach the
  neutral surface; adapters narrow from `unknown` or delegate to existing SDK-narrowing kernel code
  such as the session reads). The neutral interface surface names the SDK only in a boundary-rule
  comment.
- The vendor-adapter layer MUST NOT import the features or transport layers (ADR-0009 R1).
- `pnpm typecheck` + `pnpm lint` MUST be green.
- `pnpm vitest run` MUST be green: the vendor-agnostic contract pins the required surface + seven
  boolean flags + the session sub-ledger; a capabilities test pins the authoritative
  session-capability matrix end-to-end; the Claude conformance reports every session op full for the
  reference adapter; and the web session list exercises the row-action gating by capability _state_
  (none ⇒ hidden, temporarily-unavailable ⇒ disabled, full ⇒ enabled) without a single per-vendor
  branch.

## References

- [ADR 0009](0009-unidirectional-boundaries.md) — unidirectional boundaries; the SDK-never-leaves-kernel
  rule this ADR extends to the neutral surface.
- [ADR 0005](0005-inherit-user-project-settings.md) — c3 is the permission gateway (the role the neutral
  approval bridge generalizes across vendors).
- [agent-session spec](../../domains/core/agent-session/spec.md) — the run lifecycle the agent driver
  abstracts; the permission-mode table the neutral grid replaces.
- Phase-0 probes: `changes/2026/06/05/2026-06-05-008-codex-approval-probe/` (NO-GO).
- This phase's spec: `changes/2026/06/05/2026-06-05-011-vendor-neutral-agent-abstraction/spec.md`.
