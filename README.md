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

## End-to-end test

A scripted WebSocket client simulates the browser round-trip:

```bash
# Terminal A
pnpm start --project /tmp --port 13000

# Terminal B
node scripts/e2e-ws-test.mjs ws://localhost:13000/ws
# expected: RESULT: PASS
```

The default test prompt asks Claude to write `/tmp/c3-e2e-test.txt`. The
script:

1. Connects to `/ws`
2. Sends a `user_prompt`
3. Auto-approves the `permission_request` for the `Write` tool
4. Confirms the `tool_result` and `session_end` events arrive

## CLI

```
c3 [start] [--project <path>] [--port 3000] [--dev]
```

`start` is the default command, so `c3` on its own is equivalent to `c3 start`.

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
| `session_end`        | query completed (or errored)                                      |

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
