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
  read-class tools auto-allow, the save-intents MCP tool raises a confirmation,
  `AskUserQuestion` is allowed (routed via answer-injection — see below), everything else is
  denied — so even a future SDK write tool not in the disallow list is still blocked. The
  read-class auto-allow set includes, besides the read built-ins (`Read`/`Grep`/`Glob`/`LS`/…),
  the **two read-only c3 intent-query MCP tools** (`mcp__c3__find_intents` and
  `mcp__c3__view_intent`) — they only read the agent's **own** project ledger
  (project-bound when the tool is constructed, like the save tool), so they carry no write/exec
  side effect and need no confirmation. The gate's tool routing is a pure, unit-tested
  classifier mapping each tool to allow / confirm-save / ask / deny.
- **`AskUserQuestion` is allowed as an _interactive_, not a _write_, tool.** It only poses
  clarifying questions to the human and carries no file/exec/orchestration side effects, so letting
  the read-only agent ask the user does not violate the read-only posture — it is the same
  human-in-the-loop dialogue the agent already has, just structured. It is therefore **kept out of
  the disallow list** and admitted by the gate. It is _not_ a plain allow: the SDK only echoes an
  answer when the tool input already carries answers, so the gate prompts the human via
  `permission_request` and, on allow, returns the input with the answers injected (deny on
  cancel). It runs **without consensus** (single agent, no voting party), and an empty/invalid
  question set falls through to the default deny.
- **The communication run is forced to `permissionMode: 'default'`,** never inheriting the system
  default mode. Under `bypassPermissions` the SDK does not call `canUseTool`, which would let
  the save persist silently — unacceptable. `set_mode` is ignored for this run and the
  UI shows no mode selector.
- **Saving reuses the permission gateway.** The save-intents action (an in-process MCP tool,
  `mcp__c3__save_intents`) flows through the existing `canUseTool` → `permission_request` /
  `permission_response` path; the tool handler writes to the ledger only after the user allows,
  and reports an error result to the agent on deny/failure.
- **The save tool is pinned resident (`alwaysLoad`).** The c3 in-process MCP server is built with
  `createSdkMcpServer({ alwaysLoad: true })`, which stamps `_meta['anthropic/alwaysLoad']` on each
  tool (≡ API `defer_loading: false`). Otherwise the harness's tool search defers the MCP tool, and
  the agent must `ToolSearch` the save-tool schema back before every save — an extra
  round-trip and token cost on the hot path. `alwaysLoad` only keeps the **schema** resident; it
  does **not** bypass the gate — `canUseTool` still raises the human confirmation. The
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
  apply the intent gate's deny-by-default, and run under `permissionMode: 'default'`. Reviewers
  reject any path that lets it write, spawn a sub-agent, run a slash command, or run under a
  non-`default` mode.
- A intent MUST be persisted only inside the save-intents tool handler, after a human
  allow. No code path may write the ledger to bypass that confirmation.
- The read-only query tools MUST be project-bound when constructed (never trust a wire-supplied
  project) and MUST be auto-allowed by the gate without a confirmation; they are read-only and may
  not write the ledger. Reviewers reject any path that lets them read another project, or that turns
  them into a write/confirm tool.
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

- [intent-management spec](../../domains/core/intent-management/spec.md)
- [intent-management design](../../domains/core/intent-management/design.md)
- [permission-gateway spec](../../domains/core/permission-gateway/spec.md) — the reused
  `canUseTool` flow.
- [ADR 0006](0006-decouple-runs-from-connections.md) — the runtime registry the communication and
  development runs reuse.
- [WebSocket protocol](../../shared/api-conventions/websocket-protocol.md) — `permission_request`,
  `permission_response`, `select_session`, and the new intent messages.
