# c3 — Code Creative Center

A local, single-user **personal AI workbench** that centrally manages and drives
the work of multiple AI coding agents — [Claude Code](https://docs.claude.com/en/docs/claude-code),
Codex, and more — from one browser UI. Every sensitive tool-use permission request
is intercepted and approved through the browser, instead of the terminal.

```
┌────────────┐       /ws        ┌──────────────────────────┐
│  Browser   │ ───────────────► │  Hono server (this app)  │
│  (Vue3)    │ ◄─── ws ───────  │   ↓ canUseTool callback  │
│            │                  │   ↓                      │
│ Allow/Deny │                  │  claude-agent-sdk        │
│  dialog    │                  │  codex-sdk               │
└────────────┘                  └──────────────────────────┘
                                          │ spawns
                                          ▼
                             `claude/codex` CLI binary
```

## Features

- **Browser-mediated permission gateway** — every sensitive tool-use request is approved/denied in the browser, not the terminal; inherited `~/.claude` / project `.claude` allow-deny rules apply first.
- **Multi-vendor agents** — managed Claude Code / Codex CLIs, resolved and updated automatically under `~/.c3/vendor` (host PATH is only a fallback).
- **Intents, discussions & automations** — turn a prompt into a tracked intent, run multi-agent discussions/consensus, and schedule recurring automations.
- **Sandboxed runs** — optional Docker-backed sandbox with resource limits.
- **Optional account auth** — username/password accounts with an admin gate (off by default; loopback-only otherwise).
- **Single self-contained binary** — one native executable per platform, with a`c3 upgrade` self-update from GitHub Releases.

See [`doc/features.md`](doc/features.md) for the full feature tree.

## Usage

### Download

Release binaries are published on **GitHub Releases**.

```bash
shasum -a 256 -c c3-v0.9.6-macos-arm64.sha256
# c3-v0.9.6-macos-arm64: OK
# or check every artifact at once:
shasum -a 256 -c SHA256SUMS
```

### Run

```bash
./c3 --port 3000 --daemon
# open http://localhost:3000
```

#### OS service (`c3 install` / `c3 uninstall`)

```bash
c3 install # registers c3 as a **per-user** OS service (no root/admin required) that runs
c3 start # under the platform's service manager. The current `--workspace`/`--port`/`--settings`
c3 uninstall # removes the current platform's registration and is idempotent. It **only**
```

## Documentation

- **[Handbook](handbook/README.md)** — 中文上手教程(get-start、discussion、
  multi-agent consensus、requirement-to-intent、SDD)。
- **[Development guide](develop.md)** — build from source, single binary, release
  pipeline, end-to-end tests, WebSocket protocol, and how permission interception works.
- **[`doc/`](doc/)** — architecture spec, ADRs, domain specs, and flows (the source of
  truth kept in sync with the code).

## License

[Apache-2.0](LICENSE).
