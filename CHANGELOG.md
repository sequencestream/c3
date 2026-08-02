# Changelog

All notable changes to `c3` (Code Creative Center). The version source-of-truth is the git
tag (`git describe --tags`); `package.json` is the fallback baseline.

## v0.11.0

### Security

- intent store: a `save_intents` upsert that actually changes an intent's title or content now revokes the previously granted spec approval — clearing the approval and vetoing the standing machine-review conclusion — so an injection can no longer silently rewrite a queued intent's content and have it auto-executed under stale approval; the revocation is audited as a `spec_unapproved` lifecycle entry in the same transaction, while metadata-only edits leave approval untouched
- session launcher: resuming a work session is now treated as a new admission and passes the same fail-closed gates as a fresh launch (SDD spec approval, unmerged dependencies in worktree mode), closing a resume branch that bypassed both gates

### Refactoring

- queue driver: split the monolithic `workflow.ts` into per-action-family executors (dev / spec / outcome actions, ledger, projection, shared action context), leaving the driver with only dispatch and lifecycle; each module ships with its own test suite
- protocol: `protocol.ts` reorganized from a 4483-line single file into a domain-partitioned barrel under `shared/src/protocol/` (201 lines) with zero change to the public export surface
- spec launch: the dependency gate converged into a single shared implementation

### Dependencies

- Claude Agent SDK 0.3.218 → 0.3.220

## v0.10.0

### New Features

- automations: deterministic scheduling kernel (zero LLM) — tick-based reconciliation, per-intent failure isolation, observable decisions; the queue agent joins as an advisor through a dedicated MCP tool group with propose-then-validate double checking
- spec workflow: the queue auto-starts the spec authoring session, plus a read-only `spec_review` session with a rework loop and opt-in machine approval
- spec prompt: rewritten to decompose from the overall architecture down to the change site, asking for file/module locations and Mermaid diagrams
- discussions: research runs promoted to a formal "Research Session" tab (status bar, stop, follow-up rewrites the research result); "Process" renamed "Process Session"; conclusion-to-intent now creates a blank intent first and starts the intent session on it
- intent: saving an intent communication session is confirmed in the conversation itself instead of a modal; PR creation shows a staged progress overlay (analyze changes / commit / push / create PR)
- themes: extensible theme registry with a light theme, switchable from the new "Personalized Settings" page (display language moved there)
- markdown: `MarkdownText` renders Mermaid, so architecture/flow code blocks display as diagrams
- MCP `start_discussion` persists metadata and publishes `discussion:start` / `discussion:end` lifecycle events
- workspace: switching a workspace lands on the intent list instead of sessions; the workspace settings page shows the current workspace name and path
- startup: vendor CLI checks run asynchronously in the background and no longer block server start; arapuca managed install gets a 24-hour retry cooldown
- web: browser tab favicon
- worktree mode: the concurrency gate is scoped per branch instead of per workspace, so independent intents no longer block each other

### Fixes

- a host `HTTP_PROXY` without `NO_PROXY` swallowed loopback MCP calls, silently dropping every c3 tool
- intent progress bar: the "done" node rendered with a dead accent variable and is now blue
- machine approval re-reads the spec from disk inside the transaction before writing, closing a TOCTOU window
- light theme: text contrast audit and fixes across pages

### Docs

- handbook images consolidated under `handbook/images` with references fixed; README feature list updated for SDD/worktree

## v0.9.11

### New Features

- sandbox: upgraded to arapuca v0.2.5 capabilities — proxy passthrough (`--allow-proxy-env`) and subscription-based agent auth (`--allow-keychain`); c3 now manages the arapuca install itself with a host-PATH fallback
- sandbox: dropped the dedicated sandbox agent config tree — sandbox and host runs share the same default/tool/intent/spec agent configuration
- sandbox: `createSandboxWrapper` vendor-specific auth branches refactored into per-vendor auth strategies, restoring vendor neutrality
- session cleanup: retention/cleanup config moved out of the sandbox block into a standalone `sessionCleanup` block, and cleanup became a global vendor-neutral capability; relay codex home converged to a single global directory
- workcenter: "User Notifications" is the default landing page and the first menu item; the workcenter switch icon carries the same pending badge as the notification page
- running-state indicators: in-progress count badges on the top nav (Intents / Discussions / Automations), a running green dot on intent list rows (intent / spec / work sessions) and on automation list rows, plus running dots on intent-detail session tabs
- intent detail: split the oversized `IntentDetail.vue` into tab orchestration / engineering-progress / PR-and-delete subcomponents and a composable; the tab defaults to "Intent Session" when the intent body is empty; done intents hide the delete button
- automations: unified the "in progress" definition between the top badge and the list dot; PR URLs created by the automation queue are persisted so the detail page can link to the PR number

### Fixes

- sandbox: system-mode claude reporting "not logged in" inside the sandbox
- sandbox: system-mode codex subscription auth returning 401 inside the sandbox
- sandbox: arapuca resolution on Windows PATH now honours `PATHEXT`
- automations: a crash could leave a run stuck in `running`
- intent detail: the PR stage of the progress bar was blank on first entry (only refreshed after switching tabs)
- intent detail: delete-button race on done intents — the confirmation dialog is now dismissed when the intent turns done, with a guard in `confirmDelete`

### Docs

- handbook: full English edition alongside the Chinese one, with navigation and README references

### Dependencies

- Claude Agent SDK 0.3.215 → 0.3.218
- Codex SDK 0.144.6 → 0.145.0

## v0.9.10

### New Features

- intent detail: an engineering progress bar under the title (Intent — Spec — Work — PR), with the PR stage derived from creation/merge in worktree mode
- intents: "Add Intent" creates a blank intent directly; delete intent with a confirmation step that also cleans up the local worktree and branch; done intents keep the delete entry and get a stronger work-artifact prompt
- worktree mode and SDD are enabled by default (engineering-practice defaults)
- session page is hidden by default, gated by a system-setting switch, with its entry moved after "Codes"
- intent page / intent-detail session tabs add a permission-mode selector
- auto-redirect to the system-settings Agent config page when no agent is configured
- first-admin creation now redirects to the login page

### Fixes

- create_intent stuck in pending, and delete_intent failing across workspaces
- streamlined the intent creation flow
- intent progress bar now loads workspace settings

## v0.9.9

### New Features

- sandbox: replaced the Docker container with arapuca process-level isolation (kernel MAC) — vendor CLI runs as a host process with same-path directory mapping and direct 127.0.0.1 access to the c3 MCP
- sandbox: slimmed config, dedicated agent roles (no fallback to system-auth agents), intents can run in worktree mode, codex resume persists across runs, and session store scope is frozen per session so claude and codex both run/resume/show transcripts in either mode
- relay: vendor-neutral core with an anthropic passthrough adapter (provider keys no longer reach the process env); agent groups with candidate failover and per-candidate model override
- workcenter: unified top-bar navigation with a pending-notification badge
- unified c3 MCP HTTP transport for both Claude and Codex
- Start Work keeps you on the intent detail page and switches to the Work Session tab
- protocol.ts narrowed to a pure wire contract (runtime implementation split out)
- `pnpm allcheck` aggregates format/lint/typecheck/i18n; README documents brew install/upgrade

### Fixes

- Codes filename substring search missed matches
- `--workspace` CLI flag removed; workspace management goes through the Web UI only
- PR creation check now compares against `main` instead of upstream

### Dependencies

- Claude Agent SDK 0.3.201 → 0.3.216
- Codex SDK 0.142.5 → 0.144.6 (with PATH CLI alignment)

## v0.9.8

### New Features

- automation config JSON import/export
- file tree shows git file status (modified/added/staged + directory rollup + periodic refresh)
- intent detail page: metadata moved to the top with reordered fields
- markdown preview: generic code-file link detection with jump-to-code-page navigation, defaults to preview mode, and relative links resolve against the source file's directory
- workspace-level "enable automation" switches: a master switch on the automation list title bar, and a per-row accessible toggle on the new Workcenter run-overview Dashboard
- generic event mechanism: envelope + normalizer registry, unified `publish_event` MCP tool (replacing the narrower `publish_pr_event`, ADR-0026), and custom event types are now accepted via a default-normalizer fallback (field-level redaction/truncation preserved)
- automation event triggers: generic filter (type/status/metadata) instead of dedicated fields per event type, multi-row subscriptions, optional session-kind filter, and event context can now be embedded into LLM prompts (ADR-0027)
- automation config form: fields grouped into clearly separated sections
- automation MCP tool `start_session_for_intent` to launch spec/work sessions

### Fixes

- manual PR creation drops the done gate — now requires worktree mode + a branch + code changes
- settings panel: per-tab save button moves next to Close in the footer
- claude sdk warning filter now intercepts `process.emitWarning` directly, fixing warnings that leaked through the old `process.emit` wrapper
- automation form tool-permission grid: 5 columns → 4

## v0.9.7

### New Features

- vendor CLI multi-version support: decouple download target from active version, with selection panel in system settings
- automation session live viewer streaming: fine-grained status bar and live transcript updates on the session page
- system settings and workspace settings are grouped into tabs and saved independently
- add cross-platform install scripts and homebrew update workflow

### Fixes

- workspace settings optimistically mark committed after save to eliminate rapid-save rollback races
- fix codex intent session save_intents confirmation gate (disable code_mode/js_repl)
- fix consensus voting to query config by workspacePath, restoring voting under worktree isolation
- drop macos-x64 build target; remove minisign, rename release:sign to release:checksum

## v0.9.5

- consensus voting supports cross-vendor participants with normalized permission risk
- automation tool panel adds network-access option (passthrough to codex networkAccess)
- codex session injects GH_TOKEN to fix keyring token unreadable inside sandbox
- add mermaid dependency for Mermaid diagram rendering
- drop empty-named sandbox definitions to prevent startup crash
- fix ja/ko/ru workSession translations

## v0.9.4

- upgrade sdk for claude agent & codex
- support automation agent
- other optimization and improvement

## v0.9.3

- optimization and improvement

## v0.9.2

- support markdown preview

## v0.9.1

- automation refactor

## v0.9.0

- add intent log

## v0.8.0

- optimization and improvement

## v0.7.0

- optimization and improvement

## v0.6.0

- optimization and improvement

## v0.5.0

- optimization and improvement

## v0.4.3

- optimization and improvement

## v0.4.0

- optimization and improvement

## v0.3.0

- worktree support
- schedules improvement

## v0.2.0

c3 (Code Creative Center) is a coding platform that fuses harness and loop engineering
with AI software-engineering practice. Instead of throwing a raw prompt at a
model and hoping, c3 turns vague, half-formed requirements into structured intents — each
with a clear scope, dependencies, and a verifiable definition of done. From there it drives
the work through automated flows: planning, implementation, and validation run as
repeatable loops rather than one-shot guesses, so progress is steady and auditable. Multi-
agent discussions let perspectives converge before code is written, while scheduled tasks
keep long-running and recurring work moving without a human babysitting the loop.
c3 spec mode is spec-first and constitution-governed: the specification is the source of truth,
every decision is traceable, and the whole thing runs as a single local process you fully own.

## v0.1.0

### Distribution trust

- **Checksummed releases.** Every `release:build` artifact ships with a `.sha256`, plus an
  aggregate `SHA256SUMS`, interoperable with `shasum -a 256 -c`. Integrity is provided by the
  sha256 checksums + GitHub HTTPS distribution.
- **macOS ad-hoc code signing** (`codesign -s -`) applied at build time on macOS hosts.
- **Release orchestration:** `pnpm release` (build → notes → publish) with `--dry-run` and
  `--no-publish`; `pnpm release:notes`, `pnpm release:checksum`, `pnpm release:publish`.
- **Versioned artifact names:** `c3-v{version}-{os}-{arch}{.exe?}`.
- Package stays `private: true` — binaries are distributed via GitHub Releases, not npm.
