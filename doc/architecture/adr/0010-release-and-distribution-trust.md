# 0010 — Release & distribution trust

- **Status:** accepted
- **Date:** 2026-06-05

## Context

ADR-0003 established the single-binary build via `bun build --compile`, driven by a single
build script. That driver builds **one** target and, in a cleanup step, rewrites the
embedded web-asset module back to an empty stub so the bundler and the working tree stay
clean. Two structural problems block multi-platform distribution:

1. **Parallel race.** Every target generates and then resets the same shared embed file.
   Two targets building concurrently stomp each other and leave the working tree dirty.
2. **No orchestration.** There is no first-class "build all platforms" entry point, no
   target matrix, and no place to hang later distribution concerns (signing, version
   injection, channels, hardening).

This is the first of a 7-step release effort. Step 1 is the **orchestration skeleton**:
make multi-platform builds race-free and add the seams for later trust work — without
replacing the proven `build` / `binary` primitives. Steps 2 (version injection + manifest +
harden tiers) and 3 (distribution trust: SHA256SUMS + minisign + macOS ad-hoc + `c3 verify` +
notes/publish orchestration) build on these seams.

## Options considered

- **Phase-gate the existing in-tree embed file (single write + single reset).** Generate the
  real embed once, reset once after all targets. Pros: keeps the `bun build --compile`
  CLI; minimal churn. Cons: the artifact still transits the source tree (briefly dirty
  mid-build); does not satisfy the "embed leaves the source tree" goal; the shared-file seam
  remains fragile.
- **Build-only path alias to a generated snapshot.** Redirect the import via a build-only
  type-checker config. Cons: the bun compiler and the bundler/typecheck would need
  _different_ alias targets from one shared config — a dual-target conflict with no clean
  per-invocation override in the current bun release.
- **Embed snapshot outside the source tree + `onResolve` redirect (chosen).** Keep a permanent
  committed empty stub in the source tree; generate the real embed once to a generated
  snapshot outside it; the Bun compile path redirects the stub import to that snapshot via a
  `Bun.build` `onResolve` plugin. Pros: the import statement, the bundler, dev, and typecheck
  are untouched; the per-target compile passes are pure readers, so parallelism is race-free
  by construction and the working tree stays clean. Cons: the compile path moves from the
  `bun build` CLI to the `Bun.build` JS API (validated to support `--compile` + cross-target
  - plugins).

## Decision

Adopt a thin **release orchestration** layer with an explicit, race-free phase order:

- **Phase0** web build — once, platform-agnostic.
- **Phase1** generate the embed snapshot — once, writes the generated snapshot (gitignored)
  outside the source tree.
- **Phase2** `bun --compile` fan-out — once per target, in **parallel**, each a pure reader
  of the Phase1 snapshot via an `onResolve` redirect.

A single reusable compile primitive (parameterized by target, output file, embed path, and
hardening) is the only compile path; both the native quick build and the multi-platform
release build route through it — no second compile path. The first-pass matrix is
macOS-arm64 + Linux-x64-glibc; `--bytecode` is never enabled (oven-sh/bun#18416 cross-compile
segfault), `--minify` stays on. CI and local share the same scripts. Distribution trust
concerns — version source of truth, channels, hardening tiers, signing/notarization, publish
— are seams (placeholders) filled by later release waves.

## Consequences

- **Easier:** multi-platform builds are one command (`pnpm release:build`), parallel, and
  leave the working tree clean; later trust work has named seams to extend.
- **Harder:** the compile path now depends on the `Bun.build` JS API rather than the CLI;
  cross-compiling a target downloads that target's bun runtime on first use.
- ADR-0003's "reset the embed module to a stub after each build" mechanism is **superseded**
  by the committed-stub + generated-snapshot + redirect design (see the pointer added to 0003).
- `pnpm build` (the CJS bundle) and the Node CJS filesystem fallback are unchanged.
- The named seams paid off: step 3 hung the **distribution-trust signing chain** (SHA256SUMS
  - minisign Ed25519 + macOS ad-hoc codesign + embedded-key `c3 verify` + notes/publish
    orchestration) off the manifest + compile primitive with no structural change. Trust =
    the signing chain; obfuscation is an explicit non-goal (security.md). See
    `doc/non-functional/release.md` "Distribution trust".

## Compliance

- A release orchestrator drives the phased multi-platform build (`--targets`, `--dry-run`).
- All compilation routes through the single reusable compile primitive.
- A snapshot generator writes the generated embed snapshot outside the source tree.
- The in-tree embed stub stays committed and is never written by the release path.
- A smoke/unit gate covers the release build.

## References

- [ADR-0003](0003-single-binary-via-bun-compile.md) — single binary via `bun build --compile` (evolved by this ADR)
- `doc/non-functional/release.md`
- oven-sh/bun#18416 — cross-compile + `--bytecode` segfault
