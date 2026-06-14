steps:

## Run the whole suite (`pnpm e2e`)

`scripts/e2e/run-all.mjs` boots one server, runs every WebSocket e2e against it,
then tears it down and prints a pass/fail summary. The intent db is pointed
at a throwaway `C3_DB_PATH` (never touches `~/.c3/c3.db`), and the server is
launched with `--settings <throwaway>` so it reads its OWN settings.json — seeded
from the real `~/.c3/settings.json` when present (consensus tests keep their
configured agents) but with `auth` stripped, since the suite connects without a
token. Consensus tests still `SKIP` (exit 5) when none beyond the default are
configured.

> `c3 start --settings <path>` (new) points c3 at an explicit settings.json,
> relocating the whole config dir (its directory also holds `state.json`) without
> touching `~/.c3`. Use it to run any e2e by hand against an isolated, auth-free
> config: write `{}` (or a tailored settings.json) to a temp path and pass it.

- `pnpm e2e` → builds, boots, runs all, reports.
- `pnpm e2e --no-build` → reuse the existing `server/dist` build.
- `pnpm e2e --port 13550` → override the port (default 13099).

Per-test exit codes: `0` PASS, `5` SKIP, anything else FAIL; the suite exits
non-zero if any test FAILs. The one-off SDK spike below is excluded (it runs no
server). The individual tests can still be run by hand as documented in each
section.

## Smoke test (permission flow)

- `pnpm start --workspace /tmp --port 13000`
- `node scripts/e2e/e2e-ws-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Pending-queue flush race (running→idle re-submit)

Reproduces the client's pending-send-queue flush at the protocol level: a first
trivial (tool-less) turn runs, and the instant our session's `session_status`
flips running→idle the test fires a SECOND `user_prompt` — mirroring App.vue's
`flushIfReady`. It guards the teardown race where the server broadcast `idle`
from inside the run's `turn_end` _before_ the teardown `finally` nulled `rt.run`,
so the flushed prompt was rejected with "A turn is already running in this
session." and silently dropped. PASS = the second prompt is accepted and its
turn completes; FAIL = the "already running" error fires.

Needs only the default agent (spends two short tool-less turns of real tokens).

- `pnpm start --workspace /tmp --port 13000`
- `node scripts/e2e/e2e-pending-flush-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Intent management (save flow + AskUserQuestion gate)

Exercises the intent-management feature end-to-end: register a throwaway
project, enter its intent view (`open_intent_chat` → read-only comm
session + `intents` list), ask the comm agent to call `save_intents`,
approve the gated `permission_request` (`mcp__c3__save_intents`), and
confirm the row persists as `todo` and broadcasts. Then flips it to `done` via
`update_intent_status` and checks the re-broadcast.

A second turn then covers the intent gate's **AskUserQuestion** runtime path
— the one the unit test (`server/src/intent-gate.test.ts`) can't reach
because the decision lives in a `canUseTool` closure (this is the 003 follow-up:
`changes/.../2026-05-30-003-req-ask-question`). The comm agent is told to call
AskUserQuestion once; the gate must route it to the answer panel
(`permission_request` with toolName `AskUserQuestion`) rather than the read-only
deny-by-default fallback — a denied tool would yield no request at all
(`ask_gated`). We submit `answers`, and the agent must echo our choice back,
proving `withAnswers` injected the answer into the model (`ask_answer_injected`).

Needs only the default agent (spends two short turns of real tokens — save, then
AskUserQuestion) and the intent db available (`C3_DB_PATH`, which `pnpm e2e`
provides automatically).

- `pnpm start --workspace /tmp --port 13000` (with a throwaway `C3_DB_PATH` set if
  you don't want to touch `~/.c3/c3.db`)
- `node scripts/e2e/e2e-intent-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Consensus voting test (multi-agent decision)

Exercises the multi-agent consensus flow against the real `~/.c3/settings.json`
agents. Seeds a throwaway coding project in `/tmp`, asks the model to edit a
file (forcing a sensitive tool through the permission gateway), and checks that
voting actually ran — `consensus_auto` (unanimous) or a `permission_request`
carrying a `consensus` outcome (split). Consensus is enabled for the run and the
original settings are restored on exit; the agents are never modified.

Requires at least one agent besides the default (to vote). Hits the configured
providers' APIs (spends real tokens).

- `pnpm build` then `pnpm start --workspace /tmp --port 13000`
  (or `pnpm dev` and use `ws://localhost:3000/ws`)
- `node scripts/e2e/e2e-consensus-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## AskUserQuestion consensus test (per-question answering)

Exercises consensus over an `AskUserQuestion` prompt: the model is asked to pose
one multiple-choice question, the other agents answer it, and the gateway either
auto-answers (`consensus_auto` with `outcome.kind === 'ask'`, all agreed) or
surfaces the answer panel (`permission_request` with `consensus.kind === 'ask'`,
split) which the test fills in. Verifies the answer is injected and the run
completes. Same settings handling as the consensus test.

- `node scripts/e2e/e2e-ask-consensus-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Sandbox container test (config-via-c3 + real container path)

The "true" sandbox e2e — unlike `e2e-sandbox-test.mjs` (backward-compat, runs a
plain chat `create_session` which per ADR-0024/SND-R13 never sandboxes), this
covers the two halves that matter for the container feature:

- **Part A — config flow (protocol):** registers a system sandbox def pointing at
  a local base image (`get_settings` → `save_settings`), enables sandbox on a
  worktree-mode workspace (`save_workspace_setting`), then reads both back and
  asserts they persisted (worktree-only normalize kept). This is exactly what the
  System Settings + Workspace Settings UI emit.
- **Part B — container path (token-free):** starts a container from that image
  with a worktree bind-mounted at `/workspace` and runs `claude --version` /
  `codex --version` inside via `docker exec -w /workspace <cid> <bin>` — the
  identical mechanism `SandboxLauncher.createSandboxWrapper` uses. Proves the
  image has the CLIs and the mount/exec path works on a real daemon, with no
  provider credentials and no token spend.

There is no protocol hook to "launch the sandbox only" — c3 starts the container
as step 4 of a real `start_development` run whose step 5 spawns a real agent turn
(needs creds, spends tokens). The launchSandbox→wrapper wiring is already
unit-tested; what units can't cover — a real image on a real daemon — is Part B.

**Prereqs:** Docker running + the base image built. The image installs the
vendor CLIs (`claude` ← `@anthropic-ai/claude-code`, `codex` ← `@openai/codex`)
on a glibc base (`node:22-bookworm-slim`; NOT alpine — codex ships a native
binary). opencode is intentionally omitted (unsupported under sandbox, ADR-0024).

- Build the image (once): `node scripts/e2e/sandbox/build-image.mjs`
  (custom tag via `C3_SANDBOX_IMAGE=foo:bar`, clean rebuild via `--no-cache`).
- `pnpm start --workspace /tmp --port 13000`
- `node scripts/e2e/e2e-sandbox-container-test.mjs ws://localhost:13000/ws` →
  expect `RESULT: PASS`. SKIPs (exit 5) when Docker or the image is missing.

## SDK answer-injection spike (one-off)

Standalone proof that AskUserQuestion answers can be fed back via the
`canUseTool` channel in headless mode. Runs the SDK directly (no c3 server),
injecting an `answers` map via `updatedInput` on the allow result and asserting
the model receives it.

- `node scripts/e2e/spike-ask-answer-injection.mjs` → expect `RESULT: PASS`
  (add `--deny` to compare the deny+message fallback path).
