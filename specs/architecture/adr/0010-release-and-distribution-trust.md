# 0010 — Release & distribution trust

- **Status:** accepted
- **Date:** 2026-06-05

## Context

ADR-0003 established the single-binary build via `bun build --compile`, driven by
`server/scripts/pkg.mjs`. That driver builds **one** target and, in a `finally`, rewrites
`server/src/static-embed.ts` back to an empty stub so esbuild and the working tree stay
clean. Two structural problems block multi-platform distribution:

1. **Parallel race.** Every target generates and then resets the same shared file
   (`src/static-embed.ts`). Two targets building concurrently stomp each other and leave
   the working tree dirty.
2. **No orchestration.** There is no first-class "build all platforms" entry point, no
   target matrix, and no place to hang later distribution concerns (signing, version
   injection, channels, hardening).

This is the first of a 7-step release effort. Step 1 is the **orchestration skeleton**:
make multi-platform builds race-free and add the seams for later trust work — without
replacing the proven `build` / `binary` primitives.

## Options considered

- **Phase-gate the existing in-`src/` file (single write + single reset).** Generate the
  real embed once, reset once after all targets. Pros: keeps the `bun build --compile`
  CLI; minimal churn. Cons: the artifact still transits `src/` (briefly dirty mid-build);
  does not satisfy the "embed leaves `src/`" goal; the shared-file seam remains fragile.
- **tsconfig `paths` alias to a `dist/` snapshot.** Redirect the import via a build-only
  tsconfig. Cons: bun and esbuild/typecheck would need _different_ alias targets from one
  shared config — a dual-target conflict with no clean per-invocation override in bun 1.3.
- **Embed snapshot outside `src/` + `onResolve` redirect (chosen).** Keep a permanent
  committed empty stub at `src/static-embed.ts`; generate the real embed once to
  `dist/static-embed.generated.ts`; the Bun compile path redirects the stub import to that
  snapshot via a `Bun.build` `onResolve` plugin. Pros: the import statement, esbuild, dev,
  and typecheck are untouched; Phase2 targets are pure readers, so parallelism is race-free
  by construction and the working tree stays clean. Cons: the compile path moves from the
  `bun build` CLI to the `Bun.build` JS API (validated to support `compile` + cross-target
  - plugins).

## Decision

Adopt a thin **release orchestration** layer with an explicit, race-free phase order:

- **Phase0** web build — once, platform-agnostic.
- **Phase1** generate-static-embed — once, writes `dist/static-embed.generated.ts`
  (gitignored), outside `src/`.
- **Phase2** `bun --compile` fan-out — once per target, in **parallel**, each a pure reader
  of the Phase1 snapshot via an `onResolve` redirect.

`server/scripts/release/build-target.mjs` is the single reusable compile primitive
(`buildTarget({ target, outfile, embedPath, harden })`); both `pnpm binary` (native
quickcut) and `pnpm release:build` (multi-platform) route through it — no second compile
path. The P0 matrix is macOS-arm64 + Linux-x64-glibc; `--bytecode` is never enabled
(oven-sh/bun#18416 cross-compile segfault), `--minify` stays on. CI and local share the
same scripts. Distribution trust concerns — version SoT, channels, hardening tiers,
signing/notarization, publish — are seams (placeholders) filled by later release waves.

## Consequences

- **Easier:** multi-platform builds are one command (`pnpm release:build`), parallel, and
  leave the working tree clean; later trust work has named seams to extend.
- **Harder:** the compile path now depends on the `Bun.build` JS API rather than the CLI;
  cross-compiling a target downloads that target's bun runtime on first use.
- ADR-0003's "reset `static-embed.ts` to a stub after each build" mechanism is **superseded**
  by the committed-stub + dist-snapshot + redirect design (see the pointer added to 0003).
- `pnpm build` (esbuild CJS) and `node cli.cjs start` filesystem fallback are unchanged.

## Compliance

- Orchestrator: `scripts/release/release-build.mjs` (`--targets`, `--dry-run`).
- Compile primitive: `server/scripts/release/build-target.mjs`.
- Snapshot generator: `server/scripts/generate-static-embed.mjs` → `dist/static-embed.generated.ts`.
- Committed stub: `server/src/static-embed.ts` (never written by the release path).
- Smoke/unit gate: `scripts/release/release-build.test.mjs`.

## References

- [ADR-0003](0003-single-binary-via-bun-compile.md) — single binary via `bun build --compile` (evolved by this ADR)
- `specs/non-functional/release.md`
- oven-sh/bun#18416 — cross-compile + `--bytecode` segfault
