# Development guide — c3

Build, run, test, and release from this tree. Product overview and install:
[README](../README.md). Walkthroughs: [handbook](../handbook/README.md).

## Quick start

```bash
pnpm install
pnpm dev
```

Vite listens on `:5173` and proxies `/ws` to the Hono server. Open
`http://localhost:5173`.

`pnpm start` binds loopback. Pass `--host` to expose the process; non-loopback
bind should enable auth ([SEC-1](non-functional/security.md),
[auth](domains/core/auth/auth-overview.md)).

## Tests

Tests never write the real instance database (`~/.c3/c3.db`). Isolation is via
`C3_DIR`, `C3_DB_PATH`, and `C3_TEST_DIR`.

```bash
C3_TEST_DIR=/tmp/.c3-test pnpm test
```

`pnpm e2e` runs against an isolated database. Isolation contract and per-test
commands: [e2e-guide](../scripts/e2e/e2e-guide.md).

## Binary and release

`pnpm binary` compiles one native executable with `bun build --compile`
([ADR-0003](architecture/adr/0003-single-binary-via-bun-compile.md)). Host
vendor CLIs are required; an environment-variable override beats a managed
install; Cursor is not distributed
([ADR-0012](architecture/adr/0012-host-binary-probe-first-capability-gate.md),
[agent-sdk](architecture/agent-sdk.md)).

A release is compile → pack → sha256. There is no obfuscation
([release.md](non-functional/release.md)). How a maintainer cuts a public
GitHub Release versus a local artifact tree:
[release-steps](publish/release-steps.md). `pnpm release:build` runs the
local pipeline.

macOS artifacts are ad-hoc signed; after verifying the checksum, clear
Gatekeeper quarantine with `xattr -dr com.apple.quarantine ./c3`.

## Desktop

The desktop app is a Tauri 2 shell that runs that same binary as a sidecar
([ADR-0033](architecture/adr/0033-tauri-desktop-shell-sidecar.md),
[desktop README](../desktop/README.md)):

```bash
pnpm release:desktop
```
