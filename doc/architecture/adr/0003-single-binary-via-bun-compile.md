# 0003 — Single binary via `bun build --compile`

- **Status:** accepted
- **Date:** 2026-05-29

> **Evolution (2026-06-05, [ADR-0010](0010-release-and-distribution-trust.md)):** the
> single-binary decision stands. The **build mechanism** below — generate the embedded
> web-asset module then reset it to an empty stub in a cleanup step — is **superseded**:
> it caused a parallel-build race over a shared file. The embed now lives as a generated
> snapshot outside the source tree (produced once) and the compile path redirects to it
> via a `Bun.build` `onResolve` plugin, leaving the in-tree embed a permanent committed
> empty stub. Note: that stub is **committed, not gitignored** (the "gitignored" wording
> below predates this and was never accurate for the stub). The original decision rationale
> is unchanged.

## Context

c3 should be easy to run on a developer's machine without a full Node toolchain or a
dependency install. The frontend is a built web bundle; the server is TypeScript. We
want one artifact a user can drop on a host and run.

## Options considered

- **Ship the Node CJS bundle + the built web-asset directory.** Pros: standard, simple build.
  Cons: multiple files to distribute; needs Node and a served static directory.
- **`pkg`/`nexe`-style Node packagers.** Pros: single file. Cons: aging tooling, native
  module friction, large output.
- **`bun build --compile`.** Pros: single self-contained executable; can inline web assets
  via Bun's text-import facility. Cons: requires `bun` on the host; the SDK's
  bundled per-platform CLI lookup misses inside the single-file binary.

## Decision

Build the single binary with `bun build --compile`. Inline the built web assets into a
generated embed module (gitignored, reset to an empty stub after each build). Because
the SDK can't find its bundled CLI inside the binary, resolve the system `claude`
executable from the `CLAUDE_PATH` override or PATH and pass it to the SDK via the SDK's
explicit-executable-path option (`pathToClaudeCodeExecutable`).

## Consequences

- **Easier:** distribution — one file plus a host-installed `claude`.
- **Harder:** the host needs `bun` (default `~/.bun/bin/bun`, override via the `BUN_BIN`
  env var) and a logged-in `claude`. Cross-target builds set the `BUN_TARGET` / `BUN_OUTFILE`
  env vars.
- The Node CJS bundle path still works and falls back to serving the built web assets from
  the filesystem when the embedded-assets env var is empty.

## Compliance

- The embed module stays gitignored.
- The `claude` executable lookup is owned by the server's host-binary resolution.

## References

- `README.md` § Single binary
- `doc/domains/core/agent-session/agent-session-design.md`
