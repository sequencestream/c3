# Constitution — c3

The project's highest-level constraints. These rarely change and override every spec,
design, and line of code. A change here requires the maintainer's explicit sign-off
(see Amendment procedure).

## Mission & values

**Mission:** Let a human approve Claude Code's sensitive tool use from a browser, safely,
on the local machine.

**Values, in priority order** (higher wins on conflict):

1. **Safety of the decision boundary** — no sensitive tool runs without an authorized
   decision. This outranks everything.
2. **Correctness of the wire contract** — the browser and server agree on message shapes
   at all times. A corrupt or ambiguous protocol is worse than a missing feature.
3. **Local-first simplicity** — single user, single project, single process. Prefer the
   simple local design over generality.
4. **Developer ergonomics** — readable tool inputs, fast feedback, easy build.

**Tie-break rule:** when two values conflict, satisfy the higher-priority one and document
the trade-off in the relevant ADR.

## Tech stack baseline

**Allowed core stack:** TypeScript (strict), Node.js / Bun runtime, Hono (HTTP + WS),
Vue 3 + Vite (frontend), `@anthropic-ai/claude-agent-sdk`, pnpm workspaces, Vitest.

**Forbidden without an ADR:** any database or persistent store; any network listener bound
to a non-loopback interface by default; any auth/identity provider; any second agent
runtime besides the Claude Agent SDK.

**Exception process:** introducing a forbidden technology requires a new ADR in
`architecture/adr/` with options considered, accepted by the maintainer.

## Security baseline (non-negotiable)

- **C-SEC-1** — c3 is the permission **gateway** for its agent session.
  `settingSources: ['user', 'project']` is passed to the SDK, so inherited `~/.claude` and
  project `.claude` hooks and allow/deny rules apply first; any tool **not** pre-decided by
  them flows through `canUseTool` and out to the browser. An inherited allow-rule may
  auto-approve a tool the browser never sees — accepted, mirroring the `claude` CLI
  (ADR 0005). Changing `settingSources` requires a new ADR.
- **C-SEC-2** — A tool the SDK classifies as sensitive must not execute unless a decision
  authorizes it: an explicit Allow, or an active permission mode that authorizes
  auto-execution (`acceptEdits`, `bypassPermissions`).
- **C-SEC-3** — Absent any decision, the default outcome is **deny**. A pending request
  blocks indefinitely until the user decides (no timeout); if the run is aborted it
  resolves as deny. An unparseable or unknown client message is ignored, never treated
  as approval.
- **C-SEC-4** — No secrets are hardcoded or logged. The `claude` CLI owns auth; c3 never
  handles Claude credentials.
- **C-SEC-5** — The server binds to localhost only. Exposing it to a network requires an
  ADR and an explicit auth design.

## Coding principles

- **TypeScript `strict: true` everywhere.** Model wire and state as discriminated unions;
  narrow on `type`. No `as` to launder types. `unknown` at boundaries; validate WS input
  at the edge.
- **One source of truth for types** — `@ccc/shared`. Both ends import the same protocol
  definitions; neither redefines them.
- **Annotate exported signatures.** Keep `.js` import specifiers for local `.ts` files on
  the server.
- **Build order matters:** web before server (the server embeds the web bundle).

## AI engineering principles

- The agent runs under `permissionMode` that the user controls. The user may escalate to
  `bypassPermissions`, but only through an explicit, observable UI action — never silently.
- Switching into `bypassPermissions` mid-run is permitted by design
  (`allowDangerouslySkipPermissions: true`) **only because c3 remains the UI that
  surfaced the choice.** This must stay an explicit user action.
- A new user prompt aborts the in-flight run; no two agent runs proceed concurrently on
  one connection.

## Operations principles

- Single binary must run with only `bun` and a logged-in `claude` on PATH.
- Failure to find the `claude` executable, or an SDK error, surfaces to the user as a
  `session_end` with `reason: 'error'` — never a silent hang.

## Amendment procedure

The maintainer proposes and signs off on changes. An amendment that relaxes a `C-SEC-*`
rule requires a written rationale in an ADR and a note in the change record under
`changes/`. Violations are treated as release-blocking defects.
