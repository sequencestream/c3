# 0007 — Read-only intent-communication agent; save via tool-confirmation; cross-runtime SQLite

- **Status:** accepted
- **Date:** 2026-05-30

## Context

The intent-management feature adds a per-project intent ledger and a long-lived agent
that helps the user break ideas into verifiable intent items. That agent must be able to
**read** project material to reason well, but must **never** mutate the project — it is a
planning/analysis surface, not a coding session. Persisting a intent must be a deliberate,
human-confirmed act, and the ledger must work both under the Node CJS bundle and the Bun single
binary, which expose different built-in SQLite modules.

Three decisions are coupled enough to record together:

1. How to make the communication agent genuinely read-only (not merely instructed to be).
2. How to persist a intent only on explicit human confirmation.
3. How to store the ledger across two runtimes with different SQLite drivers.

## Options considered

1. **Read-only by system prompt only.** Tell the agent not to write. _Con:_ unenforced — the
   model can still call `Write`/`Bash`, or spawn a sub-agent or slash command that writes, and a
   prompt cannot stop it. Rejected as the _sole_ mechanism.
2. **Read-only by tool layer + deny-by-default gateway (chosen).** Disallow all write/exec/orchestration
   tools and deny anything unexpected at `canUseTool`, while still admitting purely _interactive_
   tools (`AskUserQuestion`) that have no write side effects. _Con:_ must keep the disallow list and
   gate in sync with the SDK's tool surface, and classify each new tool as write vs interactive.
   _Pro:_ defense in depth; a new SDK write tool is still denied by the gateway default.
3. **Save by a free-form agent action (auto-persist).** _Con:_ no human checkpoint; violates the
   "human decides" posture and risks junk in the ledger. Rejected.
4. **Save via a confirmation that reuses the permission gateway (chosen).** A save-intents
   MCP tool routes through the existing `canUseTool` → `permission_request` flow; the write
   happens in the tool handler only after the user allows.
5. **SQLite via a third-party npm driver bundled in.** _Con:_ native bindings complicate the Bun
   single binary; redundant with built-ins. Rejected.
6. **SQLite via a thin driver adapter over the runtime built-ins (chosen).** `node:sqlite` on
   Node, `bun:sqlite` on Bun, behind one minimal synchronous interface selected by
   `globalThis.Bun`.

## Decision

Adopt options 2, 4, and 6 together.

- **Read-only is enforced at the tool layer, double-locked.** The communication run disallows
  all write/exec tools — `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash`/`BashOutput`/
  `KillShell` — plus **`Task`** and **`SlashCommand`** — the last two are essential because a
  sub-agent's tool calls bypass the parent `canUseTool`, and slash commands could trigger
  file-writing skills. On top of that, the `canUseTool` gate for this run **denies by default**:
  read-class tools auto-allow, the save-intents MCP tool is **allowed through to its handler**
  (the handler raises the confirmation itself — see "Saving" below),
  `AskUserQuestion` is allowed (routed via answer-injection — see below), everything else is
  denied — so even a future SDK write tool not in the disallow list is still blocked. The
  read-class auto-allow set includes, besides the read built-ins (`Read`/`Grep`/`Glob`/`LS`/…),
  the **two read-only c3 intent-query MCP tools** (`mcp__c3__find_intents` and
  `mcp__c3__view_intent`) — they only read the agent's **own** project ledger
  (project-bound when the tool is constructed, like the save tool), so they carry no write/exec
  side effect and need no confirmation. The gate's tool routing is a pure, unit-tested
  classifier mapping each tool to allow / ask / deny.
  - **The same two read-only query tools also serve the spec-authoring session.** The spec session
    (write-confined to its spec directory; intent-management spec RM-R21 / RM-R27) is given the
    **same** `find_intents` / `view_intent` tools so the author can ground the spec against existing
    intents — but **never** `save_intents` (a spec session may not write the ledger). To avoid
    dragging the save-gate dependencies into the spec path, this is a **separate, smaller in-process
    MCP constructor** registering only the two read-only tools (not a filtered reuse of the intent
    server). Project-bound + read-only + `alwaysLoad` are identical. The spec permission gate's
    read-pass set is an **explicit** read-only union (read built-ins ∪ the two query tools), so
    `save_intents` falls to **deny-by-default** there even if it were ever mis-registered or
    vendor-preapproved — unlike the intent gate, which deliberately lets save through to its
    handler-owned confirmation. Spec is **claude-only** (the path-level write lock), so these tools
    ride only the in-process SDK MCP server; there is no driver/HTTP MCP route for a spec session.
- **`AskUserQuestion` is allowed as an _interactive_, not a _write_, tool.** It only poses
  clarifying questions to the human and carries no file/exec/orchestration side effects, so letting
  the read-only agent ask the user does not violate the read-only posture — it is the same
  human-in-the-loop dialogue the agent already has, just structured. It is therefore **kept out of
  the disallow list** and admitted by the gate. It is _not_ a plain allow: the SDK only echoes an
  answer when the tool input already carries answers, so the gate prompts the human via
  `permission_request` and, on allow, returns the input with the answers injected (deny on
  cancel). It runs **without consensus** (single agent, no voting party), and an empty/invalid
  question set falls through to the default deny.
- **The communication run is forced to `permissionMode: 'default'`** (an _auxiliary_ constraint,
  no longer the primary defence against silent persistence — see "Saving" below). `set_mode` is
  ignored for this run and the UI shows no mode selector.
- **The save confirmation lives in the save handler, not `canUseTool`.** The save-intents action
  (an in-process MCP tool, `mcp__c3__save_intents`) was originally gated by `canUseTool` — but a
  vendor's own permission-rule engine can _pre-approve_ a tool and thereby **skip `canUseTool`
  entirely** (e.g. a user/project allow-rule matching `mcp__c3__save_intents`, or a non-`default`
  permission mode). That made the confirmation bypassable and let a save persist silently. So the
  confirmation gate is **sunk into the save handler itself**: the handler emits the same
  `permission_request` wire frame, blocks on the user's decision, and persists only on `allow`.
  Because the gate is now the handler's _single execution point_ — reached whenever the tool is
  called, and vendor rules only decide _whether_ to call it — it is immune to every pre-approval
  vector. This also **converges both vendors on one gate**: the codex/driver path (which calls the
  intent tools over HTTP MCP, outside any `canUseTool`) already gated inside the handler, and the
  claude in-process path now matches it. The intent gate therefore _allows_ save through to the
  handler (no `confirm-save` branch); on deny/failure the handler reports an error result to the
  agent and the ledger is untouched.
- **The save tool is pinned resident (`alwaysLoad`).** The c3 in-process MCP server is built with
  `createSdkMcpServer({ alwaysLoad: true })`, which stamps `_meta['anthropic/alwaysLoad']` on each
  tool (≡ API `defer_loading: false`). Otherwise the harness's tool search defers the MCP tool, and
  the agent must `ToolSearch` the save-tool schema back before every save — an extra
  round-trip and token cost on the hot path. `alwaysLoad` only keeps the **schema** resident; it
  does **not** bypass the gate — the save handler still raises the human confirmation. The
  blocks-startup-until-connected side effect of `alwaysLoad` is moot here: an in-process MCP server
  connects instantly. Scope is the intent agent only, since the c3 MCP server is built solely on
  the intent-agent launch path. The same server carries the two read-only query tools, which
  inherit `alwaysLoad` for the same reason — the agent must not have to ToolSearch them back
  before checking for related intents.
  - **Limitation (recorded, not yet solvable):** built-in tools the agent also uses
    (`AskUserQuestion`, `Read`/`Grep`/`Glob`/`LS`) have **no** always-load lever in
    `@anthropic-ai/claude-agent-sdk` 0.3.158 — `ToolConfig` exposes only
    `askUserQuestion.previewFormat`, and there is no global tool-search toggle in `Options`. So those
    may still be deferred behind tool search. **Trigger to revisit:** when the SDK exposes a
    built-in-tool `alwaysLoad` (or an `Options`-level tool-search switch), extend the residency to
    the read-only/interactive built-in set the same way.
- **The ledger uses a cross-runtime SQLite driver adapter.** One minimal synchronous interface
  (execute / run / all-rows / single-row) selects `bun:sqlite` vs `node:sqlite` by `globalThis.Bun`;
  the two never cross. Adapters use only positional `?` placeholders and read rows by field. The
  bundler must mark both modules `external` (a dynamic import alone does not satisfy the bundler).
  The store at `~/.c3/c3.db` fails soft: on open/create failure intent features degrade per entry
  point and c3 still boots.

## Consequences

- **Easier:** the communication agent can freely read the repo while being structurally unable to
  modify it; persistence always passes through the same human confirmation users already know; the
  ledger ships in both the Node and Bun builds with no native dependency.
- **Harder:** the disallow list and gateway default must track the SDK's evolving tool set; the
  forced-`default` rule is a special case the intent runtime must preserve; two SQLite driver
  surfaces (placeholder/row-shape differences) must stay behind the adapter; esbuild config carries
  two mandatory `external` entries.
- **Reuse, not new mechanism:** no new permission transport — the save confirmation is the existing
  `permission_request`/`permission_response` pair with a specialized frontend render.

## Compliance

- The communication run MUST disallow write/exec/orchestration tools (incl. `Task`/`SlashCommand`),
  apply the intent gate's deny-by-default, and run under `permissionMode: 'default'` (an auxiliary
  constraint — the save confirmation no longer depends on it). Reviewers reject any path that lets it
  write, spawn a sub-agent, or run a slash command.
- A intent MUST be persisted only inside the save-intents tool handler, after a human allow, and the
  save confirmation MUST be raised **by that handler** (not solely by `canUseTool`), so a vendor
  pre-approval that skips `canUseTool` still prompts. No code path may write the ledger to bypass that
  confirmation, and the intent gate MUST NOT additionally prompt for save (it allows save through to
  the handler — double-prompting is a regression). Both vendors MUST share this one handler-owned gate.
- The read-only query tools MUST be project-bound when constructed (never trust a wire-supplied
  project) and MUST be auto-allowed by the gate without a confirmation; they are read-only and may
  not write the ledger. Reviewers reject any path that lets them read another project, or that turns
  them into a write/confirm tool.
- The spec-authoring session MUST be given ONLY the two read-only query tools (no `save_intents`),
  project-bound, via the in-process SDK MCP (claude-only — no driver/HTTP MCP route). The spec
  permission gate MUST allow only an explicit read-only set (read built-ins ∪ the two query tools)
  so `save_intents` is denied-by-default there. Reviewers reject giving a spec session any write
  ledger tool, a cross-project read, or a driver-path intent MCP route.
- The c3 MCP server MUST keep the save tool resident (`alwaysLoad: true`) so it is not
  deferred behind tool search. Reviewers reject dropping `alwaysLoad`, and reject any reading of it
  as a permission relaxation — it pins the schema only; the gate confirmation is unchanged.
- `AskUserQuestion` MUST stay out of the disallow list and be admitted by the intent gate as
  an interactive (non-write) tool, but only through the answer-injection path (prompt the human,
  inject the answers on allow, deny on cancel) — never a plain allow. Reviewers reject treating
  it as a write tool (over-restrictive) or as an auto-allow read tool (the injected answer would be
  lost).
- The SQLite driver MUST be selected by `globalThis.Bun`; both `node:sqlite` and `bun:sqlite` MUST
  be marked `external` to the bundler. The store MUST fail soft so c3 boots without it.

## References

- [intent-management spec](../../domains/core/intent-management/intent-management-spec.md)
- [intent-management design](../../domains/core/intent-management/intent-management-design.md)
- [permission-gateway spec](../../domains/core/permission-gateway/permission-gateway-spec.md) — the reused
  `canUseTool` flow.
- [ADR 0006](0006-decouple-runs-from-connections.md) — the runtime registry the communication and
  development runs reuse.
- [WebSocket protocol](../../shared/api-conventions/websocket-protocol.md) — `permission_request`,
  `permission_response`, `select_session`, and the new intent messages.
