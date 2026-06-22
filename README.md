# c3 — Code Creative Center

Local web UI for [Claude Code](https://docs.claude.com/en/docs/claude-code) that
intercepts every tool-use permission request through the browser, instead of
the terminal.

```
┌────────────┐       /ws        ┌──────────────────────────┐
│  Browser   │ ───────────────► │  Hono server (this app)  │
│  (Vue3)    │ ◄─── ws ───────  │   ↓ canUseTool callback  │
│            │                  │   ↓                      │
│ Allow/Deny │                  │  @anthropic-ai/          │
│  dialog    │                  │     claude-agent-sdk     │
└────────────┘                  └──────────────────────────┘
                                          │ spawns
                                          ▼
                                   `claude` CLI binary
```

> **Hard runtime dependency — install the host CLI per agent type**: each agent
> vendor runs as a host-CLI subprocess that **cannot** be packed into c3's single
> binary. The binary in `dist/` ships `c3` itself and nothing else — "self-contained"
> is an illusion. For the Claude agent type the `claude` CLI must be installed and
> logged in (`claude /login`) on the host; override its path with `$CLAUDE_PATH`.
> A missing host CLI is a product convention, not a bug: that agent type is simply
> unavailable (c3 logs present/missing CLIs at startup with install guidance). See
> [ADR-0012](specs/architecture/adr/0012-host-binary-probe-first-capability-gate.md).

## Quick start (development)

```bash
pnpm install
pnpm dev
# server:  http://localhost:3000
# vite:    http://localhost:5173  ← open this one
```

The Vite dev server proxies `/ws` to the Hono server, so the browser connects
to `ws://localhost:5173/ws` transparently.

## Production build

```bash
pnpm build
pnpm start
# defaults: --workspace = current directory, --port 3000
# or override: pnpm start --workspace /absolute/path/to/your/project --port 3000
# open http://localhost:3000
```

`pnpm start` is just `node server/dist/cli.cjs start`.

## Single binary

```bash
pnpm binary
# outputs: dist/c3-macos-arm64  (~61MB)
./dist/c3-macos-arm64
# or override: ./dist/c3-macos-arm64 start --workspace /abs/path --port 3000
```

Built with [`bun build --compile`](https://bun.sh/docs/bundler/executables).
Host must have `bun` on PATH (default: `~/.bun/bin/bun`; override with
`BUN_BIN`). Frontend assets in `web/dist/**` are inlined into the binary via a
generated `server/src/static-embed.ts` (Bun's `import ... with { type: 'text' }`
attribute). The file is in `.gitignore` and reset to an empty stub after each
`pnpm binary` run.

Cross-target builds: override env when invoking `node server/scripts/pkg.mjs`:

```bash
BUN_TARGET=bun-linux-x64 BUN_OUTFILE=dist/c3-linux-x64 \
  node server/scripts/pkg.mjs
```

The binary spawns the system `claude` CLI (or `$CLAUDE_PATH`) for the SDK's
agent process, since the SDK's bundled `cli-<platform>` lookup misses inside a
single-file Bun binary.

## Download & verify

Release binaries are published on **GitHub Releases** (this package is `private` and is
**not** on npm). Each platform artifact ships with a `.sha256` and an Ed25519 **minisign**
signature `.minisig`; an aggregate `SHA256SUMS`(`.minisig`) covers all of them.

| Platform                                       | Artifact                        | Sidecars               |
| ---------------------------------------------- | ------------------------------- | ---------------------- |
| macOS arm64 (P0)                               | `c3-v{version}-macos-arm64`     | `.sha256` + `.minisig` |
| macOS x64 — Intel (P0)                         | `c3-v{version}-macos-x64`       | `.sha256` + `.minisig` |
| Linux x64 (P0)                                 | `c3-v{version}-linux-x64`       | `.sha256` + `.minisig` |
| Windows x64 (P1) ⚠️ **experimental**           | `c3-v{version}-windows-x64.exe` | `.sha256` + `.minisig` |
| _(more platforms land in later release waves)_ |                                 |

All artifacts are built and smoke-verified on their **native OS** via the
[`.github/workflows/release.yml`](.github/workflows/release.yml) native matrix: a `needs:`
chain physically guarantees the pregate → build → smoke → verify-dist → provenance → publish
order, native builds turn on `--bytecode` (faster cold start, lower memory peak) with
cross-compile kept off (oven-sh/bun#18416 segfault), and macOS runners perform the ad-hoc
codesign for real (not a no-op as on a non-darwin host). A SLSA L3 provenance attestation
(`.intoto.jsonl`, OIDC keyless) is generated per artifact and uploaded to the release for
`gh attestation verify`. P0 completeness is enforced by `release:verify-dist` — a missing
P0 blocks the publish.

> **⚠️ Windows x64 is experimental.** The Windows binary is built and smoke-tested on a
> `windows-latest` runner (Windows platform code paths — `claude` discovery via `where`,
> `%USERPROFILE%\.c3` home, `bun:sqlite` startup probe — are merged), but it is not yet
> considered first-class until the matrix smoke is green over multiple runs. It is signed
> and shipped alongside the rest, but the manifest entry still carries `"experimental": true`
> and the README marks it ⚠️. De-experimental is the one-line change of removing
> `'windows-x64'` from `EXPERIMENTAL_TARGETS` in `scripts/release/targets.mjs` once the
> matrix smoke is stably green. The other P0 macOS + Linux artifacts are smoke-verified on
> their own OS.

**minisign public key** (also embedded in the binary for `c3 verify`):

```
untrusted comment: c3 release signing key (minisign)
RWQzBKv0lANWnVsOQNO6o7YjLi0MbFGbI0K0fUTIaXTWKM62tlosg306
```

Verify a download — either with the bundled self-check (no extra tools):

```bash
./c3-v0.2.0-macos-arm64 verify ./c3-v0.2.0-macos-arm64
# ✓ VERIFIED  c3-v0.2.0-macos-arm64
```

…or with the official [`minisign`](https://jedisct1.github.io/minisign/) CLI:

```bash
minisign -Vm c3-v0.2.0-macos-arm64 -P RWQzBKv0lANWnVsOQNO6o7YjLi0MbFGbI0K0fUTIaXTWKM62tlosg306
```

## Hardening tiers (release 7/7)

`RELEASE_HARDEN` (env) or `--harden=` selects a hardening tier for the native binaries.
Default is **`basic`** — minify + strip + manifest. The **standard** tier adds an opt-in
obfuscation pass; the other two tiers are unchanged. See `specs/non-functional/release.md`
"Hardening tiers" for the full table and `specs/non-functional/security.md` "Non-goal:
hardening" for the full NOT-doing list.

```bash
pnpm release:build                                  # default: basic (minify + manifest, no obfuscation)
RELEASE_HARDEN=standard pnpm release:build          # opt-in: string-array + identifier rename (release 7/7)
RELEASE_HARDEN=standard pnpm release                 # additionally forces `pnpm e2e --obfuscated` as logic-regression hard evidence
```

**Standard tier (release 7/7) — what it does:**

- Runs `javascript-obfuscator` between bundling and compiling (string-array + identifier
  rename only — see `server/scripts/release/obfuscate.mjs` `OBFUSCATOR_OPTIONS` for the
  locked set).
- Source maps are written to `dist/maps/<target>.js.map` (gitignored, local-only; **not**
  uploaded to GitHub Releases).
- E2E suite is forced with `--obfuscated`, booting `bun dist/.obf-stage/<hostTarget>.js`
  instead of `node server/dist/cli.cjs` — proves the obfuscator didn't break the protocol
  flow.
- Graceful fallback: if obfuscation throws or times out, the artifact ships as the
  un-obfuscated minified bundle, the manifest stamps `obfuscation: { applied: false }`
  for that artifact, and the build keeps going (exit 0, release is NOT blocked).

**Standard tier — what it does NOT do** (each row in the full table in
`specs/non-functional/security.md` has a "why"):

- ❌ Control-flow flattening (e2e regressions hard to diagnose; zero defensive value)
- ❌ String encryption (redundant with string-array; +5–10% startup)
- ❌ Object-key transformation (breaks runtime dispatch)
- ❌ `selfDefending` / anti-debug (false-positives CI; trivially bypassed)
- ❌ UPX packing (`upx -d` reverses it in ~1s; triggers Defender false positives)
- ❌ License / activation checks (conflicts with **SEC-6**; c3 has no server to validate against)
- ❌ Anti-tamper / self-integrity-check (redundant with the manifest sha256 + minisign chain)

> **Code signing certificates** (macOS Developer ID + notarization, Windows Authenticode
> with signtool) are **deferred to release 8/7** — they require real certificates in
> GitHub Secrets, which we don't have yet. Until then, macOS users clear Gatekeeper
> quarantine with `xattr -dr com.apple.quarantine` (already documented above) and Windows
> users see the standard SmartScreen warning.

> **macOS Gatekeeper**: binaries are **ad-hoc** signed (no Apple Developer ID / notarization
> yet), so first launch is blocked by quarantine. After verifying the signature, clear it:
>
> ```bash
> xattr -dr com.apple.quarantine ./c3-v0.2.0-macos-arm64
> ```

> Distribution trust is the signing chain above — `minify`/`strip` are **not** a security
> control (see [`specs/non-functional/security.md`](specs/non-functional/security.md)
> → "Non-goal: anti-decompilation").

## End-to-end tests

`pnpm e2e` runs the whole WebSocket suite: it boots one server (with a throwaway
requirement db, leaving `~/.c3` untouched), runs every test against it, and
prints a pass/fail summary. See [`scripts/e2e/e2e-guide.md`](scripts/e2e/e2e-guide.md)
for the individual tests (smoke, requirement management, consensus voting).

```bash
pnpm e2e              # build, boot, run all, report
pnpm e2e --no-build   # reuse the existing server/dist build
```

Each test is also runnable on its own against a manually-started server, e.g.
the smoke test:

```bash
# Terminal A
pnpm start --workspace /tmp --port 13000

# Terminal B
node scripts/e2e/e2e-ws-test.mjs ws://localhost:13000/ws
# expected: RESULT: PASS
```

The smoke prompt asks Claude to write `/tmp/c3-e2e-test.txt`. The script:

1. Connects to `/ws` and creates a session in the seed workspace
2. Pins the session to `default` mode and sends a `user_prompt`
3. Auto-approves the `permission_request` for the `Write` tool (or accepts a
   unanimous `consensus_auto` when consensus is enabled)
4. Confirms the `tool_result` and `turn_end` events arrive

## CLI

```
c3 [start] [--workspace <path>] [--port 3000] [--dev] [--daemon]
c3 install   [--workspace <path>] [--port 3000] [--settings <path>]
c3 uninstall
c3 verify <file>
```

`start` is the default command, so `c3` on its own is equivalent to `c3 start`.

- `verify <file>`: offline-check a downloaded artifact against the embedded minisign public
  key (see [Download & verify](#download--verify)). Exit 0 = `VERIFIED`, non-zero = tampered
  or unsigned.

- `--workspace` _(optional)_: seed workspace directory passed to the SDK as `cwd`.
  Claude reads/writes files relative to it. Defaults to the current directory;
  more workspaces can be added from the UI. `--project` remains as a deprecated
  alias (prints a warning) for one cycle.
- `--port`: HTTP port (default 3000).
- `--dev`: skip serving the frontend bundle (use Vite at :5173 instead).
- `--settings <path>`: use this `settings.json` instead of the default `~/.c3/settings.json`
  (its directory also holds `state.json`). Baked as an absolute path into a `--daemon`
  child and into an installed service unit, so the background/service process reads the
  same c3 home.

### Background (`--daemon`)

`c3 start --daemon` launches the server in the background and exits immediately. It
re-spawns a detached `c3 start` (same `--workspace`/`--port`/`--settings`, never `--daemon`
again), redirecting its output to `~/.c3/c3-daemon.log` and recording the child PID in
`~/.c3/c3.pid`. Binding is unchanged (loopback-only, like a foreground `c3 start` — no
network exposure is added).

- A second `--daemon` while one is already running prints the live PID and exits non-zero
  instead of starting a duplicate; a stale PID file (process gone) is overwritten.
- Stop a daemon with `kill "$(cat ~/.c3/c3.pid)"`.

### OS service (`c3 install` / `c3 uninstall`)

`c3 install` registers c3 as a **per-user** OS service (no root/admin required) that runs
`c3 start` under the platform's service manager — the manager owns the lifecycle, so the
service does **not** use `--daemon`. The current `--workspace`/`--port`/`--settings` are
baked into the unit. Platforms differ by design:

| Platform | Mechanism                 | Unit / registration                                                   | Auto-start                                                                                             |
| -------- | ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Linux    | systemd **user** unit     | `~/.config/systemd/user/c3.service` + `systemctl --user`              | At login. Starting before login / surviving logout needs `loginctl enable-linger` (printed as a hint). |
| macOS    | launchd **LaunchAgent**   | `~/Library/LaunchAgents/center.c3.server.plist` + `launchctl load -w` | Within your login session, at each login.                                                              |
| Windows  | Task Scheduler logon task | `schtasks /Create … /SC ONLOGON` (task name `c3`)                     | At logon (a logon-triggered task, **not** a pre-login service).                                        |

The service process depends on the host `claude` / `codex` CLI being on the service
account's PATH — that PATH can differ from your login shell, which is the usual cause of
"agent unavailable" under a service. The startup log (`~/.c3/log/c3.log`) reports which
host CLIs were found.

`c3 uninstall` removes the current platform's registration: Linux runs `systemctl --user
disable --now c3.service` then removes its unit file; macOS unloads and removes the LaunchAgent
plist; Windows deletes the `c3` Task Scheduler task. It is idempotent: a service that is already
absent reports that nothing needs removal and exits successfully.

Uninstalling **only removes the OS service registration**. It does not delete `~/.c3` settings,
database, worktrees, specs, logs, or pid files, and it does not terminate an existing c3 process.
An unsupported platform, missing/failing `systemctl`/`launchctl`/`schtasks`, exits non-zero with
the underlying stderr shown. Updating c3 remains manual; auto-update is not provided.

## WebSocket protocol

Both sides use JSON envelopes at `ws://<host>/ws`. Types live in
[`shared/src/protocol.ts`](shared/src/protocol.ts).

Client → server:

| type                  | fields                                     | meaning                                |
| --------------------- | ------------------------------------------ | -------------------------------------- |
| `user_prompt`         | `text`                                     | new user turn                          |
| `permission_response` | `requestId`, `decision: 'allow' \| 'deny'` | answer to a prior `permission_request` |
| `ping`                | —                                          | keepalive                              |

Server → client:

| type                 | meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `ready`              | WS handshake complete                                             |
| `assistant_text`     | streamed text block from the model                                |
| `tool_use`           | model decided to call a tool _(already approved when this fires)_ |
| `tool_result`        | tool finished                                                     |
| `permission_request` | **block point — UI must answer with `permission_response`**       |
| `turn_end`           | query completed (or errored)                                      |

## How permission interception works

`server/src/claude.ts` calls the SDK's `query()` with a `canUseTool` callback.
Whenever Claude wants to invoke a tool that needs approval, the callback:

1. Generates a `requestId`
2. Sends a `permission_request` over the WS
3. Awaits a `Promise` stored in `pendingApprovals: Map<requestId, resolver>`
4. On `permission_response` from the client, resolves to `{behavior:'allow'|'deny'}`
5. 60 s timeout → auto-deny

`settingSources: ['user', 'project']` is passed to the SDK so it inherits the user's
`~/.claude` and the project `.claude` settings (hooks, allow/deny rules, Skills,
`CLAUDE.md`). `c3` is the permission **gateway**: inherited rules apply first, and any
tool they don't pre-decide flows through `canUseTool` to the browser (an inherited
allow-rule may auto-approve without prompting).

> **Note about `permissionMode: 'default'`**: the SDK only invokes `canUseTool`
> for operations it considers "sensitive" (e.g. `Write`, `Edit`, dangerous
> `Bash`). Read-only operations and trivial `Bash` like `echo` are auto-allowed
> by the SDK's built-in classifier even when a callback is provided. This
> matches Claude Code's interactive behavior.

## Project layout

```
code-creative-center/
├── shared/src/protocol.ts    # WS message types
├── server/
│   ├── src/cli.ts            # commander entry
│   ├── src/server.ts         # Hono + WS handler + embedded static router
│   ├── src/claude.ts         # SDK + canUseTool + claude PATH lookup
│   ├── src/static-embed.ts   # generated, gitignored, Bun-inlined web/dist
│   ├── build.mjs             # esbuild → dist/cli.cjs (node mode)
│   ├── scripts/pkg.mjs       # bun --compile driver
│   └── package.json          # bin: c3
├── web/
│   ├── src/App.vue           # ChatView + PermissionDialog
│   ├── src/lib/ws.ts         # WS client
│   └── vite.config.ts        # dev proxy → :3000
└── scripts/e2e-ws-test.mjs   # end-to-end smoke test
```

## License

Internal — not for distribution.
