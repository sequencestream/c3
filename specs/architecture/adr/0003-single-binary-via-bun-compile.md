# 0003 — Single binary via `bun build --compile`

- **Status:** accepted
- **Date:** 2026-05-29

> **Evolution (2026-06-05, [ADR-0010](0010-release-and-distribution-trust.md)):** the
> single-binary decision stands. The **build mechanism** below — generate a real
> `server/src/static-embed.ts` then reset it to a stub in a `finally` — is **superseded**:
> it caused a parallel-build race over a shared file. The embed now lives outside `src/`
> (`dist/static-embed.generated.ts`, generated once) and the compile path redirects to it
> via a `Bun.build` `onResolve` plugin, leaving `server/src/static-embed.ts` a permanent
> committed empty stub. Note: that stub is **committed, not gitignored** (the "gitignored"
> wording below predates this and was never accurate for the stub). The original decision
> rationale is unchanged.

## Context

c3 should be easy to run on a developer's machine without a full Node toolchain or
`node_modules` install. The frontend is a built Vite bundle; the server is TypeScript. We
want one artifact a user can drop on a host and run.

## Options considered

- **Ship the Node CJS bundle + `web/dist` directory.** Pros: standard, simple build.
  Cons: multiple files to distribute; needs Node and a served static directory.
- **`pkg`/`nexe`-style Node packagers.** Pros: single file. Cons: aging tooling, native
  module friction, large output.
- **`bun build --compile`.** Pros: single self-contained executable; can inline web assets
  via Bun's `import … with { type: 'text' }`. Cons: requires `bun` on the host; the SDK's
  bundled `cli-<platform>` lookup misses inside the single-file binary.

## Decision

Build the single binary with `bun build --compile`. Inline `web/dist/**` into a generated
`server/src/static-embed.ts` (gitignored, reset to an empty stub after each build). Because
the SDK can't find its bundled CLI inside the binary, resolve the system `claude`
executable from `$CLAUDE_PATH` or PATH and pass it to the SDK via
`pathToClaudeCodeExecutable`.

## Consequences

- **Easier:** distribution — one file plus a host-installed `claude`.
- **Harder:** the host needs `bun` (default `~/.bun/bin/bun`, override `BUN_BIN`) and a
  logged-in `claude`. Cross-target builds set `BUN_TARGET` / `BUN_OUTFILE`.
- The Node CJS bundle path (`node cli.cjs start`) still works and falls back to serving
  `web/dist` from the filesystem when `STATIC_ASSETS` is empty.

## Compliance

- Build driver: `server/scripts/pkg.mjs`. `static-embed.ts` stays gitignored.
- The `claude` lookup lives in `server/src/claude.ts` (`findClaudeExecutable`).

## References

- `README.md` § Single binary
- `specs/domains/core/agent-session/design.md`
