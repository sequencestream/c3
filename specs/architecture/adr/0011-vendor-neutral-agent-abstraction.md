# 0011 — Vendor-neutral Agent abstraction: three-piece interface + capability ledger

- **Status:** accepted
- **Date:** 2026-06-05

## Context

Through ADR-0010 c3 was a Claude-only product: the run loop (`kernel/agent/index.ts`)
imports `@anthropic-ai/claude-agent-sdk` directly, the permission gateway returns the SDK's
`PermissionResult`, session history is read straight from Claude's JSONL transcripts
(`sessions.ts`), and the wire `PermissionMode` is the SDK's five-way union verbatim. To support
other agent vendors (OpenAI Codex, OpenCode) without forking the product, c3 needs a vendor-neutral
layer the rest of the kernel can drive, with each vendor's SDK quirks sealed behind it.

Three Phase-0 probes established the ground truth that any neutral interface must respect — the
vendors do **not** share one mechanism:

- **008 (Codex) — NO-GO on per-tool runtime approval.** The Codex SDK closes the child's stdin
  (`stdin.end()`) after dispatching a turn; its event stream is read-only with no write-back
  half-channel and no "approval request" event. A tool can only be allowed/denied for the **whole
  turn** via `AbortSignal`. There is no in-the-loop interception point.
- **009 (OpenCode) — GO, but out-of-loop.** OpenCode approves via a `permission.updated` event +
  a REST write-back (`POST /session/{id}/permissions/{permissionID}`), needing a Promise bridge,
  a timeout default-deny (~600 ms), and reconnect reconciliation. Its lifecycle is a remote
  long-running server, not an in-process child.
- **010 (message diff) — narrow common set.** Across the three vendors only `sessionId` is an
  unconditional common field; `role` (Codex must synthesize it), `blocks` (append-with-upsert, not
  stack), `ts` (only OpenCode is authoritative — c3 stamps the rest), and `turnId?` (droppable)
  carry discounts. Everything else ("宁丢勿强塞") belongs in a `vendorExtra` overflow, not a faked
  top-level union.

A naïve "make everyone look like Claude" interface would lie about all three. The boundary rule
from ADR-0009 (SDK types never leave the kernel, never enter `shared/protocol.ts`) must also hold
for whatever shape we pick.

## Options considered

1. **Widen the Claude types into the shared interface.** Promote `PermissionMode`, the SDK message
   shapes, and `canUseTool` to the neutral surface. _Con:_ enshrines Claude-isms the other vendors
   can't honor (Codex has no per-tool approval; nobody else has a five-way mode), and drags SDK
   types toward `shared/` — a direct ADR-0009 violation.
2. **One fat interface with every capability required.** Force every adapter to implement
   interrupt / fork / in-process MCP / per-tool approval. _Con:_ Codex physically cannot do per-tool
   approval (008); a required method it can only throw on is worse than an absent one — the upper
   layer can't degrade gracefully because it can't tell.
3. **A required common subset + a probed capability ledger for everything divergent.** Three neutral
   interfaces (driver / approval / session-store) whose _required_ surface every vendor satisfies,
   plus an `AdapterCapabilities` ledger of optional/degradable flags the upper layer probes before
   reaching for a divergent control. Permission collapses to an orthogonal 2-axis grid; SDK values
   cross as `unknown` and are narrowed inside `adapters/<vendor>/`. _Pro:_ honest about the probes,
   keeps SDK types in the kernel, lets the upper layer degrade per-vendor. _Con:_ the additive phase
   ships the Claude adapter delegating to the existing `runClaude` rather than replacing it; the
   full rewrite (folding the gateway + run loop through the driver) is a later phase.

## Decision

Adopt option 3. Establish `server/src/kernel/agent/adapters/` with:

- **Three neutral interfaces** (`adapters/types.ts`):
  - `AgentDriver` — lifecycle + streaming canonical-message iteration. Required: `start`, and on the
    returned `AgentRun`: `sessionId()`, `messages()`, `abort()`. Optional run controls
    (`interrupt` / `setActionMode` / `pushInput` / `forkSession`) exist iff the capability flag is set.
  - `ApprovalBridge` — intercept → suspend → write back. Required: `onRequest(handler) → disposer`.
    For vendors with `perToolApproval` the handler fires per tool and the verdict is written back
    (Claude resolves the blocking callback; OpenCode POSTs). For Codex it never fires — approval
    degrades to launch-time policy.
  - `SessionStore` — the dirtiest coupling (direct JSONL reads) sealed behind `list` / `read`
    (returns neutral `CanonicalMessage[]`), with optional `rename` / `delete`.
- **Neutral permission policy** — `(toolName, input, ctx) → allow | ask | deny`. The five-way
  `PermissionMode` 1:1 mapping is **abandoned**; it collapses to two orthogonal axes:
  `ActionMode { plan, build }` × `ToolGate { always-ask, on-sensitive, trusted-prefix, never-ask }`.
  Each adapter translates its native mode(s) into the grid (table below); the grid never round-trips
  back 1:1 (Claude `auto`'s bias and `always-ask`'s lack of a Claude peer are documented losses).
- **AdapterCapabilities** — required capabilities have **no flag** (they are the interface contract);
  the ledger holds exactly six **optional/degradable** flags: `interrupt`, `setActionMode`,
  `streamingPush`, `inProcessMcp`, `forkSession`, and `perToolApproval`. The sixth is added beyond the
  original five Claude-proprietary controls because 008 proved per-tool approval is **not** universal.
- **Canonical message model** — per 010: `vendor` tag required; `sessionId` unconditional;
  `role`/`blocks`/`ts`/`turnId?` discounted; `vendorExtra` two-level overflow (envelope + block).
  Tool returns are **embedded** on the `tool_use` block (`result?`), back-filled by id-upsert — there
  is **no standalone `tool_result` canonical block** (ruling D3; the incremental vendors revise a
  block in place, which Claude's two-block split folds inward).

**Permission translation (informative):**

| Source                         | → ActionMode         | → ToolGate               |
| ------------------------------ | -------------------- | ------------------------ |
| Claude `default`               | build                | on-sensitive             |
| Claude `auto`                  | build                | on-sensitive (bias lost) |
| Claude `plan`                  | plan                 | on-sensitive             |
| Claude `acceptEdits`           | build                | trusted-prefix           |
| Claude `bypassPermissions`     | build                | never-ask                |
| Codex `sandboxMode`+`approval` | sandbox ⇒ plan/build | approvalPolicy ⇒ gate    |
| OpenCode permission model      | build                | on-sensitive             |

**Scope (decision D1 — additive-only):** this phase ships the interfaces + a **Claude reference
adapter** that delegates to the existing `runClaude` / permission gateway / `sessions.ts` (untouched),
proving the interface is satisfiable. Codex / OpenCode adapters and the run-loop rewrite (folding the
live gateway through `ApprovalBridge`) are later phases.

> **Status (later phases landed).** The **OpenCode** adapter shipped as the first full non-Claude
> integration (2026-06-06-003): supervised server, out-of-loop `perToolApproval: true`, preApproved
> audit. The **Codex** adapter shipped as c3's **read-only advisor seat** (2026-06-06-005), honouring
> the 008 NO-GO verbatim: capability ledger **all-false** (`perToolApproval: false`), launch-time
> `sandboxMode`+`approvalPolicy` gate substituting for per-tool approval, run-time read-only monitor +
> whole-turn abort, and a structural `preApproved: true` stamp on every tool item (each is auto-allowed
> by the sandbox gate, never a c3 decision). The MCP-approval fallback (§4 escape hatch 2) is left an
> inert skeleton — Phase 0 judged it a narrow lever (cannot gate Codex's built-in `shell`/`apply_patch`).
> `forkSession` stays false: 008 killed the branch that would have used `resumeThread` as a fork;
> `resumeThread` instead serves neutral session `resume`.
>
> **Upper-domain heterogeneous tolerance (2026-06-06-006).** The capability ledger also gates the
> _upper_ domains, vendor-homogeneity being their organizing principle: (1) **consensus** votes only
> within the session's own vendor (`vendorScopedVoters`) — cross-vendor tool/risk semantics are
> incomparable, so the outcome carries `vendorScope`/`crossVendorExcluded` for an honest UI rather than
> faking a cross-vendor vote; (2) **agent-teams** are locked to `streamingPush` (`canFormTeam`) — only
> Claude can host a resident lead, so a non-Claude session never upgrades to `team`; (3) the
> **degradation chain** keeps only same-vendor fallbacks (`buildAgentsToTry`) — a different vendor cannot
> `resume` context, so cross-vendor entries are skipped and reported (`crossVendorSkipped`). The heavier
> cross-vendor machinery (risk-tag-neutralized voting, heterogeneous teammates, a replay-seed degradation
> hand-off with UI-marked context discontinuity) is deferred — spec'd, not built, until a real need
> appears. The principle is **honest UI over faked capability** (PG-R13, AS-R21/R22).

**Probe protocol.** A capability flag reports the **vendor** ability. A caller reaching for an optional
control checks the flag **and** `typeof run.method === 'function'` (the build-wiring probe), then
degrades when either is false. The reference Claude adapter wires the controls reachable through
`RunHandle` this phase (`setActionMode`, `pushInput`); `interrupt` / `forkSession` are vendor-true but
exposed only after the rewrite phase. The invariant the contract test pins is the safe direction: a
method **present ⇒ its flag is true** (no false method without capability).

## Consequences

- **Easier:** a new vendor adds a sibling `adapters/<vendor>/` implementing the three interfaces and
  declaring its capability ledger; the upper layer drives it through the neutral faces with no new
  Claude assumptions. The required-vs-optional line is mechanically checked (`types.test.ts`:
  capability ledger is exactly the six optional flags; required surface always present).
- **Harder:** the neutral permission grid is coarser than Claude's five modes — `auto`'s bias and an
  `always-ask` gate have no exact Claude peer (documented losses, surfaced in `permission-map.ts`).
  A future UI that wants the lost nuance must re-introduce it as a vendor extra, not the neutral grid.
- **Boundary:** no vendor SDK type appears in `adapters/types.ts` or `shared/protocol.ts`; SDK values
  cross as `unknown` and are narrowed inside `adapters/<vendor>/`. `git grep` enforces this
  (Compliance below).
- **Migration:** additive — `runClaude` and the gateway are unchanged, so this phase is a pure add
  with all existing behavior intact. The reference adapter is the conformance witness; the run-loop
  rewrite that makes the driver the _only_ path is a separate, revertible phase.

## Compliance

- `git grep "from '@anthropic-ai/claude-agent-sdk'" shared/` MUST be empty (SDK never enters the wire
  contract). The grep targets the **import** form, not the bare string — a prose mention in a doc comment
  is allowed.
- `git grep "from '@anthropic-ai/claude-agent-sdk'" server/src/kernel/agent/adapters/` MUST be empty (SDK
  types never reach the neutral surface; adapters narrow from `unknown` or delegate to existing
  SDK-narrowing kernel code such as `sessions.ts`). The neutral `adapters/types.ts` names the SDK only in
  a boundary-rule comment.
- `git grep -E "from '\.\./\.\./(features|transport)'" server/src/kernel/agent/adapters/` MUST be empty
  (ADR-0009 R1).
- `pnpm typecheck` + `pnpm lint` MUST be green.
- `pnpm vitest run server/src/kernel/agent/adapters` MUST be green: the vendor-agnostic contract
  (`types.test.ts`) and the Claude conformance (`claude/claude.test.ts`) pin the required surface, the
  six-flag capability ledger, the permission grid round trip, the approval write-back, and the D3
  embedded-result translation.

## References

- [ADR 0009](0009-unidirectional-boundaries.md) — unidirectional boundaries; the SDK-never-leaves-kernel
  rule this ADR extends to the neutral surface.
- [ADR 0005](0005-inherit-user-project-settings.md) — c3 is the permission gateway (the role the neutral
  `ApprovalBridge` generalizes across vendors).
- [agent-session spec](../../domains/core/agent-session/spec.md) — the run lifecycle the `AgentDriver`
  abstracts; `PermissionMode` table the neutral grid replaces.
- Phase-0 probes: `changes/2026/06/05/2026-06-05-008-codex-approval-probe/` (NO-GO),
  `…-009-opencode-approval-poc/` (GO), `…-010-canonical-message-field-diff/` (common set).
- This phase's spec: `changes/2026/06/05/2026-06-05-011-vendor-neutral-agent-abstraction/spec.md`.

```

```
