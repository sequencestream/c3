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

## Delivery ↔ intent association (link / unlink guards)

Drives the association over the real wire protocol in a throwaway git workspace
(deliberately with no remote): two deliveries, two intents, `intent_prs` rows seeded
straight into the ledger through `C3_DB_PATH` — the state a real `create_pr` would
leave behind.

PASS asserts what the association exists to guarantee:

- linking is visible from **both** sides — the delivery detail lists the intent and
  the intent's own projection names the delivery;
- the delivery list's PR column is the intent's PR **toward this delivery**;
- an intent with no PR unlinks cleanly and its edge disappears;
- a **merged** PR can never be unlinked (`delivery.unlinkMergedPrDenied`) and the
  edge survives the refusal — the black hole this guard exists for;
- an unreadable forge state **blocks** the unlink (`delivery.unlinkPrStatusCheckFailed`)
  rather than assuming "not merged";
- one intent holds **one PR per delivery**: linked to a second delivery and given a
  PR toward it, its projection carries two rows under two delivery ids off the SAME
  head branch (what the intent detail groups by delivery), and each delivery detail
  keeps showing the PR toward itself;
- cancelling the delivery does **not** drop the association edges.

Not covered here: "the created PR's base is the delivery branch" — that needs a real
forge to answer `pr create`. It is pinned instead by
`server/src/features/intents/create-pr-handler.test.ts` ("delivery target
resolution"), which asserts the one resolved base reaching the diff gate, the forge
call, the ledger row and the published `pr:create` event.

Not covered here either: "unmerged PR is closed, then the edge and PR row are dropped".
That needs a forge that answers `pr view` and accepts `pr close`, which cannot be
provoked deterministically in a sandboxed repo with no remote — and faking a CLI on
PATH would fake exactly the boundary under test. That chain, plus the
already-closed-is-success and close-failure-blocks branches, is covered by
`server/src/features/deliveries/index.test.ts` ("link / unlink intent ↔ delivery"),
which injects the forge results directly.

No agent tokens are spent. Needs `C3_DB_PATH` (the suite runner passes it to every
test); without it the test SKIPs.

- `pnpm start --port 13000`
- `C3_DB_PATH=~/.c3/c3.db node scripts/e2e/e2e-delivery-link-test.mjs ws://localhost:13000/ws`
  → expect `RESULT: PASS`.

## Delivery PR (合并回主线)

`scripts/e2e/e2e-delivery-pr-test.mjs`

The one test in the suite that **starts its own server**. It needs the forge to
answer particular things on demand — merged, conflicting, red CI, missing approval,
unreachable — so it puts a scriptable `gh` stand-in (`fixtures/fake-forge/gh`, driven
by a JSON state file named via `C3_E2E_FORGE_STATE`) on the PATH of a private
instance with its own port, ledger and settings. The `[ws-url]` argument is ignored.

Why not the shared server: that stub would also answer the association test's
lookups, and that test exists precisely to prove an **unreadable** forge blocks an
unlink. Why scripting the forge is legitimate here at all: the subject is the
SETTLEMENT chain — gate order, "ask the forge before creating", the three failure
layers, and the single-transaction `delivered` write. The forge is that chain's
input; everything downstream of the answer is the real thing.

PASS asserts:

- `delivery_detail` always carries `deliveryPr`; gate order is fixed (not-`verified`
  refused before the branch is looked at, and a refused create never touches the
  forge at all); a branch holding nothing beyond mainline is refused;
  `current-branch` refuses both actions;
- **forge-first idempotency**: `pr list` is invoked before `pr create`, keyed on
  (head = delivery branch, base = mainline); a retry against a forge that now
  reports the PR adopts it — `pr create` never runs twice and the ledger keeps
  exactly one row, which carries the REAL `origin/*` SHAs;
- **layer 1 (transient)**: an unreachable forge is a retryable error that moves
  nothing — not the status, not the PR row, not the log;
- **layer 2 (blocked)**: red CI and missing approvals record `blocked_reason` and
  leave the delivery `verified` — the code is fine, so the verification it earned
  is not thrown away; a later unblocked sync clears it;
- **layer 3 (conflict)**: a genuinely conflicting mainline (the test rewrites the
  same file on `main`) rolls the delivery back to `verifying`, with the real
  conflicting file enumerated by the local merge trial and a `merge_conflict` log line;
- **`delivered` atomic write**: after the conflict is resolved and the delivery
  re-verified, a merged PR settles status + PR row + exactly one `delivered` log
  line (actor `system`, naming the PR); the associated intent's status is NOT
  rewritten; and a repeat sync is idempotent.

Not covered here: the cross-delivery dependency gate unlocking on `delivered`
(covered by the dependency-gate test below), and the GitHub-vs-GitLab field-shape
normalization (covered by `server/src/features/deliveries/`).

No agent tokens are spent. Needs a built server (`pnpm build` → `server/dist/cli.cjs`);
without it the test SKIPs.

- `pnpm build && node scripts/e2e/e2e-delivery-pr-test.mjs`
  → expect `RESULT: PASS`.

## Delivery status guard (拒绝不可达迁移 / 守卫缺口)

`scripts/e2e/e2e-delivery-transition-test.mjs`

`canTransitionDelivery` is exhaustively unit-tested; what only the real wire can
show is that a refusal reaches the client as a **typed** `delivery_transition_failed`
frame carrying the gaps, the current status and the attempted target — not as a
generic `error`, and not as a silent no-op the page would render as success. The
page builds its segmented selector out of exactly those fields.

One fresh `planned` delivery with no branch and no associations; no forge, no
network. PASS asserts:

- an **unreachable** edge (`planned → delivered`) is refused with
  `delivery.invalidStatusTransition` and an EMPTY gap list — there is no gap to
  close, the edge does not exist;
- a **reachable-but-blocked** edge (`planned → integrating` with no branch) is
  refused with `delivery.transitionGuardFailed` and the structured gap
  `delivery.guard.branchNotReady`; the two codes stay distinct — 「不可达」 and
  「未满足」 are different answers and the page must not conflate them;
- both refusals echo `currentStatus` + `to`, and name the delivery;
- the `transitionPlan` never OFFERS an unreachable target, and reports the SAME
  gap the refusal did (one server-side source, recomputed on every read);
- a **system-only** edge (`verified → delivered`, which the forge's merge drives)
  is refused for a human caller with `delivery.guard.systemOnly`. Reaching
  `verified` honestly needs a branch, associations and a forge, so this section
  seeds the status straight into the ledger and only the refusal travels the wire;
  it is skipped without `C3_DB_PATH`;
- no refusal writes anything, and none degrades into a generic `error` frame.

No agent tokens are spent.

- `C3_DB_PATH=~/.c3/c3.db node scripts/e2e/e2e-delivery-transition-test.mjs ws://localhost:13000/ws`
  → expect `RESULT: PASS`.

## Dependency gate (same-delivery / cross-delivery / no-delivery)

`scripts/e2e/e2e-dependency-gate-test.mjs`

Drives the dependency gate's three readings through the live server. The gate asks
「依赖的产出在不在我的 base 上」, not 「依赖的 PR 合了没有」, and the answer depends on
the session's delivery context — so each reading must produce its OWN explanation,
or a user cannot tell them apart.

A throwaway git workspace (no remote), two deliveries and four intents; each
dependency is `done` and sits on its own branch, so "is its output on my base" is a
real question. PASS asserts:

- SAME delivery, PR toward it unmerged → `intent.dependencyPrUnmergedInDelivery`,
  naming the delivery both sides share;
- CROSS delivery, the dependency's delivery not `delivered` →
  `intent.dependencyDeliveryNotDelivered`, naming the OTHER delivery and carrying
  its id so the page can link to it — **a PR merged into another delivery still
  blocks**, which is the whole point of the change;
- NO delivery on either side → the historic `intent.dependencyNotMerged`, unchanged;
- each state opens on its OWN terms: the same-delivery PR merging, and the cross
  delivery reaching `delivered`.

The three BLOCKED states go through the real `start_development` launch gate (which
refuses before any git or agent work). The OPEN states are asserted through the
intent projection's `actionDescriptor`, computed from the SAME shared criterion —
driving the launch gate to a pass would start a real session and spend tokens.

No agent tokens are spent. Needs `C3_DB_PATH` (the suite runner passes it) to seed
branch names and PR rows; without it the test SKIPs.

- `pnpm start --port 13000`
- `C3_DB_PATH=~/.c3/c3.db node scripts/e2e/e2e-dependency-gate-test.mjs ws://localhost:13000/ws`
  → expect `PASS — dependency gate three states`.

## Per-intent spec mode (override / derive / refresh / clear)

`scripts/e2e/e2e-spec-mode-test.mjs` drives the intent detail's「是否需要规范」switch
over the real wire: one throwaway workspace, two intents, and the single message the
switch writes — `set_intent_spec_mode`.

PASS asserts the contract the UI reads back:

- an unset intent (`specMode: null`) inherits the workspace — `effectiveSpecMode`
  follows `sddEnabled`;
- an explicit `fast` / `sdd` persists and resolves to itself on the `intents`
  broadcast, and **survives a refresh** — a brand new WebSocket connection listing
  the same workspace still sees it, so the value came from the ledger, not client
  state;
- flipping `sddEnabled` moves the UNSET intent's derived value and leaves the
  explicitly-set one alone — the derivation rule the switch exists to override;
- an explicit `null` clears the override and inheritance resumes;
- the write is spec-status neutral (switching to `fast` does not revoke an approved
  spec), and an unknown intent is refused with `intent.notFound`.

No agent tokens are spent — no session is started and no spec is authored. `C3_DB_PATH`
is needed for one seed only (an `approved` `spec_status`, which real approval would
require a live agent run to reach); without it the test SKIPs.

- `pnpm start --port 13000`
- `C3_DB_PATH=~/.c3/c3.db node scripts/e2e/e2e-spec-mode-test.mjs ws://localhost:13000/ws`
  → expect `RESULT: PASS`.

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

## Automation queue (park isolation + manual control)

Drives the deterministic scheduling kernel over the real wire protocol. Seeds a
throwaway git workspace with four `automate` intents — `A`, `B`, `C` (independent)
and `D` (depends on `B`) — starts the queue, then parks `B`.

PASS asserts the properties the queue exists to guarantee:

- a parked intent does **not** stop the queue (it stays live, other candidates
  remain selectable);
- a parked intent is **not** `done`: `D` stays `blocked_dependency` and is never
  launched — parking isolates a failure, it never opens a path around one;
- a blocked queue never reports `done` (a misleading success);
- `force_skip` changes only the queue's selection: never marks `done`, never
  satisfies a dependency;
- `unpark` clears the park, and unparking something **not** parked is refused
  with a visible reason (`queue.notParked`) rather than silently accepted;
- `pause` / `resume` are honoured and preserve the candidate set.

The park is induced through `queue_control override_block` — the explicit human
ruling, which drives the same park mechanism three consecutive failures do. A
genuine agent crash cannot be provoked for ONE intent deterministically, and
reproducing it would cost three live dev turns plus ~90s of real backoff. The
genuine chain (`runDevTurn` rejects → one failed attempt → exponential backoff →
park on the third → unrelated intents still complete → downstream still blocked)
is covered by `server/src/features/intents/workflow.test.ts` ("queue driver —
failure isolation"), which injects a real launch rejection.

Spends **no** agent tokens and needs the intent db (`c3.db`).

- `pnpm start --port 13000`
- `node scripts/e2e/e2e-queue-test.mjs ws://localhost:13000/ws` → expect `RESULT: PASS`.

## Spec automation (author → review → opt-in machine approval → revoke)

Drives the SDD spec phase the queue owns, on one throwaway SDD workspace with a
single `automate` intent that has no spec. The queue authors the spec, reviews it
in a separate read-only session, and the test walks the machine-approval opt-in
through its three meaningful states on that SAME authored spec:

1. **opt-in OFF** (the default every migrated workspace lands on) — the flow runs
   author → review and then STOPS. `spec_approved` must never become true at any
   sample, whatever the reviewer concluded; with a passing review the queue holds
   at `spec_awaiting_approval` tick after tick.
2. **opt-in ON** — the same passing conclusion is approved by the queue with no
   `approve_spec` message on the wire, and the approver is the reserved machine
   identity `c3:machine-spec-approver` (never a login subject).
3. **revoke** — the intent returns to awaiting approval, and the next ticks do
   NOT re-approve the same conclusion. Without the conclusion-level veto a
   machine-approval workspace would undo the revoke within 10 seconds, so this is
   the assertion that makes the revoke button real.

Reusing one authored spec across all three phases is deliberate: it proves the
opt-in is re-read every tick rather than latched at queue start, and it spends
one authoring + review cycle instead of two.

**Spends real agent tokens** (one spec-authoring run plus one or more review
runs) — that is the point, since the flow under test is "does the queue actually
drive these sessions". No DEVELOPMENT turn ever runs: an unapproved spec is never
developed, and the queue is stopped before approval could release that gate.

Exits `5` (SKIP) rather than FAIL when the environment cannot produce the
precondition — no usable agent, or a reviewer that never returns `pass` within
the rework budget. Phase 2 asserts the approval PATH, not the reviewer's
judgement; the rework-cap and escalation rules are pinned deterministically in
`server/src/kernel/queue/reconcile.test.ts` instead.

- `pnpm start --port 13000`
- `node scripts/e2e/e2e-spec-automation-test.mjs ws://localhost:13000/ws` → expect
  `RESULT: PASS`.

## Intent management (save flow + AskUserQuestion gate)

Exercises the intent-management feature end-to-end: register a throwaway
project, enter its intent view (`open_intent_chat` → read-only comm
session + `intents` list), then run the two-turn confirmation flow — turn 1
proposes and must save nothing, turn 2 replies with an explicit textual
confirmation and the agent's `save_intents` call must persist at once with NO
`permission_request` for the save. Confirms the row persists as `todo` and
broadcasts. Then flips it to `done` via `update_intent_status` and checks the
re-broadcast.

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
  and NO isolated relay codex home mount.
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

## Cursor SDK probe (vendor go/no-go gate)

Standalone capability probe for `@cursor/sdk`'s local runtime — the evidence source
for Cursor's capability ledger (see
[`doc/domains/core/agent-session/features/agent-session-cursor.md`](../../doc/domains/core/agent-session/features/agent-session-cursor.md)).
It asserts the two blocking gates — `Agent.resume` restoring native context, and an
agent staying resumable after a turn killed with `Run.cancel()` — plus the native
tool inventory, `call_id` stability across a tool's running/completed frames, the
plan conversation mode, and the SDK local store listing agents c3 created.

Needs a real `CURSOR_API_KEY` + outbound network (the SDK does NOT read the
`cursor-agent login` keychain credential), so it is NOT CI-safe and NOT in the
`pnpm e2e` suite. No key ⇒ SKIP (exit 5).

- `node scripts/e2e/cursor-sdk-probe.mjs` → VERDICT: GO (exit 0) when both gates
  pass; 1 = a gate failed (no-go); 5 = unauthenticated (SKIP). `--gates-only`,
  `--json`, `--keep` (retain the temp workspace) are supported.

## Cursor session test (new → run → list → native-id resume)

Server-wiring E2E over the real WS protocol and the real Cursor SDK (spends two
short turns of real quota). Creates a Cursor session (a `system`-mode Cursor agent
carrying `CURSOR_API_KEY` is injected into settings, snapshot/restore), runs a first
turn asserting `assistant_text` + `tool_use` + a clean `turn_end`, confirms the
bound session appears in `list_sessions`, then re-selects it by the native agent id
captured from `session_started` and runs a second turn to prove resume continuation.

Needs a real `CURSOR_API_KEY` + outbound network, so it is NOT CI-safe and NOT in
the `pnpm e2e` suite. Preconditions unmet → SKIP (exit 5): `@cursor/sdk`
unresolvable, or no API key.

- Start the server: `pnpm start --port 13000`
- `node scripts/e2e/e2e-cursor-session-test.mjs ws://localhost:13000/ws` →
  `RESULT: PASS` on success; 1 = a step failed; 5 = precondition unmet (SKIP).

## Cursor agent config test (runtime signal → config → default agent)

Covers the console-facing half of Cursor support: that a Cursor agent can be
created the way the settings panel creates one and then actually run. Asserts the
`settings` reply's neutral `vendorRuntime` companion answers for every vendor
(cursor as `embedded-sdk`, claude/codex as `host-cli`, cursor absent from
`hostStatus`), that the saved Cursor agent round-trips as
`configMode: 'system'` + `config: { apiKey, model }` with no `baseUrl` and a
plaintext (still-editable) key, and that it can be made the **system default
agent** and launch a session as such.

In the `pnpm e2e` suite, and deliberately **without a SKIP branch** — each
environment has its own assertion instead:

- `@cursor/sdk` unresolvable → cursor must report `available: false` with reason
  `sdk-unresolved` (explicit degradation), config assertions still run, no turn is spent;
- SDK resolvable, no `CURSOR_API_KEY` → the run must fail at the door with a
  message naming BOTH the agent's `apiKey` field and the `CURSOR_API_KEY`
  environment variable;
- SDK resolvable + key present → one short tool-less turn runs to completion on
  the Cursor default agent (spends a small amount of real quota).

It runs last in the suite because it temporarily rewrites `defaultAgentId`; the
original settings snapshot is restored on every exit path.

- Start the server: `pnpm start --port 13000`
- `node scripts/e2e/e2e-cursor-agent-config-test.mjs ws://localhost:13000/ws` →
  `RESULT: PASS` on success; 1 = a step failed.

## Cursor automation (dispatch → run → failure branches)

Covers the automation half of Cursor support: that a `vendor: 'cursor'` `llm`
automation can be created, manually triggered, and executed by the dispatcher's
cursor branch — the vendor the dispatcher used to hard-fail on. It seeds a
throwaway workspace plus a Cursor agent, creates one paused cron automation
(manual trigger only), and reads the execution log back off
`get_automation_detail`.

In the `pnpm e2e` suite and, like the agent-config test, deliberately **without a
SKIP branch** — each environment has its own assertion for the main run:

- `@cursor/sdk` unresolvable → the execution must fail with the locatable
  `cursor_sdk_unresolved` and bind no session;
- SDK resolvable, no `CURSOR_API_KEY` → the failure message must name BOTH the
  agent's `apiKey` field and the environment variable;
- SDK resolvable + key present → one short tool-less `llm_prompt` run completes
  with `success`, a non-empty output and a replayable session id (spends a small
  amount of real quota).

Two failure branches are asserted in every environment by rewriting the agent
list mid-test: a **disabled** bound agent → `automation_agent_disabled`, a
**deleted** one → `automation_agent_not_found`. Afterwards the automation must
still carry `vendor: 'cursor'` and its original `agentId` — a failed automation
never falls back to another vendor or agent. It runs last (after the agent-config
test) because it temporarily rewrites the agent list; the original settings
snapshot is restored on every exit path.

- Start the server: `pnpm start --port 13000`
- `node scripts/e2e/e2e-cursor-automation-test.mjs ws://localhost:13000/ws` →
  `RESULT: PASS` on success; 1 = a step failed.

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
