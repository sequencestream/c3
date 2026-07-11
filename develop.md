# Development guide — c3

Everything you need to build, run from source, test, release, and understand
c3's internals. For an end-user overview and install instructions see the
[README](README.md); for guided walkthroughs see the [handbook](handbook/README.md).

## Quick start (development)

```bash
pnpm install
pnpm dev
# server:  http://localhost:3000
# vite:    http://localhost:5173  ← open this one
```

The Vite dev server proxies `/ws` to the Hono server, so the browser connects
to `ws://localhost:5173/ws` transparently.

Common workspace scripts:

```bash
pnpm typecheck   # vue-tsc --noEmit across packages
pnpm lint        # eslint . (pnpm lint:fix to autofix)
pnpm format      # prettier --write . (--check via format:check)
pnpm test        # vitest run
```

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

The binary spawns the resolved vendor CLI for agent processes. The default path is
c3-managed (`~/.c3/vendor/claude/.../bin/claude` or
`~/.c3/vendor/codex/.../bin/codex`); explicit `CLAUDE_PATH` / `CODEX_PATH` still
win for development and debugging. Host `PATH` is only a compatibility fallback
when managed install or health checks fail.

## Release build

The release build is **compile → pack → sha256 checksum**: `bun --compile` produces one
standalone native binary per target, `pack` wraps it into a distributable archive, and a
per-artifact `.sha256` + aggregate `SHA256SUMS` provide integrity. c3 is open source — there
is **no code obfuscation**. See [`doc/non-functional/release.md`](doc/non-functional/release.md)
for the full pipeline.

```bash
pnpm release:build                                  # P0 matrix, parallel, + manifest (minify, bytecode off)
pnpm release:build --targets=linux-x64              # subset
pnpm release:build --dry-run                        # print the plan, execute nothing
```

Release artifacts are built and smoke-verified on their **native OS** via the
[`.github/workflows/release.yml`](.github/workflows/release.yml) native matrix: a `needs:`
chain guarantees the pregate → build → smoke → verify-dist → publish order, and a final
`publish` job gathers every target's signed artifacts and cuts one public **GitHub Release**
with notes auto-generated from the merged-PR / commit history (`gh release --generate-notes`).
Pushing a `v*` tag (or running the workflow manually) publishes.

> **macOS Gatekeeper**: binaries are **ad-hoc** signed (no Apple Developer ID / notarization
> yet), so first launch is blocked by quarantine. After verifying the checksum, clear it:
>
> ```bash
> xattr -dr com.apple.quarantine ./c3-v0.2.0-macos-arm64
> ```

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
c3/
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

See [`doc/`](doc/) for the architecture spec, ADRs, domain specs, and flows — the
source of truth kept in sync with the code.
