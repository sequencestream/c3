# Changelog

All notable changes to `c3` (Code Creative Center). The version source-of-truth is the git
tag (`git describe --tags`); `package.json` is the fallback baseline.

## v0.9.9

### New Features

- sandbox: process-level isolation via arapuca (kernel MAC — Landlock/Seatbelt/AppContainer) replacing the Docker container approach — no image/bind mount/credential injection/network sidecar, vendor CLI runs as a host process with same-path directory mapping and direct 127.0.0.1 access to the c3 MCP
- sandbox: config collapses to `enabled` + `extraMounts` + `sandboxSessionKinds` + `sessionRetentionDays`; workspace settings show the always-on default allow list (project dir ro, run worktree rw, spec dir rw) read-only, sourced from a single `sysExtraMounts` definition
- sandbox: dedicated agent roles (sandboxDefault/tool/intent/spec/automation) — sandbox runs never fall back to a system-auth agent (keychain/HOME is isolated); an explicitly bound system agent raises a conflict dialog with bypass/switch/cancel
- sandbox: intents can run in worktree mode inside the sandbox (structural restriction lifted)
- sandbox: codex resume survives across runs via a per-workspace persistent `CODEX_HOME`, with a daily janitor pruning rollouts past the workspace retention window
- sandbox: session store scope is frozen per session (host/sandbox) so claude and codex both run, resume, and show transcripts in either mode; vendor-neutral store root resolution (ADR-0030)
- relay: vendor-neutral relay core (was codex-only) with an anthropic passthrough adapter — real provider keys no longer reach the process env; agent groups with pre-first-byte candidate failover and per-candidate model override (ADR-0029, replaces ADR-0014)
- workcenter: overview / user-notifications entries move to the app top bar, with the pending-notification badge on the notifications entry
- unified c3 MCP HTTP transport for both Claude and Codex
- `pnpm allcheck` aggregates format → lint:fix → typecheck → i18n:check
- README documents brew install/upgrade

### Fixes

- Codes filename substring search missed matches
- `--workspace` CLI flag removed; workspace management goes through the Web UI only

### Dependencies

- Claude Agent SDK 0.3.201 → 0.3.207
- Codex SDK 0.142.5 → 0.144.1 (with PATH CLI alignment)

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
