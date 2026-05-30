# 0007 — Read-only requirement-communication agent; save via tool-confirmation; cross-runtime SQLite

- **Status:** accepted
- **Date:** 2026-05-30

## Context

The requirement-management feature adds a per-project requirement ledger and a long-lived agent
that helps the user break ideas into verifiable requirement items. That agent must be able to
**read** project material to reason well, but must **never** mutate the project — it is a
planning/analysis surface, not a coding session. Persisting a requirement must be a deliberate,
human-confirmed act, and the ledger must work both under `node cli.cjs` (Node) and the Bun single
binary, which expose different built-in SQLite modules.

Three decisions are coupled enough to record together:

1. How to make the communication agent genuinely read-only (not merely instructed to be).
2. How to persist a requirement only on explicit human confirmation.
3. How to store the ledger across two runtimes with different SQLite drivers.

## Options considered

1. **Read-only by system prompt only.** Tell the agent not to write. _Con:_ unenforced — the
   model can still call `Write`/`Bash`, or spawn a sub-agent or slash command that writes, and a
   prompt cannot stop it. Rejected as the _sole_ mechanism.
2. **Read-only by tool layer + deny-by-default gateway (chosen).** Disallow all write/exec/orchestration
   tools and deny anything unexpected at `canUseTool`. _Con:_ must keep the disallow list and gate
   in sync with the SDK's tool surface. _Pro:_ defense in depth; a new SDK write tool is still
   denied by the gateway default.
3. **Save by a free-form agent action (auto-persist).** _Con:_ no human checkpoint; violates the
   "human decides" posture and risks junk in the ledger. Rejected.
4. **Save via a confirmation that reuses the permission gateway (chosen).** A `save_requirements`
   MCP tool routes through the existing `canUseTool` → `permission_request` flow; the write
   happens in the tool handler only after the user allows.
5. **SQLite via a third-party npm driver bundled in.** _Con:_ native bindings complicate the Bun
   single binary; redundant with built-ins. Rejected.
6. **SQLite via a thin driver adapter over the runtime built-ins (chosen).** `node:sqlite` on
   Node, `bun:sqlite` on Bun, behind one minimal synchronous interface selected by
   `globalThis.Bun`.

## Decision

Adopt options 2, 4, and 6 together.

- **Read-only is enforced at the tool layer, double-locked.** The communication run sets
  `disallowedTools` including `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash`/`BashOutput`/
  `KillShell`/**`Task`**/**`SlashCommand`** — `Task` and `SlashCommand` are essential because a
  sub-agent's tool calls bypass the parent `canUseTool`, and slash commands could trigger
  file-writing skills. On top of that, the `canUseTool` gate for this run **denies by default**:
  read-class tools auto-allow, `mcp__c3__save_requirements` raises a confirmation, everything else
  is denied — so even a future SDK write tool not in the disallow list is still blocked.
- **The communication run is forced to `permissionMode: 'default'`,** never inheriting the system
  default mode. Under `bypassPermissions` the SDK does not call `canUseTool`, which would let
  `save_requirements` persist silently — unacceptable. `set_mode` is ignored for this run and the
  UI shows no mode selector.
- **Saving reuses the permission gateway.** `save_requirements` (an in-process MCP tool,
  `mcp__c3__save_requirements`) flows through the existing `canUseTool` → `permission_request` /
  `permission_response` path; the tool handler writes to the ledger only after the user allows,
  and reports an error result to the agent on deny/failure.
- **The ledger uses a cross-runtime SQLite driver adapter.** One minimal synchronous interface
  (`exec`/`run`/`all`/`get`) selects `bun:sqlite` vs `node:sqlite` by `globalThis.Bun`; the two
  never cross. Adapters use only `?` placeholders and read rows by field. esbuild must mark both
  modules `external` (a dynamic `import()` alone does not satisfy the bundler). The store at
  `~/.c3/c3.db` fails soft: on open/create failure requirement features degrade per entry point
  and c3 still boots.

## Consequences

- **Easier:** the communication agent can freely read the repo while being structurally unable to
  modify it; persistence always passes through the same human confirmation users already know; the
  ledger ships in both the Node and Bun builds with no native dependency.
- **Harder:** the disallow list and gateway default must track the SDK's evolving tool set; the
  forced-`default` rule is a special case the requirement runtime must preserve; two SQLite driver
  surfaces (placeholder/row-shape differences) must stay behind the adapter; esbuild config carries
  two mandatory `external` entries.
- **Reuse, not new mechanism:** no new permission transport — the save confirmation is the existing
  `permission_request`/`permission_response` pair with a specialized frontend render.

## Compliance

- The communication run MUST set `disallowedTools` (incl. `Task`/`SlashCommand`),
  `gate==='requirement'` deny-by-default, and `permissionMode: 'default'`. Reviewers reject any
  path that lets it write, spawn a sub-agent, run a slash command, or run under a non-`default`
  mode.
- A requirement MUST be persisted only inside the `save_requirements` handler, after a human
  allow. No code path may write the ledger to bypass that confirmation.
- The SQLite driver MUST be selected by `globalThis.Bun`; `'node:sqlite'` and `'bun:sqlite'` MUST
  be in esbuild `external`. The store MUST fail soft so c3 boots without it.

## References

- [requirement-management spec](../../domains/core/requirement-management/spec.md)
- [requirement-management design](../../domains/core/requirement-management/design.md)
- [permission-gateway spec](../../domains/core/permission-gateway/spec.md) — the reused
  `canUseTool` flow.
- [ADR 0006](0006-decouple-runs-from-connections.md) — the runtime registry the communication and
  development runs reuse.
- [WebSocket protocol](../../shared/api-conventions/websocket-protocol.md) — `permission_request`,
  `permission_response`, `select_session`, and the new requirement messages.
