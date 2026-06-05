# Non-Functional — Release & Distribution

> **Status:** release 5/7. Orchestration + P0 matrix (1/7), version injection + manifest +
> harden-tier framework (2/7), distribution trust — SHA256SUMS + minisign + macOS ad-hoc +
> `c3 verify` (3/7), and **layered quality gates** — pre-build blocking gate + artifact-level
> headless smoke + publish final check (5/7) — are live; later waves (extra platforms, Apple
> Developer ID / notarization, Windows Authenticode, the GitHub Actions release workflow that
> consumes the gate order below) fill in the remaining placeholders. Source of truth — keep in
> sync with `scripts/release/` and `server/scripts/release/`.

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

Quality-gate ordering beyond build is specified in **Quality gates** below.

## Quality gates (release 5/7)

Three non-overlapping gate layers, ordered by cost so a cheap red never burns an
expensive stage. This ordering **is the spec for the CI release workflow** (a later
wave) — `scripts/release/release.mjs` implements the same sequence locally.

| #   | Gate                | Layer        | Runs                                                                      | On red                       |
| --- | ------------------- | ------------ | ------------------------------------------------------------------------- | ---------------------------- |
| 0   | **pregate**         | source       | `typecheck → lint → test → i18n:check → i18n:check-freeze` (strict order) | abort **before** any compile |
| 1   | **artifact gate**   | product      | per host-runnable target: `c3 --version` + headless smoke                 | fail the build               |
| —   | e2e (standard only) | product      | `pnpm e2e` — forced when `harden=standard`                                | fail the release             |
| 2   | **publish gate**    | distribution | manifest ↔ SHA256SUMS ↔ on-disk sha256 agree + **all P0 targets present** | abort **before** tag / `gh`  |

- **Pregate** (`release:gate`, `scripts/release/pregate.mjs`) runs first in `pnpm release`
  and fails fast: the first non-zero gate aborts, so a red typecheck never reaches the
  multi-platform `bun --compile`. `--skip-gate` opts out; `--dry-run` lists the plan.
- **Artifact gate** is `release-build.mjs` **Phase3** (`scripts/release/smoke.mjs`). The
  headless smoke starts the server on a **random free port** (`net` bind-0; the CLI rejects
  `--port 0`), HTTP-probes `/` until it answers, then kills it. It **never invokes claude** —
  a claude call would block CI forever (no interactive answerer), and a bare server boot
  touches claude only when a run launches. Cross-compiled binaries can't execute on a foreign
  host, so smoke runs **only on the host-runnable target** (`isHostRunnable`); CI smokes each
  platform on its own OS runner. `--skip-smoke` opts out. The smoke script **is** the test
  carrier; `release-smoke.test.mjs` covers the pure helpers (so `pnpm test` — itself the
  pregate — stays green before any artifact exists).
- **Publish gate** (`release:verify-dist`, `scripts/release/postgate.mjs`) runs inside
  `publish.mjs` after signing and before the tag: it re-hashes every artifact and checks the
  manifest, `SHA256SUMS`, and on-disk bytes all agree line-for-line, and that **every P0
  target is present** — a half-baked or drifted set blocks the release.

### Gate ownership: commit-increment vs release-full

| Gate                        | Scope                         | Trigger            | Owns                                       |
| --------------------------- | ----------------------------- | ------------------ | ------------------------------------------ |
| husky + lint-staged         | **staged files only** (delta) | every `git commit` | `eslint --fix` + `prettier` + `i18n:check` |
| `ci.yml`                    | whole tree                    | every push / PR    | `typecheck` + `lint` + `i18n:check`        |
| **release pregate + gates** | whole tree + every artifact   | cutting a release  | the full table above                       |

husky/lint-staged guard the **commit increment**; the release gates guard the **full
distribution**. They deliberately don't overlap — `test` and `i18n:check-freeze` are
release-only (too heavy for every commit).

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

`release:build` output is **version-stamped**: `dist/c3-v{version}-<os>-<arch>{.exe?}` (e.g.
`c3-v0.2.0-macos-arm64`, `c3-v0.2.0-linux-x64`; Windows targets append `.exe`, forward-looking).
`darwin` is normalized to `macos`; the leading `v` is fixed and a `v`-prefixed version is not
doubled (`artifact-name.mjs`). `pnpm binary` (self-use quickcut) keeps the **un-versioned**
`dist/c3-<os>-<arch>`. Channel suffixes (e.g. `-nightly`) remain a later-wave placeholder.

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

## Distribution trust (release 3/7)

The trust floor is a **signing chain** (see security.md DIST-1/SEC-8). `release:sign` (and
`release:publish`) read `dist/manifest.json` and emit, per artifact, a `.sha256` and an
Ed25519 **minisign** `.minisig`, plus aggregate `SHA256SUMS`(`.minisig`). All sidecars cover
the **final** bytes (after macOS ad-hoc `codesign`, which runs inside the compile primitive so
hashing sees the signed Mach-O).

- **Keys.** Standard minisign format (`scripts/release/minisign.mjs`, pure `node:crypto`,
  interoperable with the official `minisign` CLI). The secret is a raw `keyId||seed` blob held
  offline / as the `C3_MINISIGN_SECRET_KEY` GitHub Secret; the public key is committed in
  `server/src/release-pubkey.ts` + README. `node scripts/release/keygen.mjs` mints a pair
  (public → stdout, secret → gitignored file). Prehashed (`ED`, BLAKE2b-512) signatures.
- **`c3 verify <file>`** (`server/src/verify.ts`) — offline self-check against the **embedded**
  public key; verifies the `.sha256` (if present) and the mandatory `.minisig`. No network, no
  external `minisign`. The signer (`.mjs`) and verifier (`.ts`) are cross-runtime twins, kept
  in lockstep by tests.
- **macOS ad-hoc** `codesign --force -s -` — gated on macOS target + darwin host + `codesign`
  present; best-effort with a warn-and-continue otherwise. Ad-hoc only (no Developer ID /
  notarization); users clear Gatekeeper quarantine with `xattr -dr com.apple.quarantine`.

`pnpm release` chains build → notes → publish. `--dry-run` rehearses every stage with no
external/irreversible effect (no signing, no tag, no `gh`); `--no-publish` signs locally but
stops before the tag + GitHub Release. The package stays `private: true` (binaries ship via
GitHub Releases, never npm).

## Commands

```bash
pnpm release:build                                  # P0 matrix, parallel, harden=basic, +manifest
pnpm release:build --targets=linux-x64              # subset
pnpm release:build --harden=none                    # no minify/manifest (debug)
RELEASE_HARDEN=standard pnpm release:build          # placeholder tier (warns, builds as basic)
pnpm release:build --dry-run                        # print the plan, execute nothing
pnpm release:sign                                    # SHA256SUMS + .sha256 + .minisig (reads manifest)
pnpm release:notes                                   # release notes (version + top CHANGELOG section)
pnpm release:gate                                    # pregate: typecheck→lint→test→i18n:check→check-freeze
pnpm release:smoke -- --file=dist/c3-…               # headless smoke one artifact (or read manifest if no --file)
pnpm release:verify-dist                              # publish final check: manifest↔SHA256SUMS↔disk + P0
pnpm release:publish --dry-run                        # rehearse publish: plan only, no tag/gh/sign
pnpm release --no-publish                             # gate + build + sign + notes, no GitHub Release
pnpm release --skip-gate                              # skip the source pregate (debug)
RELEASE_HARDEN=standard pnpm release                  # additionally forces `pnpm e2e`
pnpm release                                          # gate → build(+smoke) → notes → publish (full)
pnpm release:keygen                                   # mint a minisign keypair
pnpm binary                                          # native single binary (self-use quickcut)
```

## Entry points

- Build orchestrator: `scripts/release/release-build.mjs` (`--targets`, `--harden`, `--dry-run`, `--skip-smoke`; Phase3 smoke)
- Top-level orchestrator: `scripts/release/release.mjs` (`--dry-run`, `--no-publish`, `--skip-gate`, passthrough; pregate + e2e on standard)
- Target SoT: `scripts/release/targets.mjs` (`P0_TARGETS`, `KNOWN_TARGETS`, `hostTarget`, `isHostRunnable`)
- Pregate (source gate): `scripts/release/pregate.mjs` (`GATES`, `runPregate`)
- Artifact smoke: `scripts/release/smoke.mjs` (`smokeArtifact`, `smokeBuiltArtifacts`, `assertVersionOutput`, `freePort`)
- Publish final check: `scripts/release/postgate.mjs` (`verifyDist`, `parseSha256Sums`)
- Single-target primitive: `server/scripts/release/build-target.mjs` (`buildTarget()`, `HARDEN_TIERS`, ad-hoc codesign)
- Version SoT helper: `scripts/release/version-info.mjs` (`computeVersionInfo`, `versionDefines`)
- Manifest helper: `scripts/release/manifest.mjs` (`buildManifest`, `sha256File`)
- Artifact naming: `scripts/release/artifact-name.mjs` (`artifactName`, `normalizeVersion`)
- minisign core: `scripts/release/minisign.mjs` (`generateKeypair`, `signContent`, `verifyContent`)
- Signing: `scripts/release/sign.mjs` (`signArtifacts`, `artifactsFromManifest`, `secretFromEnv`)
- Notes / publish / keygen: `scripts/release/notes.mjs` (`buildNotes`), `publish.mjs` (`publish`), `keygen.mjs`
- Embedded pubkey + verify: `server/src/release-pubkey.ts`, `server/src/verify.ts` (`verifyArtifact`, `runVerify`), CLI `c3 verify`
- Runtime version: `server/src/version.ts` (`versionString`)
- Snapshot generator: `server/scripts/generate-static-embed.mjs`
- Tests: `scripts/release/release-build.test.mjs`, `release-harden.test.mjs`, `release-sign.test.mjs` (the last cross-imports `server/src/verify.ts`, proving signer/verifier parity), `release-smoke.test.mjs` (artifact-gate helpers + conditional real smoke)
