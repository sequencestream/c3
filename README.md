# c3 — Claude Code Center

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

> **Hard runtime dependency**: the `claude` CLI must be installed and logged in
> (`claude /login`) on the host running `c3`. The single binary in `dist/` only
> ships `c3` itself, not Claude Code.

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
# defaults: --project = current directory, --port 3000
# or override: pnpm start --project /absolute/path/to/your/project --port 3000
# open http://localhost:3000
```

`pnpm start` is just `node server/dist/cli.cjs start`.

## Single binary

```bash
pnpm binary
# outputs: dist/c3-macos-arm64  (~61MB)
./dist/c3-macos-arm64
# or override: ./dist/c3-macos-arm64 start --project /abs/path --port 3000
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
| Linux x64 (P0)                                 | `c3-v{version}-linux-x64`       | `.sha256` + `.minisig` |
| macOS x64 (P1)                                 | `c3-v{version}-macos-x64`       | `.sha256` + `.minisig` |
| Windows x64 (P1) ⚠️ **experimental**           | `c3-v{version}-windows-x64.exe` | `.sha256` + `.minisig` |
| _(more platforms land in later release waves)_ |                                 |

> **⚠️ Windows x64 is experimental.** The Windows binary is cross-compiled and the platform
> code paths (`claude` discovery via `where`, `%USERPROFILE%\.c3` home, `bun:sqlite` startup
> probe) are in place, but it has **not yet passed a real headless smoke on a windows-latest
> runner**. It is signed and shipped alongside the rest, but treat it as unverified until a
> future release wave runs that smoke and drops the experimental tag. P0/P1 macOS + Linux
> artifacts are smoke-verified on their own OS.

**minisign public key** (also embedded in the binary for `c3 verify`):

```
untrusted comment: c3 release signing key (minisign)
RWQGEiNpXN1t9VEX2lXZab7nHaR+gfjfPYcCYN6Bxyid5NkuQK/Gme+l
```

Verify a download — either with the bundled self-check (no extra tools):

```bash
./c3-v0.2.0-macos-arm64 verify ./c3-v0.2.0-macos-arm64
# ✓ VERIFIED  c3-v0.2.0-macos-arm64
```

…or with the official [`minisign`](https://jedisct1.github.io/minisign/) CLI:

```bash
minisign -Vm c3-v0.2.0-macos-arm64 -P RWQGEiNpXN1t9VEX2lXZab7nHaR+gfjfPYcCYN6Bxyid5NkuQK/Gme+l
```

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
pnpm start --project /tmp --port 13000

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
c3 [start] [--project <path>] [--port 3000] [--dev]
c3 verify <file>
```

`start` is the default command, so `c3` on its own is equivalent to `c3 start`.

- `verify <file>`: offline-check a downloaded artifact against the embedded minisign public
  key (see [Download & verify](#download--verify)). Exit 0 = `VERIFIED`, non-zero = tampered
  or unsigned.

- `--project` _(optional)_: seed workspace directory passed to the SDK as `cwd`.
  Claude reads/writes files relative to it. Defaults to the current directory;
  more workspaces can be added from the UI.
- `--port`: HTTP port (default 3000).
- `--dev`: skip serving the frontend bundle (use Vite at :5173 instead).

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
claude-code-center/
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
