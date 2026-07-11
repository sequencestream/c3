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

> **Managed vendor CLIs by default**: c3 resolves each vendor executable in this
> order: explicit `CLAUDE_PATH` / `CODEX_PATH`, then c3's managed install under
> `~/.c3/vendor/<vendor>/<version>/bin/<binary>`, then a degraded host `PATH`
> fallback. c3 installs and updates the managed Claude Code / Codex CLIs from npm
> package metadata, verifies package integrity, and records source/version state in
> `~/.c3/vendor/manifest.json`. c3 does not modify your shell profile, package
> manager installs, PATH, or vendor login credentials. See
> [ADR-0012](doc/architecture/adr/0012-host-binary-probe-first-capability-gate.md).

## Features

- **Browser-mediated permission gateway** — every sensitive tool-use request is
  approved/denied in the browser, not the terminal; inherited `~/.claude` /
  project `.claude` allow-deny rules apply first.
- **Multi-vendor agents** — managed Claude Code / Codex CLIs, resolved and updated
  automatically under `~/.c3/vendor` (host PATH is only a fallback).
- **Intents, discussions & automations** — turn a prompt into a tracked intent,
  run multi-agent discussions/consensus, and schedule recurring automations.
- **Sandboxed runs** — optional Docker-backed sandbox with resource limits.
- **Optional account auth** — username/password accounts with an admin gate
  (off by default; loopback-only otherwise).
- **Single self-contained binary** — one native executable per platform, with a
  `c3 upgrade` self-update from GitHub Releases.

See [`doc/features.md`](doc/features.md) for the full feature tree.

## Usage

### Download

Release binaries are published on **GitHub Releases** (this package is **not** on npm).
Each platform artifact ships with a `.sha256` checksum; an aggregate `SHA256SUMS` covers
all of them. Integrity is provided by these sha256 checksums plus GitHub's HTTPS delivery.

| Platform                                       | Artifact                        | Sidecar   |
| ---------------------------------------------- | ------------------------------- | --------- |
| macOS arm64 (P0)                               | `c3-v{version}-macos-arm64`     | `.sha256` |
| macOS x64 — Intel (P0)                         | `c3-v{version}-macos-x64`       | `.sha256` |
| Linux x64 (P0)                                 | `c3-v{version}-linux-x64`       | `.sha256` |
| Windows x64 (P1) ⚠️ **experimental**           | `c3-v{version}-windows-x64.exe` | `.sha256` |
| _(more platforms land in later release waves)_ |                                 |

Verify a download against its published sha256 checksum (no extra tools):

```bash
shasum -a 256 -c c3-v0.2.0-macos-arm64.sha256
# c3-v0.2.0-macos-arm64: OK
# or check every artifact at once:
shasum -a 256 -c SHA256SUMS
```

> **macOS Gatekeeper**: binaries are ad-hoc signed (no Apple Developer ID /
> notarization yet), so first launch is blocked by quarantine. After verifying the
> checksum, clear it: `xattr -dr com.apple.quarantine ./c3-v0.2.0-macos-arm64`.
> On Windows you may see the standard SmartScreen warning.

### Run

```bash
./c3
# defaults: --workspace = current directory, --port 3000
# open http://localhost:3000
./c3 start --workspace /absolute/path/to/your/project --port 3000
```

`start` is the default command, so `c3` on its own is equivalent to `c3 start`.
Claude reads/writes files relative to `--workspace`; more workspaces can be added
from the UI.

### CLI

```
c3 [start] [--workspace <path>] [--port 3000] [--dev] [--daemon]
c3 install   [--workspace <path>] [--port 3000] [--settings <path>]
c3 uninstall
c3 upgrade   [--check] [--force] [--repo <owner/repo>] [--target <target>]
c3 restart
```

- `start` _(default)_ flags:
  - `--workspace <path>` _(optional)_: seed workspace directory passed to the SDK
    as `cwd`. Defaults to the current directory. `--project` is a deprecated alias.
  - `--port`: HTTP port (default 3000).
  - `--dev`: skip serving the frontend bundle (use Vite at :5173 instead).
  - `--daemon`: run in the background (see below).
  - `--settings <path>`: use this `settings.json` instead of `~/.c3/settings.json`.
- `upgrade`: self-update the installed binary from the latest GitHub release —
  download the platform package plus its `.sha256`, **verify it against the published
  sha256 checksum**, unpack, and atomically replace the current binary. A mismatched or
  corrupt download is rejected before any replacement, leaving the installed binary
  untouched. It only touches the current writable binary — never PATH, shell profiles,
  or a package manager's copy. `--check` compares versions only; `--force` reinstalls the
  same version. **upgrade never restarts a running c3** — run `c3 restart` afterwards to
  load the new version. Needs network access to GitHub; set `GITHUB_TOKEN` to avoid API
  rate limits.
- `restart`: restart the c3 OS service or `--daemon` background process so an upgraded
  binary takes effect (OS service takes priority over daemon). It does not upgrade,
  download, or touch a foreground session.

#### Background (`--daemon`)

`c3 start --daemon` launches the server in the background and exits immediately. It
re-spawns a detached `c3 start` (same `--workspace`/`--port`/`--settings`), redirecting
its output to `~/.c3/c3-daemon.log` and recording the child PID in `~/.c3/c3.pid`. Binding
is unchanged (loopback-only — no network exposure is added). A second `--daemon` while one
is running prints the live PID and exits non-zero. Stop it with `kill "$(cat ~/.c3/c3.pid)"`.

#### OS service (`c3 install` / `c3 uninstall`)

`c3 install` registers c3 as a **per-user** OS service (no root/admin required) that runs
`c3 start` under the platform's service manager. The current `--workspace`/`--port`/`--settings`
are baked into the unit.

| Platform | Mechanism                 | Unit / registration                                                   | Auto-start                                                                                             |
| -------- | ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Linux    | systemd **user** unit     | `~/.config/systemd/user/c3.service` + `systemctl --user`              | At login. Starting before login / surviving logout needs `loginctl enable-linger` (printed as a hint). |
| macOS    | launchd **LaunchAgent**   | `~/Library/LaunchAgents/center.c3.server.plist` + `launchctl load -w` | Within your login session, at each login.                                                              |
| Windows  | Task Scheduler logon task | `schtasks /Create … /SC ONLOGON` (task name `c3`)                     | At logon (a logon-triggered task, **not** a pre-login service).                                        |

`c3 uninstall` removes the current platform's registration and is idempotent. It **only**
removes the OS service registration — it does not delete `~/.c3` settings, database,
worktrees, logs, or pid files, and does not terminate a running c3 process. To update a
service install, run `c3 upgrade` then `c3 restart`.

## Documentation

- **[Handbook](handbook/README.md)** — 中文上手教程(get-start、discussion、
  multi-agent consensus、requirement-to-intent、SDD)。
- **[Development guide](develop.md)** — build from source, single binary, release
  pipeline, end-to-end tests, WebSocket protocol, and how permission interception works.
- **[`doc/`](doc/)** — architecture spec, ADRs, domain specs, and flows (the source of
  truth kept in sync with the code).

## License

[Apache-2.0](LICENSE).
