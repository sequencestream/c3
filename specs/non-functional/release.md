# Non-Functional — Release & Distribution

> **Status:** skeleton (release 1/7). The orchestration layer and the P0 two-platform
> matrix are live; later waves (signing, publish, version injection, hardening, extra
> platforms) fill in the placeholders below. Source of truth — keep in sync with
> `scripts/release/` and `server/scripts/release/`.

`release` is a thin **orchestration** layer over the existing build/binary primitives.
It does not replace `pnpm build` (esbuild CJS bundle) or `pnpm binary` (single native
executable); it sequences and fans them out for multi-platform output. See
[ADR-0010](../architecture/adr/0010-release-and-distribution-trust.md) and
[ADR-0003](../architecture/adr/0003-single-binary-via-bun-compile.md).

## Phase order (quality gate order)

The build runs in strict, race-free phases. Phase0/1 happen exactly once; Phase2 fans
out and is a pure reader, so N targets never write a shared file (the old race root).

| Phase  | Step                    | Cardinality                   | Writes                                            |
| ------ | ----------------------- | ----------------------------- | ------------------------------------------------- |
| Phase0 | web build               | once, platform-agnostic       | `web/dist/**`                                     |
| Phase1 | generate-static-embed   | once                          | `dist/static-embed.generated.ts` (gitignored)     |
| Phase2 | `bun --compile` fan-out | once per target, **parallel** | `dist/c3-<os>-<arch>` (read-only on the snapshot) |

`static-embed` lives **outside `src/`**: `server/src/static-embed.ts` is a permanent
committed empty stub (esbuild/dev/typecheck consume it); the Bun compile path redirects
that import to the Phase1 snapshot via an `onResolve` plugin. This is what keeps the
working tree clean across parallel targets.

Quality-gate ordering beyond build (typecheck / lint / tests / smoke) is a later-wave
placeholder; today the smoke gate is `scripts/release/release-build.test.mjs`.

## Platform waves

| Wave   | Target                              | bun target         | bytecode | minify | Status      |
| ------ | ----------------------------------- | ------------------ | -------- | ------ | ----------- |
| **P0** | macOS-arm64                         | `bun-darwin-arm64` | ✗        | ✓      | live        |
| **P0** | Linux-x64-glibc                     | `bun-linux-x64`    | ✗        | ✓      | live        |
| later  | Linux-arm64, x64-mac, musl, Windows | _tbd_              | _tbd_    | _tbd_  | placeholder |

**`--bytecode` is never enabled** for cross-compiled targets — it segfaults
(oven-sh/bun#18416). P0 keeps it off uniformly; `--minify` is always on. CI and local
share the same scripts.

## Artifact naming

`dist/c3-<os>-<arch>` (e.g. `c3-macos-arm64`, `c3-linux-x64`). `darwin` is normalized to
`macos`. Channel/suffix conventions (e.g. `-nightly`, version stamping) are placeholders
for a later wave.

## Version SoT (placeholder)

The version is currently read from the package manifest (`--version` → `0.1.0`). A single
**version source-of-truth** and build-time injection (git tag / channel) is a later-wave
decision; not yet implemented.

## Hardening tiers (placeholder)

`build-target.mjs` accepts a `harden` parameter; P0 honors only the `default` tier and
warns on anything else. The tier ladder (stripped symbols, reproducible builds, signing,
notarization) is defined in a later wave.

## Commands

```bash
pnpm release:build                                  # P0 matrix, parallel, no publish
pnpm release:build --targets=linux-x64              # subset
pnpm release:build --dry-run                        # print the plan, execute nothing
pnpm binary                                          # native single binary (self-use quickcut)
```

## Entry points

- Orchestrator: `scripts/release/release-build.mjs`
- Single-target primitive: `server/scripts/release/build-target.mjs` (`buildTarget()`)
- Snapshot generator: `server/scripts/generate-static-embed.mjs`
- Smoke/unit: `scripts/release/release-build.test.mjs`
