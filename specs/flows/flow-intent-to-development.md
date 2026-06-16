# Flow — Intent → Development

**Scenario.** The user has an idea against a project. A read-only communication agent refines it
into discrete, verifiable intents; the user confirms them into the ledger; then launches one into a
background development session and follows its progress via a back-link.

**Domains.** intent-management · agent-session · permission-gateway · session-registry · agent-config.

This flow operates **above** the session level: it captures _what to build_, then feeds the
[prompt → gated run](flow-prompt-to-gated-run.md) loop. The unattended sibling is the
[automation orchestrator](flow-automation-orchestrator.md). It reuses the run loop and the gate; it
owns no permission state (`RM-R*` boundary).

## Flow graph

```mermaid
flowchart TD
    IDEA[open_intent_chat] --> COMM[read-only communication agent]
    COMM --> SAVE[save_intents — human confirm]
    SAVE -- allow --> LEDGER[(intent ledger · todo)]
    SAVE -- deny --> X[nothing written]
    LEDGER --> LAUNCH[start_development]
    LAUNCH --> DEV[background dev session<br/>standard gated loop]
    DEV --> LINK[back-link · select_session]
    DEV -. dead process on entry .-> REC[reconcile auto-done]
```

## Refine — read-only communication agent

1. **web-console → intent-management.** The user clicks the idea (💡) button; `open_intent_chat`
   switches to the intent view and (re)loads the project's `isCurrent` communication session
   (history + live stream), keyed by the resolved absolute project path (`RM-R4`, `RM-R10`). On
   entry the server **reconciles** every `in_progress` intent (see _Reconcile_ below, `RM-R18`).
2. **Communication agent (read-only).** Runs as an `intent`-kind runtime in **forced `default`
   mode** (`RM-R3`). It may use read-class tools and `AskUserQuestion` (routed via the gateway's
   answer-injection path, no consensus) and the read-only ledger queries `find_intents` /
   `view_intent` (auto-allowed, `RM-R19`), but **never** edits, writes, runs commands, spawns
   sub-agents, or runs slash commands — enforced at the tool layer, not by prompt (`RM-R2`,
   ADR-0007). It proposes right-sized items covering Why / What / Trade-offs / When / Acceptance,
   folding code + tests + companion docs into **one** intent (`RM-R15`).

## Confirm — save to the ledger

1. **intent-management → permission-gateway.** The agent calls `save_intents`
   (`mcp__c3__save_intents`); c3 surfaces a human confirmation reusing the gateway (`RM-R5`). The
   confirmation lists each proposed item incl. intra-batch "依赖本批" references.
2. **Allow ⇒ write.** New items land as `todo` for the current project (`RM-R6`); items carrying an
   `id` **update** in place (upsert — keeps `draft`/`todo`, reactivates `cancelled`, rejects
   `in_progress`/`done`, `RM-R20`). Intra-batch `dependsOnIndexes` resolve to sibling ids in one
   atomic transaction; an out-of-range/self/cycle index or a bad update id rejects the **whole**
   batch (`RM-R17`, `RM-R20`). **Deny ⇒** nothing written, agent told it was rejected (`RM-R5`).

## Launch development

1. **web-console → intent-management.** A `todo` item's Launch button sends `start_development`,
   allowed when `todo` or `in_progress` with a dangling dev session (`RM-R8`). The server
   synchronously **claims** the `intentId` in a single-process launch set; a concurrent duplicate
   start returns `intent.devStartInFlight` and creates nothing (`RM-R8`).
2. **Git branch mode (`WorkspaceSetting.gitBranchMode`).** `worktree` ⇒ create/reuse an isolated
   per-intent worktree under the c3 home directory, branched from `defaultMainBranch`;
   `current-branch` (default) ⇒ develop in place. The dev session's effective working directory is set
   accordingly (`RM-R8`).
3. **intent-management → agent-session.** A **background normal session** is started running the
   configurable development skill (`devSkill`; empty ⇒ no prefix) with the intent content; the
   intent moves to `in_progress` and records `lastDevSessionId` (`RM-R8`). The dev session is a
   normal session — it appears in the sidebar, stamped to sort to the top, fanned out to every
   connection on bind/settle (`SR-R13`). It runs the standard gated loop
   ([prompt → gated run](flow-prompt-to-gated-run.md)). The run survives disconnect (`AS-R8`).

## Back-link & status

- **Development back-link.** A launched item's Development-details entry opens `lastDevSessionId`
  via `select_session` (history + live stream, `RM-R13`). A deleted session yields a friendly
  restart/cancel prompt, not a crash (`RM-R13`).
- **Reconcile on entry (`RM-R18`).** On `open_intent_chat`, each `in_progress` intent's
  `lastDevSessionId` is checked against the process table: a **dead** process whose last 3 assistant
  messages the completion judge confirms `done` is **auto-completed** (commit + push +
  status set to `done`) — for manual **and** automation runs alike; a live process derives
  `runStatus = 'running'`; otherwise `dangling`. This is one of the two auto-`done` paths.

## Discussion bridge

`discussion_to_intent` (a `refine_intent` variant owned by the discussion domain) seeds the
communication session with a completed discussion's `conclusion` instead of an existing intent,
then funnels into the **unchanged** `save_intents` path (`RM-R7`). See
[discussion → intent](flow-discussion-to-intent.md).

## Branches & exceptions (anti-scenarios)

- **Read-only is absolute.** A communication session must never write a file — even via a spawned
  sub-agent or slash command; `Task`/`SlashCommand` are disallowed and the gate denies by default
  (`RM-R2`, ADR-0007).
- **No silent save.** `save_intents` must never persist without the user's allow — even under a
  `bypassPermissions` system default (`RM-R3`/`RM-R5`).
- **Manual launch never auto-completes.** The dev run finishing does not change status; the user
  marks `done`/`cancelled` (`RM-R9`). The only exceptions are the entry reconcile (`RM-R18`) and the
  automation orchestrator (`RM-A5`).
- **Unmet dependencies warn, not block.** Launching with a non-`done` `dependsOn` warns but proceeds
  (`RM-R11`).
- **Ledger unavailable degrades softly.** If SQLite is down, intent messages return `error` and the
  normal list is **not** filtered; c3 still boots and serves normal sessions (`RM-R12`).
