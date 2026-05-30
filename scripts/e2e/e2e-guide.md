steps:

## Run the whole suite (`pnpm e2e`)

`scripts/e2e/run-all.mjs` boots one server, runs every WebSocket e2e against it,
then tears it down and prints a pass/fail summary. The requirement db is pointed
at a throwaway `C3_DB_PATH` (never touches `~/.c3/c3.db`); agent config
(`~/.c3/settings.json`) is left as-is, so the consensus tests use the real
agents and `SKIP` (exit 5) when none beyond the default are configured.

- `pnpm e2e` → builds, boots, runs all, reports.
- `pnpm e2e --no-build` → reuse the existing `server/dist` build.
- `pnpm e2e --port 13550` → override the port (default 13099).

Per-test exit codes: `0` PASS, `5` SKIP, anything else FAIL; the suite exits
non-zero if any test FAILs. The one-off SDK spike below is excluded (it runs no
server). The individual tests can still be run by hand as documented in each
section.

## Smoke test (permission flow)

- `pnpm start --project /tmp --port 13000`
- `node scripts/e2e/e2e-ws-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Requirement management (save flow)

Exercises the requirement-management feature end-to-end: register a throwaway
project, enter its requirement view (`open_requirement_chat` → read-only comm
session + `requirements` list), ask the comm agent to call `save_requirements`,
approve the gated `permission_request` (`mcp__c3__save_requirements`), and
confirm the row persists as `todo` and broadcasts. Then flips it to `done` via
`update_requirement_status` and checks the re-broadcast. Needs only the default
agent (spends a short turn of real tokens) and the requirement db available
(`C3_DB_PATH`, which `pnpm e2e` provides automatically).

- `pnpm start --project /tmp --port 13000` (with a throwaway `C3_DB_PATH` set if
  you don't want to touch `~/.c3/c3.db`)
- `node scripts/e2e/e2e-requirement-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Consensus voting test (multi-agent decision)

Exercises the multi-agent consensus flow against the real `~/.c3/settings.json`
agents. Seeds a throwaway coding project in `/tmp`, asks the model to edit a
file (forcing a sensitive tool through the permission gateway), and checks that
voting actually ran — `consensus_auto` (unanimous) or a `permission_request`
carrying a `consensus` outcome (split). Consensus is enabled for the run and the
original settings are restored on exit; the agents are never modified.

Requires at least one agent besides the default (to vote). Hits the configured
providers' APIs (spends real tokens).

- `pnpm build` then `pnpm start --project /tmp --port 13000`
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

## SDK answer-injection spike (one-off)

Standalone proof that AskUserQuestion answers can be fed back via the
`canUseTool` channel in headless mode. Runs the SDK directly (no c3 server),
injecting an `answers` map via `updatedInput` on the allow result and asserting
the model receives it.

- `node scripts/e2e/spike-ask-answer-injection.mjs` → expect `RESULT: PASS`
  (add `--deny` to compare the deny+message fallback path).
