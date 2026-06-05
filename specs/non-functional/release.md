# Non-Functional — Release & Distribution

> **Status:** release 2/7. Orchestration + P0 matrix (1/7) and version injection +
> manifest + harden-tier framework (2/7) are live; later waves (signing, publish, extra
> platforms) fill in the remaining placeholders. Source of truth — keep in sync with
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
(oven-sh/bun#18416). P0 keeps it off uniformly. `minify`/`sourcemap` are governed by the
harden tier (see below), not hard-coded. CI and local share the same scripts.

## Artifact naming

`dist/c3-<os>-<arch>` (e.g. `c3-macos-arm64`, `c3-linux-x64`). `darwin` is normalized to
`macos`. Channel/suffix conventions (e.g. `-nightly`, version stamping) are placeholders
for a later wave.

## Version SoT (release 2/7)

The version **source-of-truth is the git tag**, not a `package.json` bump — releases are
cut by tagging (`git describe --tags --abbrev=7`). `package.json` `version` is the
**fallback baseline**, kept in sync with the most recent tag; it is used only when no tag
is reachable (e.g. a fresh clone with zero tags, the state today).

The resolved version, the short commit (`git rev-parse --short=7`), and the build time
(ISO 8601) are injected at **compile time** via esbuild / Bun `define`
(`scripts/release/version-info.mjs` → `__C3_VERSION__` / `__C3_COMMIT__` /
`__C3_BUILD_TIME__`; consumed by `server/src/version.ts`). Both build chains inject the
same constants. The orchestrator computes them **once** and threads them to every target
so all artifacts (and the manifest) share one build time.

```text
$ c3 --version
0.1.0 (commit c58a0b5, built 2026-06-05T07:22:53.535Z)
```

The tsx dev path applies no `define` (≈ harden `none`); `version.ts` then falls back to
`0.0.0-dev` / `unknown` / `dev` via `typeof` guards.

## Hardening tiers (release 2/7)

`RELEASE_HARDEN` (env) or `--harden=` selects the tier; default **`basic`**. It governs
the **native binaries** (`pnpm release:build`, `pnpm binary`) only — the esbuild node
bundle (`dist/cli.cjs`, run by `pnpm start`) gets the version `define` but no harden.

| Tier              | minify | sourcemap | manifest | Notes                                                   |
| ----------------- | ------ | --------- | -------- | ------------------------------------------------------- |
| `none`            | ✗      | inline    | ✗        | dev/debug; the tsx dev path is `none` by nature         |
| `basic` (default) | ✓      | none      | ✓        | strip (Bun `minify` strips) + drop sourcemap + manifest |
| `standard`        | ✓      | none      | ✓        | **placeholder** — builds with `basic` behavior + warns  |

Motivation is **distribution trust ≫ obfuscation**: `basic` lands the trust floor
(traceable version + verifiable artifact manifest) before any obfuscation work.

### No spec entry, no standard tier

`standard` is a **spec-gated** placeholder. Until a dedicated spec entry defines its
actual hardening (symbol stripping beyond minify, reproducible builds, anti-tamper,
obfuscation, …), selecting it does **not** enable obfuscation: `build-target.mjs` warns
loudly and builds with `basic` behavior. The manifest records the **requested** tier
(`harden: "standard"`) verbatim. This requirement does not implement any obfuscation
logic.

## Manifest (release 2/7)

For `harden` ≠ `none`, `pnpm release:build` writes `dist/manifest.json` — a verify-now
distribution-trust record (signing is a later wave). `scripts/release/manifest.mjs`
(`schema: c3-release-manifest/v1`):

```json
{
  "schema": "c3-release-manifest/v1",
  "version": "0.1.0",
  "commit": "c58a0b5",
  "buildTime": "2026-06-05T07:22:53.535Z",
  "harden": "basic",
  "artifacts": [
    { "target": "macos-arm64", "file": "c3-macos-arm64", "bytes": 68300642, "sha256": "ed0a…2a11" }
  ]
}
```

A consumer can `shasum -a 256 c3-<os>-<arch>` and match `artifacts[].sha256`. The manifest
is a **multi-artifact** distribution record; `pnpm binary` (single self-use binary) does
not emit one.

## Commands

```bash
pnpm release:build                                  # P0 matrix, parallel, harden=basic, +manifest
pnpm release:build --targets=linux-x64              # subset
pnpm release:build --harden=none                    # no minify/manifest (debug)
RELEASE_HARDEN=standard pnpm release:build          # placeholder tier (warns, builds as basic)
pnpm release:build --dry-run                        # print the plan, execute nothing
pnpm binary                                          # native single binary (self-use quickcut)
```

## Entry points

- Orchestrator: `scripts/release/release-build.mjs` (`--targets`, `--harden`, `--dry-run`)
- Single-target primitive: `server/scripts/release/build-target.mjs` (`buildTarget()`, `HARDEN_TIERS`)
- Version SoT helper: `scripts/release/version-info.mjs` (`computeVersionInfo`, `versionDefines`)
- Manifest helper: `scripts/release/manifest.mjs` (`buildManifest`, `sha256File`)
- Runtime version: `server/src/version.ts` (`versionString`)
- Snapshot generator: `server/scripts/generate-static-embed.mjs`
- Smoke/unit: `scripts/release/release-build.test.mjs`, `scripts/release/release-harden.test.mjs`
