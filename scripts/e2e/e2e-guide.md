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

The sessions-page setting test runs first against that isolated settings file. It
persists both `showSessionsPage: false` and `true`, verifies each authoritative
`settings` echo, then restores the original snapshot. Frontend navigation tests
pair this wire/disk e2e with desktop/mobile rendering and ordering assertions.

## Smoke test (permission flow)

- `pnpm start --port 13000`
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

- `pnpm start --port 13000`
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

- `pnpm start --port 13000` (with a throwaway `C3_DB_PATH` set if
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

- `pnpm build` then `pnpm start --port 13000`
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

- Build the image (once): `node scripts/e2e/sandbox/build-image.mjs`
  (custom tag via `C3_SANDBOX_IMAGE=foo:bar`, clean rebuild via `--no-cache`).
- `pnpm start --port 13000`
- `node scripts/e2e/e2e-sandbox-container-test.mjs ws://localhost:13000/ws` →
  expect `RESULT: PASS`. SKIPs (exit 5) when Docker or the image is missing.

## arapuca capability test (host process-sandbox probe)

Standalone, server-free probe of the `arapuca` binary that c3's process-level
sandbox depends on. Runs a matrix of `arapuca run` invocations directly (argv
arrays, no shell — dodges the zsh `"$dir:ro"` → `:r` modifier trap) and reports
each capability.

The binary is resolved through the SAME chain as `SandboxLauncher.probeArapuca`
and the hit is printed and tagged on the probe row:

- **`managed`** — the c3-installed, version-pinned build under
  `~/.c3/sandbox/arapuca/current`. This is what a real run uses.
- **`host-path`** — whatever the user installed on `PATH` / `~/.cargo/bin`; the
  fallback while the managed install is absent, of an uncontrolled version.

`--source=managed` / `--source=host-path` pins the run to one link so both
scenarios can be covered separately; the chosen link being unavailable is a SKIP
(exit 5), not a failure. Passing an explicit path still overrides everything.

- **MUST (rw/ro/deny):** basic process launch, `-v <dir>` read+write, `-v <dir>:ro`
  read + write-denied, and deny-by-default (unmounted path unreadable). Failure of
  any → arapuca isolation is incomplete, sandbox unusable (exit 1).
- **Capability gate (canonicalize):** whether the sandboxed process can `chdir` /
  `realpath` into a mounted subdirectory. This is codex's startup gate — codex
  canonicalizes `CODEX_HOME` on launch, so if this fails the whole run dies with
  `failed to canonicalize CODEX_HOME … Operation not permitted (os error 1)`.

  On macOS this needs the Seatbelt profile to grant traversal (read-metadata) on
  each mount's _ancestor_ directories: without it any absolute-path
  `realpath`/`chdir` resolving from `/` hits an un-granted ancestor (e.g.
  `/Users/<user>` above a `~/.c3/worktrees/<run>` mount) and returns
  ENOTDIR/EPERM. The version c3 pins carries that fix, so `--source=managed`
  passes this gate; a `host-path` binary older than it does not, which is exactly
  what the two-source split exists to distinguish. The script uses `realpathSync`
  on its temp mounts to mirror c3's `resolvePaths` (so macOS `/var`→`/private/var`
  firmlink mismatch — a separate EPERM cause — is excluded).

- **Vendor launch probe (`claude` / `codex`):** token-free — runs `<bin> --version`
  inside the sandbox from a deep worktree cwd (SKIP when the CLI isn't installed).
  Proves the vendor CLI starts under arapuca and that deep-cwd resolution works
  (the ancestor-traversal fix's payoff). Real turns (`-p`) need creds + tokens and
  are out of scope.
- **`/tmp` symlink gate (claude runtime dir):** claude hardcodes its runtime dir at
  `/tmp/claude-<uid>` (shell-snapshots/IPC). `/tmp` is a symlink to `/private/tmp`;
  an arapuca whose fixed ancestor list omits `/tmp` can't resolve the symlink entry,
  so `mkdir /tmp/claude-<uid>` fails EPERM even when canonical `/private/tmp` is
  mounted. arapuca locks `TMPDIR` (`--env cannot override sandbox-managed var`) and
  claude ignores `TMPDIR`, so it can't be redirected via env. Same story as the
  canonicalize gate: the pinned managed version resolves it, an older `host-path`
  binary may not. codex is unaffected (it uses `CODEX_HOME`).

- `node scripts/e2e/e2e-arapuca-capability-test.mjs [/abs/path/to/arapuca] [--source=managed|host-path]`
  → exit 0 when all MUST pass; 1 = a MUST failed; 2 = no binary on either link;
  5 = the requested source is unavailable (SKIP). The canonicalize and `/tmp`
  gates are reported as `⚠️ LIMIT` and do not fail the MUST tally.
  A missing managed install just means c3 has not finished (or has not been
  started to trigger) its background download yet.

## Sandbox claude subscription (keychain) login test (macOS)

Standalone, server-free re-verification of the macOS path where a `system`-mode
(subscription) claude runs inside the arapuca sandbox — the scenario that
regressed to `Not logged in · Please run /login`. It generates a wrapper through
the REAL `createSandboxWrapper` (imported via `tsx`, so it covers the shipped
code, not a hand-copied flag layout) with `allowKeychain: true`, then runs
`claude -p` through it.

The failure it guards against had two independent causes, both asserted here:

- **Login name stripped.** arapuca is env deny-by-default and blanks
  `USER`/`LOGNAME`, but Claude Code keys its Keychain credential lookup by the
  login name — without it the token is never found. The wrapper must forward both.
- **`CLAUDE_CONFIG_DIR` flips off the Keychain.** Setting it makes Claude Code use
  a file store (`$CLAUDE_CONFIG_DIR/.credentials.json`) that does not exist, so the
  keychain path must leave it unset (arapuca's `--allow-keychain` already points
  HOME at the real home, so `~/.claude` resolves without it).

- **Structure guard:** the generated script must NOT contain `CLAUDE_CONFIG_DIR`
  and MUST forward `--env 'USER=…'` / `--env 'LOGNAME=…'`.
- **Behaviour guard:** the real `claude -p` run must reply (`PONG`) and must NOT
  print `Not logged in`.

Needs a real subscription login + outbound network (claude uses the host proxy),
so it is NOT CI-safe and is NOT in the `pnpm e2e` suite. Every unmet precondition
is a SKIP (exit 5): non-macOS host, no `claude` CLI, no arapuca on either link, or
no `Claude Code-credentials` item in the login Keychain.

- `node scripts/e2e/e2e-sandbox-claude-keychain-test.mjs` → exit 0 when logged in
  and replied; 1 = still not logged in / no reply / structure guard failed; 5 =
  a precondition was unmet (SKIP). Override the model with `C3_E2E_MODEL`.

## Sandbox codex subscription (DIRECT) login test (macOS)

The codex sibling of the claude keychain test. A subscription (`system`-mode)
codex runs in DIRECT mode and authenticates from `$CODEX_HOME/auth.json` (the
ChatGPT OAuth token) — but the sandbox's isolated per-workspace CODEX_HOME has
none, so codex hit `wss://api.openai.com/v1/responses` with no bearer and failed
`401 Missing bearer or basic authentication`. The fix points CODEX_HOME at the
HOST `~/.codex` (which holds auth.json), mounts it, and freezes the session's
store scope to `host` so rollouts/resume/transcript reads all resolve there.

Generated through the REAL `createSandboxWrapper` (via `tsx`, `allowKeychain: true`):

- **Structure guard:** `--env 'CODEX_HOME=<host ~/.codex>'` + `-v '<host ~/.codex>:rw'`,
  and NO isolated `sandbox-home` mount.
- **Behaviour guard:** the real `codex exec` run must reply (`PONG`) and must NOT
  print `401` / `Missing bearer`.

Needs a real subscription login (`~/.codex/auth.json`) + outbound network, so it
is NOT CI-safe and NOT in the `pnpm e2e` suite. Preconditions unmet → SKIP (exit
5): non-macOS, no `codex` CLI, no arapuca, or no `~/.codex/auth.json`. OpenAI's
transient geo-block of a proxy exit IP (`Unable to load site`) is retried once and,
if it persists, reported as SKIP (auth already proven, block is environmental).

- `node scripts/e2e/e2e-sandbox-codex-subscription-test.mjs` → exit 0 when logged
  in and replied; 1 = still 401 / no reply / structure guard failed; 5 = a
  precondition unmet or an OpenAI geo-block (SKIP).

## Sandbox vendor token test (real request through arapuca)

Complements the token-free capability probe: uses a real agent from
`~/.c3/settings.json` (default `claude-deepseek` / `codex-deepseek`) to send an
actual token-billed request from inside an arapuca sandbox, mirroring the
arapuca command shape `SandboxLauncher.createSandboxWrapper` emits (`--seccomp
baseline` for network, `/tmp/claude-<uid>` runtime dir allowed, `CODEX_HOME`
isolated). Auth is env-only (the agent's `baseUrl` + its `apiKey`, decrypted
in-process via the same AES-GCM scheme as `config/encryption.ts`) — subscription
/ keychain are never mounted.

- **claude:** `-p` returns just the model reply, so hitting the sentinel word is
  a genuine end-to-end success (validates the ancestor + `/tmp` + baseline fixes
  together with env auth).
- **codex:** a direct provider connection uses the OpenAI Responses API
  (`/responses`), which most OpenAI-compatible gateways (deepseek included) don't
  serve — c3 production bridges this with `CodexRelay`. So this script only
  asserts codex reached the network + auth was accepted (not ConnectionRefused /
  not 401); the real completion belongs to a full server-run e2e.

- `node scripts/e2e/e2e-sandbox-vendor-token-test.mjs [claude-agent] [codex-agent]`
  → exit 0 when claude's real request succeeds; 5 = SKIP (agent/binary missing);
  1 = FAIL. Requires an arapuca carrying the mount-ancestor + `/tmp` fixes — the
  c3-managed install satisfies this; a host-PATH binary must be new enough.

## Relay real turn test (vendor-neutral relay, ADR-0029)

The full server-run counterpart the sandbox-vendor-token test defers to: drives one
tool-less turn on a specific **custom** agent through a live c3 server, proving the
vendor-neutral relay path end-to-end. Because every custom provider now flows through
c3's loopback relay, a clean reply carrying the sentinel word validates the whole path
with the real provider key held only in the relay (never in the vendor subprocess):

- **claude custom** (e.g. deepseek `…/anthropic`) → the relay's **anthropic passthrough**
  (auth swap + model override).
- **codex custom, `wireApi=chat`** (e.g. deepseek chat) → the relay's **Responses↔Chat
  translation** — this is exactly what a direct codex→deepseek connection cannot do.

The script re-targets a fresh session onto the agent via `set_session_agent`, sends a
prompt asking the model to echo a sentinel, and PASSes iff `turn_end` is clean AND the
sentinel comes back. Spends real tokens on the agent's provider.

Boot an isolated, auth-free server seeded from the real settings (keys decrypt via the
embedded static key — path-independent), then run once per agent:

- `C3_DB_PATH=<tmp>/c3.db pnpm -F @ccc/server exec tsx src/cli.ts start
--port 13123 --settings <copy-of-~/.c3/settings.json, auth stripped> --dev`
- `node scripts/e2e/e2e-relay-real-test.mjs ws://127.0.0.1:13123/ws <agentId> [sentinel]`
  → `RESULT: PASS` (exit 0). 1 = FAIL, 2 = TIMEOUT.

Not part of `pnpm e2e` (needs configured custom agents + spends tokens), like the
sandbox-vendor-token test.

## SDK answer-injection spike (one-off)

Standalone proof that AskUserQuestion answers can be fed back via the
`canUseTool` channel in headless mode. Runs the SDK directly (no c3 server),
injecting an `answers` map via `updatedInput` on the allow result and asserting
the model receives it.

- `node scripts/e2e/spike-ask-answer-injection.mjs` → expect `RESULT: PASS`
  (add `--deny` to compare the deny+message fallback path).
