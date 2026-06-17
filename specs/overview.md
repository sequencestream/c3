# Specs Knowledge Base — Overview

This directory is the source of truth for **what c3 does and why**. Source code is the
source of truth for **how it does it today**; specs describe the intended behavior that
code must satisfy. When the two disagree, that is a bug in one of them — reconcile, don't
ignore.

## How to navigate

| If you want to know…                          | Read                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The project's purpose, scope, stakeholders    | [`project.md`](project.md)                                                                     |
| Hard rules nothing may violate                | [`constitution.md`](constitution.md)                                                           |
| What a term means                             | [`glossary.md`](glossary.md)                                                                   |
| The system shape and how the pieces connect   | [`architecture/architecture.md`](architecture/architecture.md)                                 |
| Why a key decision was made                   | [`architecture/adr/`](architecture/adr/)                                                       |
| The end-to-end path through a scenario        | [`flows/flows.md`](flows/flows.md)                                                             |
| The WebSocket wire contract                   | [`shared/api-conventions/websocket-protocol.md`](shared/api-conventions/websocket-protocol.md) |
| The c3 ↔ license-server API contract          | [`shared/api-conventions/license-server-api.md`](shared/api-conventions/license-server-api.md) |
| The frontend visual style guide               | [`style/style-spec.md`](style/style-spec.md)                                                   |
| Performance / security / availability targets | [`non-functional/`](non-functional/)                                                           |
| A specific capability's behavior              | [`domains/core/`](domains/core/)                                                               |

## Domains

c3 has three business groups: `core` (the agent loop), `system-config` (user configuration), and
`commerce` (product entitlement / licensing).

### Group `core`

| Domain                                                   | Responsibility                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`permission-gateway`](domains/core/permission-gateway/) | Intercept SDK permission requests, route them to the browser, block until the user decides (deny on run abort)                                                    |
| [`agent-session`](domains/core/agent-session/)           | Drive the SDK `query()` loop, map SDK messages to the wire protocol, manage permission mode and run lifecycle                                                     |
| [`session-registry`](domains/core/session-registry/)     | Manage workspaces & sessions; own per-session mode, recent-access order, history replay                                                                           |
| [`web-console`](domains/core/web-console/)               | The browser UI: prompt input, activity stream, permission dialog, mode switch                                                                                     |
| [`intent-management`](domains/core/intent-management/)   | A project-scoped intent ledger and a read-only intent-communication agent that breaks ideas into verifiable items and launches the configurable development skill |

### Group `system-config`

| Domain                                                | Responsibility                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`agent-config`](domains/system-config/agent-config/) | Manage agent profiles (url/key/model + name), the default agent, per-session binding |

### Group `commerce`

| Domain                                                 | Responsibility                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`product-license`](domains/commerce/product-license/) | Govern whether a c3 install is commercially **entitled** to create new work; activation, heartbeat + 30-min offline grace, offline Ed25519 verification, new-session gating. Authority lives in the separate **license-server** (ADR-0026). |

## Usage rules

1. **Spec before code.** New behavior is described here first, then implemented.
2. **WHAT vs HOW.** `<domain>-spec.md` files state business behavior; `<domain>-design.md` files state
   technical implementation. Keep them apart.
3. **Single source of truth for the wire format.** The WebSocket protocol is documented
   once in [`shared/api-conventions/websocket-protocol.md`](shared/api-conventions/websocket-protocol.md).
   Domain docs reference that document; they do not redefine message shapes.
4. **Reference, don't duplicate.** Shared rules live once and are cited by ID.
5. **Dates are `YYYY-MM-DD`.** Business-semantic types over technical types.
6. **No code references (C-DOC-1).** Specs describe behaviour in domain language — no source
   file/directory paths, no source-tree listings, no class/type/function/field names, no
   JSDoc `{@link}`. Cross-links to other `.md` specs, wire-message names, user-facing config
   keys, rule/ADR IDs, and external tool identifiers are the allowed contract vocabulary. See
   [`constitution.md`](constitution.md) C-DOC-1.

## Maintenance

- Initialized 2026-05-29.
- Every domain has `<domain>-overview.md`, `<domain>-spec.md`, `<domain>-design.md`, `<domain>-models.md`.
- Deprecated content moves to `archived/`; ADRs are never deleted, only superseded.
