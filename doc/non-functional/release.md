# Non-Functional — Release & Distribution

> **Status:** release 8/7 + 7/7 + 6/7 + 5/7 + 4/7. Orchestration + P0 matrix (1/7), version injection
>
> - manifest + harden-tier framework (2/7), distribution trust — SHA256SUMS + minisign +
>   macOS ad-hoc + `c3 verify` (3/7), **layered quality gates** — pre-build blocking gate +
>   artifact-level headless smoke + publish final check (5/7), the **P1 platform wave +
>   Windows branches** — macOS-x64 + Windows-x64 in the matrix, Windows platform code paths
>   (4/7), the **GH Actions native matrix** — workflow with `needs:` chain physically enforcing
>   the five-layer gate order, macOS ad-hoc codesign runs on darwin runners for real, SLSA provenance
>   (P1) via OIDC keyless, `macos-x64` promoted from P1 to P0 (6/7), the **standard
>   obfuscation tier (7/7)** — `javascript-obfuscator` with string-array + identifier rename,
>   e2e/smoke as logic-regression hard evidence, graceful fallback to bare compile on failure,
>   manifest `v1.1` per-artifact `obfuscation.applied` field, source maps local-only — and
>   the **binary → package split (8/7)** — the binary is always `c3` (or `c3.exe` on
>   Windows); version + platform info live ONLY in the package filename
>   (`c3-v{version}-{target}{.tar.gz|.zip}`); manifest `v1.2` adds `binary` + `binarySha256`
>   per artifact — are live. macOS notarization (Developer ID + notarytool) and Windows
>   Authenticode (signtool + PFX) are deferred to a later wave — they need real
>   certificates in GitHub Secrets, which we don't have yet.

`release` is a thin **orchestration** layer over the existing build/binary primitives.
It does not replace `pnpm build` (the bundled web-plus-server output) or `pnpm binary`
(single native executable); it sequences and fans them out for multi-platform output. See
[ADR-0010](../architecture/adr/0010-release-and-distribution-trust.md) and
[ADR-0003](../architecture/adr/0003-single-binary-via-bun-compile.md).

## Distribution contract — the single binary is NOT self-contained (ADR-0012)

The `c3` single binary ships c3 itself plus the installer/resolver logic for vendor CLIs. Default
agent execution uses c3-managed vendor installs under `~/.c3/vendor/<vendor>/<version>/bin/<binary>`.
The release docs must make this contract explicit:

- **Resolution priority is fixed.** `CLAUDE_PATH` / `CODEX_PATH` wins, then c3 managed CLI, then
  degraded host PATH fallback.
- **Managed installs are verified and stateful.** c3 reads npm packuments, downloads tarballs,
  verifies `dist.integrity`, stages/self-checks the binary, and records source/version/error state in
  `~/.c3/vendor/manifest.json`.
- **Fallback is not success.** If managed install or sync fails but host PATH contains a usable CLI,
  the agent can run in `host-path-fallback` state; logs must retain the managed failure reason.
- **Credentials are outside c3.** c3 never writes or migrates `~/.claude`, `~/.codex`, tokens, shell
  profiles, package-manager installs, or PATH.

This is the distribution-facing face of ADR-0012 (vendor executable resolution is the first
capability gate).

## Phase order (quality gate order)

The build runs in strict, race-free phases. Phase0/1 happen exactly once; Phase2 fans
out and is a pure reader, so N targets never write a shared file (the old race root).

| Phase    | Step                    | Cardinality                              | Produces                                                                                                                   |
| -------- | ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase0   | web build               | once, platform-agnostic                  | the compiled web bundle                                                                                                    |
| Phase1   | generate-static-embed   | once                                     | a one-off snapshot of the web bundle, embeddable into the binary (gitignored, not committed)                               |
| Phase2   | `bun --compile` fan-out | once per target, **parallel**            | the per-target `c3` binary in its own scratch area (read-only against the Phase1 snapshot)                                 |
| Phase2.5 | pack                    | once per target, **serial** after Phase2 | the distributable package `c3-v{ver}-{target}{.tar.gz\|.zip}` plus the binary's inner sha256 + minisig sidecars, tarred in |

The embeddable snapshot is kept **outside the committed source tree**: the source carries a
permanent empty stub the everyday bundle/dev/typecheck paths consume, while the Bun compile
path redirects that import to the Phase1 snapshot at build time. This is what keeps the
working tree clean across parallel targets.

Quality-gate ordering beyond build is specified in **Quality gates** below.

## Quality gates (release 5/7)

Three non-overlapping gate layers, ordered by cost so a cheap red never burns an
expensive stage. This ordering **is the spec for the CI release workflow** (a later
wave) — the local `pnpm release` orchestrator implements the same sequence.

| #   | Gate                | Layer        | Runs                                                                                               | On red                       |
| --- | ------------------- | ------------ | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| 0   | **pregate**         | source       | `typecheck → lint → test → i18n:check → i18n:check-freeze` (strict order)                          | abort **before** any compile |
| 1   | **artifact gate**   | product      | per host-runnable target: `c3 --version` + headless smoke                                          | fail the build               |
| —   | e2e (standard only) | product      | `pnpm e2e --obfuscated` — obfuscated server bundle as logic-regression hard evidence (release 7/7) | fail the release             |
| 2   | **publish gate**    | distribution | manifest ↔ SHA256SUMS ↔ on-disk sha256 agree + **all P0 targets present**                          | abort **before** tag / `gh`  |

- **Pregate** (`release:gate`) runs first in `pnpm release` and fails fast: the first
  non-zero gate aborts, so a red typecheck never reaches the multi-platform `bun --compile`.
  `--skip-gate` opts out; `--dry-run` lists the plan.
- **Artifact gate** is the build's **Phase3** smoke. The headless smoke starts the server on
  a **random free port** (OS-assigned bind-0; the CLI rejects `--port 0`), HTTP-probes `/`
  until it answers, then kills it. It **never invokes claude** — a claude call would block CI
  forever (no interactive answerer), and a bare server boot touches claude only when a run
  launches. Cross-compiled binaries can't execute on a foreign host, so smoke runs **only on
  the host-runnable target**; CI smokes each platform on its own OS runner. `--skip-smoke`
  opts out. The smoke routine **is** the test carrier; a companion unit test covers the pure
  helpers (so `pnpm test` — itself the pregate — stays green before any artifact exists).
- **Publish gate** (`release:verify-dist`) runs inside the publish step after signing and
  before the tag: it re-hashes every artifact and checks the manifest, `SHA256SUMS`, and
  on-disk bytes all agree line-for-line, and that **every P0 target is present** — a
  half-baked or drifted set blocks the release.

### Gate ownership: commit-increment vs release-full

| Gate                        | Scope                         | Trigger            | Owns                                       |
| --------------------------- | ----------------------------- | ------------------ | ------------------------------------------ |
| husky + lint-staged         | **staged files only** (delta) | every `git commit` | `eslint --fix` + `prettier` + `i18n:check` |
| CI on push/PR               | whole tree                    | every push / PR    | `typecheck` + `lint` + `i18n:check`        |
| **release pregate + gates** | whole tree + every artifact   | cutting a release  | the full table above                       |

husky/lint-staged guard the **commit increment**; the release gates guard the **full
distribution**. They deliberately don't overlap — `test` and `i18n:check-freeze` are
release-only (too heavy for every commit).

## CI: GH Actions native matrix (release 6/7)

The GH Actions release workflow executes the five-layer gate order on real
GH Actions runners and uses `needs:` to **physically** enforce phase sequencing — a red
upstream job skips every downstream job. This is what unlocks the macOS ad-hoc + SLSA
gains (see "SLSA provenance" below): each target is built on its **native OS runner**
(`ubuntu-latest` / `macos-14` / `macos-13` / `windows-latest`), so cross-compile is a
non-issue. (Bytecode would also have been a native-only gain, but it is disabled — see
"Bytecode — disabled" below.)

```text
setup (ubuntu-latest)
  └─ resolve targets (default: all 4) + version → outputs.{targets,version}
pregate (ubuntu-latest)
  └─ typecheck → lint → test → i18n:check → i18n:check-freeze
build:linux-x64      (ubuntu-latest)     needs: [pregate, setup]   if: contains(targets,'linux-x64')
build:macos-arm64    (macos-14)          needs: [pregate, setup]   if: contains(targets,'macos-arm64')
build:macos-x64      (macos-13)          needs: [pregate, setup]   if: contains(targets,'macos-x64')
build:windows-x64    (windows-latest)    needs: [pregate, setup]   if: contains(targets,'windows-x64')  ⚠️experimental
  └─ pnpm release:build --targets=<one> --skip-smoke --harden=standard   (env C3_RELEASE_VERSION=<version>, C3_OBFUSCATE_FAIL=abort)
  └─ ad-hoc codesign on darwin runners (no-op on linux/windows)
  └─ actions/upload-artifact@v4 → c3-<target>  (uploads the package sidecars, not the binary)
smoke:<target>       (same OS as build)  needs: [build:<target>]
  └─ pnpm release:smoke --file=<artifact>  (--version + headless HTTP probe)
verify-dist          (ubuntu-latest)     needs: [setup, smoke:{linux,macos-arm64,macos-x64,windows}-x64]
  └─ if: !cancelled()  (a deselected target is SKIPPED, not red — the publish gate is the real gate)
  └─ download artifacts (per-target subdirs, NO merge-multiple) → merge → publish gate
     (each build job emits its own manifest; merge-multiple would COLLIDE them so
      only one target survives — the merge folds the subdirs into one complete manifest +
      SHA256SUMS, then the publish gate checks manifest↔SHA256SUMS↔disk + required-target completeness)
provenance           (ubuntu-latest)     needs: [setup, verify-dist]   if: !cancelled() && !failure()
  └─ download all artifacts (merge-multiple OK — packages have unique names, no manifest needed)
  └─ actions/attest-build-provenance@v2 per SELECTED target (OIDC keyless; SLSA L3)
publish              (ubuntu-latest)     needs: [setup, provenance]    if: !cancelled() && !failure()
  └─ download artifacts (per-target subdirs) → merge (the publish step reads the merged manifest)
  └─ pnpm release:publish (sign + verify-dist re-check + tag + gh release)
```

Phase ordering guarantees from `needs:` + `if:`:

- A red `pregate` skips all four `build:` jobs (no cross-compile attempted on a red source tree).
- A **deselected** target (not in `setup.outputs.targets`) leaves its `build:`/`smoke:` jobs
  **skipped, not red**; `verify-dist` still runs (`if: !cancelled()`) and the publish gate enforces
  only the **selected** P0 subset, so the cut proceeds without that platform (the operator opted out).
- A red `build:<target>` for a **selected required** target ⇒ its artifact is absent from the
  re-aggregated artifact set ⇒ the publish gate aborts `verify-dist` on the missing required target.
- A red `verify-dist` ⇒ `failure()` ⇒ `provenance` and `publish` skip (no tag, no `gh`).
- A red `provenance` ⇒ `failure()` ⇒ `publish` skips.

The workflow runs on `workflow_dispatch` (manual release entry) and `push tags: 'v*'`
(re-publish re-verify). `workflow_dispatch` inputs:

- **`version`** — explicit release version, e.g. `v0.1.0`. Threaded to every build + publish
  job as `C3_RELEASE_VERSION` (overrides `git describe`; see "Version SoT"). Empty ⇒ derive
  from the git tag (the `push tags` path always leaves it empty).
- **`targets`** — comma-separated subset to build (default = all four:
  `linux-x64,macos-arm64,macos-x64,windows-x64`). Deselecting a **P0** target (e.g. drop
  `macos-x64` when Intel runners are starved) narrows the publish completeness gate to the
  selected set, so a partial-platform release can still be cut. Threaded to the publish gate /
  `verify-dist` as `C3_REQUIRED_TARGETS` (required set = `P0 ∩ selected`).
- **`skip_publish`** — stop at the sign+verify-dist step without cutting a tag or GitHub Release.

Local `pnpm release` and CI share the **same node scripts** (`release:build`,
`release:smoke`, `release:verify-dist`, `release:publish`) — the matrix is just a fan-out
carrier, not a second implementation.

## Bytecode — disabled (ESM/CJS incompatibility)

Bun `--bytecode` pre-compiles JS to bytecode, shaving a few hundred ms off cold start. It
is **disabled** on every target. Bun's bytecode path only accepts a **CommonJS** bundle,
but our staged bundle is **ESM**, so `bun --compile --bytecode` produces a binary that
aborts at startup with `TypeError: Expected CommonJS module to have a function wrapper`.

Bytecode is only a startup-time perf cache — it is **not** anti-tamper and gives no
anti-decompile value (the obfuscation tier is the protection layer). Rather than convert
the whole bundle to CJS (risking Zod method-dispatch breakage and obfuscation regressions),
we keep `--bytecode` off and accept the small cold-start cost. The per-target build log
prints `bytecode=off` to make this explicit.

> Note (release 6/7 history): the spec previously claimed bytecode auto-on for native host
> builds, but the flag was never actually injected into the compile command — a latent
> no-op. When it was finally wired in, it surfaced the ESM/CJS incompatibility above, so it
> was disabled deliberately.

## SLSA provenance — P1 (release 6/7)

The GH Actions release workflow has a `provenance` job (`needs: [verify-dist]`) that
runs `actions/attest-build-provenance@v2` once per artifact, using the runner's **OIDC
token** (`permissions: id-token: write`, `attestations: write`). The resulting
`.intoto.jsonl` SLSA L3 provenance attestations are uploaded to the GitHub Release
alongside the binaries and are verifiable offline with `gh attestation verify <file>`.

**Provenance is intentionally NOT in the `verify-dist` gate.** It is a parallel
"supply-chain transparency" artifact; the **minisign signing chain is the trust root**
(see "Distribution trust" below). This separation lets us add provenance without
tightening the trust floor or making OIDC outages a release-blocker — the chain still
completes if provenance generation fails (it just skips the attest step), and
`release:verify-dist` is unchanged.

Provenance is **P1** in the priority sense: it is generated and shipped, but the
project does not yet depend on downstream verifiers consuming it. Future waves can
tighten the gate by requiring attestation presence in `verify-dist`.

## Platform waves

| Wave   | Target               | bun target         | bytecode | minify | Status                    |
| ------ | -------------------- | ------------------ | -------- | ------ | ------------------------- |
| **P0** | macOS-arm64          | `bun-darwin-arm64` | off      | ✓      | live                      |
| **P0** | macOS-x64 (Intel)    | `bun-darwin-x64`   | off      | ✓      | live (promoted in 6/7)    |
| **P0** | Linux-x64-glibc      | `bun-linux-x64`    | off      | ✓      | live                      |
| **P1** | Windows-x64          | `bun-windows-x64`  | off      | ✓      | live — **⚠️experimental** |
| later  | Linux-arm64, musl, … | _tbd_              | _tbd_    | _tbd_  | placeholder               |

**`--bytecode`** is **off on every target** (ESM/CJS incompatibility — see "Bytecode —
disabled" above). `minify`/`sourcemap` are governed by the harden tier (see below), not
hard-coded. CI and local share the same scripts.

**P0 vs P1 (release 4/7, refined 6/7).** P0 is the **required** set — `release:build`
defaults to the full P0 matrix, and **publish gates on the selected P0 subset** (the publish
gate's required set = `P0 ∩ C3_REQUIRED_TARGETS`, defaulting to the full P0 when unset): a missing
_selected_ P0 target blocks the release, while a deliberately deselected P0 target (e.g.
`macos-x64` dropped when Intel runners are starved) drops out of the gate too — the operator
opted out. P1 (currently just `windows-x64`) is **best-effort**: the build orchestrator
warns and drops a failed experimental target instead of aborting, so
a Windows cross-compile hiccup can't sink the P0 cut. `macos-x64` was promoted from P1
to P0 in release 6/7 because the GH Actions native matrix runs it on a real
`macos-13` (Intel) runner and the headless smoke is green there. The friendly-name
SoT for the P0/P1/experimental classification is a single target-classification module.

### Windows: experimental until a real smoke (release 4/7)

The **Windows platform code paths** are merged ahead of any smoke (they're part of the P1 wave):

- **vendor CLI discovery** — default managed paths are under `%USERPROFILE%\.c3\vendor` on Windows
  and `~/.c3/vendor` on POSIX; host PATH lookup remains platform-specific fallback (`where` on
  Windows, `command -v` via `sh` on POSIX).
- **Home dir** — `~/.c3` resolves through the OS home-directory convention (→ `%USERPROFILE%\.c3`
  on Windows), never a raw `~`. Already true everywhere c3 reads its home; 4/7 only adds coverage.
- **`bun:sqlite` startup probe** — at server boot c3 opens an in-memory db + `SELECT 1`
  on the platform driver. A missing `bun:sqlite` on a Windows Bun binary now
  fails **loud** (`[c3] FATAL: SQLite driver "bun:sqlite" unavailable …`) instead of silently
  degrading to a persistence-less app. The app still boots (callers degrade), but loudly.
- **Build host** — the build orchestrator's Bun lookup also branches (`where bun` on win32) so a
  windows-latest runner can build + smoke.

**De-experimental gate (release 6/7 wired).** `windows-x64` stays in the experimental set
(its manifest entry carries `"experimental": true`, README marks it ⚠️) **until a real headless
smoke passes on a windows-latest runner** — its own OS, since cross-compiled binaries can't
be smoke-run on a foreign host. That smoke is wired by the GH Actions
release workflow (`smoke:windows-x64` job, `runs-on: windows-latest`); once that job is green,
dropping `windows-x64` from the experimental set is the one-line change that removes the
tag (it cascades: manifest entry loses `"experimental": true`, README loses ⚠️, the publish gate
keeps enforcing P0 completeness unchanged because the P1 set is empty either way).

## Artifact naming (release 8/7)

`release:build` produces TWO distinct outputs per target, by design:

- The **binary** is always named `c3` (or `c3.exe` on Windows), kept per target in its own
  internal scratch area. The version and platform info do **not** live in the binary
  filename — the binary is the consumer's `c3`, period. The per-target scratch areas are
  internal (one per native target so multiple platforms coexist in a multi-target build).
- The **package** is the distributable archive the GitHub Release ships:
  `c3-v{version}-{target}.tar.gz` for POSIX, `c3-v{version}-{target}.zip`
  for Windows. Inside the archive, the top-level files are `c3`, `c3.sha256`,
  `c3.minisig` (flat, no enclosing dir), so `tar -xzf … && ./c3 --version`
  works out of the box.

In the target token, `darwin`→`macos` and `win32`→`windows`; the leading `v` is fixed and a
`v`-prefixed version is not doubled.

`pnpm binary` (self-use quickcut) keeps the **un-versioned, un-packaged**
host-target `c3` and does not produce a package.

Channel suffixes (e.g. `-nightly`) remain a later-wave placeholder.

The naming rules (a single source of truth governs all of them):

- the in-package binary name is `c3` / `c3.exe`;
- the package filename is `c3-v{ver}-{target}{.tar.gz|.zip}`;
- the package extension is `.zip` on Windows, `.tar.gz` elsewhere.

## Version SoT (release 2/7)

The version **source-of-truth is the git tag**, not a `package.json` bump — releases are
cut by tagging (`git describe --tags --abbrev=7`). Version-resolution precedence:
an explicit **`C3_RELEASE_VERSION`** override (the CI `version` input, e.g. `v0.1.0`, with a
single leading `v` normalized off) wins; else the **git tag**; else the `package.json`
**fallback baseline**, kept in sync with the most recent tag and used only when no tag is
reachable (e.g. a fresh clone with zero tags). The override lets a `workflow_dispatch` run
stamp a chosen version before the tag exists — `release:publish` then cuts that exact tag.

The resolved version, the short commit (`git rev-parse --short=7`), and the build time
(ISO 8601) are injected at **compile time** as build-define constants via esbuild / Bun
`define`. Both build chains inject the same constants. The orchestrator computes them
**once** and threads them to every target so all artifacts (and the manifest) share one
build time.

```text
$ c3 --version
0.1.0 (commit c58a0b5, built 2026-06-05T07:22:53.535Z)
```

The dev path applies no `define` (≈ harden `none`); the version reporter then falls back to
`0.0.0-dev` / `unknown` / `dev` via runtime guards.

## Hardening tiers (release 2/7, obfuscation real in 7/7)

`RELEASE_HARDEN` (env) or `--harden=` selects the tier; the build primitive default is
**`basic`**, but the **CI release workflow pins `--harden=standard`** (with
`C3_OBFUSCATE_FAIL=abort`) — every published artifact is obfuscated. It governs
the **native binaries** (`pnpm release:build`, `pnpm binary`) only — the plain node bundle
run by `pnpm start` gets the version `define` but no harden.

| Tier              | minify | sourcemap | manifest                                        | Obfuscation                                                  | Notes                                                                                              |
| ----------------- | ------ | --------- | ----------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `none`            | ✗      | inline    | ✗                                               | —                                                            | dev/debug; the tsx dev path is `none` by nature                                                    |
| `basic` (default) | ✓      | none      | ✓ (`v1.1`)                                      | —                                                            | strip (Bun `minify` strips) + drop sourcemap + manifest                                            |
| `standard` (7/7)  | ✓      | none      | ✓ (`v1.1` + `obfuscation.applied` per artifact) | string-array + identifier rename via `javascript-obfuscator` | **CI release default**; fallback = bare compile, but CI pins `C3_OBFUSCATE_FAIL=abort` (hard-fail) |

Motivation is **distribution trust ≫ obfuscation**: `basic` lands the trust floor
(traceable version + verifiable artifact manifest) before any obfuscation work. The
`standard` tier is **opt-in, never default** — `RELEASE_HARDEN=standard` (or
`--harden=standard`) is required to enable it. Release 7/7 turns it from a
spec-gated placeholder into a real, opt-in implementation with hard evidence and
graceful fallback (see below).

### Standard tier (release 7/7) — `javascript-obfuscator`

`harden=standard` runs `javascript-obfuscator` between bundling and compiling — a
per-target intermediate staging bundle is string-array-encoded + identifier-renamed, then
`bun build --compile` produces the final native binary from that bundle.

**Locked option set** (a single locked, frozen configuration governs it):
`stringArray: true` + `stringArrayThreshold: 1.0` (ALL string literals hoisted into a
rotating shuffled array) + `identifierNamesGenerator: 'mangled'` + `renameGlobals: false`
(globals keep real names so bun runtime / Node builtins / dlsym lookups work) +
`sourceMap: true` + `sourceMapMode: 'separate'`. **NOT enabled** (see security.md
"Non-goal: hardening" for the full list + reasons): `controlFlowFlattening`,
`stringEncryption` full set, `transformObjectKeys`, `selfDefending`, `debugProtection`,
`numbersToExpressions`, `simplify`, `unicodeEscapeSequence`.

**Sourcemap sidecar** (release 7/7): a separate per-target source map is written for every
obfuscated artifact (gitignored, **local-only — never uploaded to GitHub Releases**). On-demand re-symbolication for the maintainer when triaging an issue;
not a release consumer artifact.

### Fallback behavior (release 7/7)

The build primitive's default fallback is **graceful**, but the **CI release workflow
pins `C3_OBFUSCATE_FAIL=abort`** so a published artifact is never silently downgraded to
a bare (un-obfuscated) bundle — obfuscation failure hard-fails that target's job.

Default (graceful) behavior, when `C3_OBFUSCATE_FAIL` is unset — any error (obfuscator
throws, timeout, the `C3_OBFUSCATE_FORCE_FAIL` test hook) leaves the bundle
**un-obfuscated** and the build keeps going; the trust floor (minify + signing chain) is
intact and the manifest records what actually shipped:

- `[build-target] WARN <target>: obfuscation failed (<err>) — falling back to bare compile`
- The artifact ships as the un-obfuscated minified bundle.
- The manifest stamps `obfuscation: { applied: false }` for that artifact (and
  `applied: true, durationMs: N` when it succeeded).
- Build exit code is **0** (release is NOT blocked).

`C3_OBFUSCATE_FAIL=abort` (CI default) flips this to a hard fail: obfuscation failure
refuses to ship and the build exits non-zero, so no bare-compile artifact reaches the store.

The e2e/smoke gates still run on the shipped artifact, so any logic regression
introduced by the obfuscator is caught at the artifact gate (smoke) or the standard
e2e path (full suite against the obfuscated server bundle).

### Volume / startup overhead baseline (release 7/7)

_(to be filled after the first standard-tier run on the GH Actions native matrix —
local numbers are noisy; CI numbers are the ones that count)_

| Target      | basic size | standard size | Δ     | basic `--version` (ms) | standard `--version` (ms) | Δ     |
| ----------- | ---------- | ------------- | ----- | ---------------------- | ------------------------- | ----- |
| macos-arm64 | _TBD_      | _TBD_         | _TBD_ | _TBD_                  | _TBD_                     | _TBD_ |
| macos-x64   | _TBD_      | _TBD_         | _TBD_ | _TBD_                  | _TBD_                     | _TBD_ |
| linux-x64   | _TBD_      | _TBD_         | _TBD_ | _TBD_                  | _TBD_                     | _TBD_ |
| windows-x64 | _TBD_      | _TBD_         | _TBD_ | _TBD_                  | _TBD_                     | _TBD_ |

The expected order of magnitude is **+10–30%** on size and **+5–15%** on startup
(string-array indirection is the dominant cost; identifier rename is mostly compile-time
and minified by the `minify: true` that ships with the standard tier).

## Manifest (release 2/7, v1.2 in release 8/7)

For `harden` ≠ `none`, `pnpm release:build` writes a distribution manifest — a verify-now
distribution-trust record (signing is a later wave). Its
`schema: c3-release-manifest/v1.2`:

```json
{
  "schema": "c3-release-manifest/v1.2",
  "version": "0.1.0",
  "commit": "c58a0b5",
  "buildTime": "2026-06-05T07:22:53.535Z",
  "harden": "basic",
  "artifacts": [
    {
      "target": "macos-arm64",
      "file": "c3-v0.1.0-macos-arm64.tar.gz",
      "binary": "c3",
      "binarySha256": "9b74c989…bac",
      "bytes": 25100384,
      "sha256": "ed0a…2a11"
    }
  ]
}
```

- `file` is the **package** name; `bytes` / `sha256` are the package's.
- `binary` is the in-package binary name (`c3` on POSIX, `c3.exe` on Windows).
- `binarySha256` is the hex of the **inner binary**, matching what
  `c3 verify <package>` reports for the inner-binary check.

A consumer can `shasum -a 256 c3-v{ver}-{target}{.tar.gz|.zip}` and match
`artifacts[].sha256`; the inner-binary `binarySha256` matches what
`c3 verify` reports when run on the extracted binary. The manifest
is a **multi-artifact** distribution record; `pnpm binary` (single self-use binary) does
not emit one. An experimental P1 artifact (release 4/7) additionally carries
`"experimental": true` on its entry (absent on P0/verified entries — schema stays `v1.2`).
The standard tier (release 7/7) adds the per-artifact `obfuscation: { applied, durationMs }`
block, preserved across the v1.2 rename.

## Distribution trust (release 3/7, two-layer in 8/7)

The trust floor is a **signing chain** (see security.md DIST-1/SEC-8). After release 8/7,
signing happens at **two distinct layers**:

- **Inner sidecars** (in the package, next to the `c3` binary): `c3.sha256` and
  `c3.minisig` — generated by the packaging step against the post-codesign binary bytes.
  `c3 verify c3` (after untar) checks the binary against these.
- **Outer sidecars** (alongside the package): `<package>.sha256` and
  `<package>.minisig` — generated by `release:sign` (and `release:publish`) over
  the package bytes. An aggregate `SHA256SUMS`(+`.minisig`) covers every package.

`release:sign` (and `release:publish`) read the distribution manifest and emit the
**outer** sidecars + aggregate `SHA256SUMS`(`.minisig`). All outer sidecars
cover the **final** bytes of the package (post tar/zip); the inner sidecars
cover the **final** bytes of the binary (after macOS ad-hoc `codesign`, which
runs inside the compile primitive so hashing sees the signed Mach-O).

- **Keys.** Standard minisign format (pure `node:crypto`, interoperable with the official
  `minisign` CLI). The secret is a raw `keyId||seed` blob held offline / as the
  `C3_MINISIGN_SECRET_KEY` GitHub Secret; the public key is embedded in the binary and
  published in the README. `pnpm release:keygen` mints a pair (public → stdout, secret →
  gitignored file). Prehashed (`ED`, BLAKE2b-512) signatures.
- **`c3 verify <file>`** — offline self-check against the **embedded** public key; verifies
  the `.sha256` (if present) and the mandatory `.minisig`. No network, no external `minisign`.
  The signer and the in-binary verifier are cross-runtime twins, kept in lockstep by tests.
- **`c3 upgrade`** — self-update reuses the same `verifyArtifact` + embedded key over the
  **outer** package sidecars: it downloads `<package>` + `<package>.minisig` + `<package>.sha256`
  and verifies the package bytes **before unpacking**, then unpacks the inner `c3`/`c3.exe` and
  atomically replaces the running binary (Windows: `.exe.old` placeholder swap). minisign stays
  the mandatory gate; a failure aborts with the old binary intact. upgrade never restarts a
  running c3 — `c3 restart` re-reads the service unit / relaunches the `--daemon` to load the
  new version. The platform→target mapping and package naming are a small in-binary copy of
  `scripts/release/{targets,artifact-name}.mjs` (that dir is not bundled), cross-asserted by a
  test so the two cannot drift.
- **macOS ad-hoc** `codesign --force -s -` — gated on macOS target + darwin host + `codesign`
  present; best-effort with a warn-and-continue otherwise. Ad-hoc only (no Developer ID /
  notarization); users clear Gatekeeper quarantine with `xattr -dr com.apple.quarantine`.

`pnpm release` chains build → notes → publish. `--dry-run` rehearses every stage with no
external/irreversible effect (no signing, no tag, no `gh`); `--no-publish` signs locally but
stops before the tag + GitHub Release. The package stays unpublished to npm (binaries ship via
GitHub Releases, never npm).

## Public-mirror publish (private source → public binaries)

The source repo (`sequencestream/code-creative-center`) is **private**, but the signed binaries
ship from a **public** distribution repo (`sequencestream/c3`). CI builds the artifacts in the
private repo; the binaries are then signed locally and published to the public mirror by an
operator who holds the minisign secret key:

1. **Download** a CI run's per-target artifacts to the local machine (one subdir per target,
   each holding that target's package + its manifest).
2. `pnpm publish:binaries [<version>]` — on the trusted local machine:
   - **merge** the per-target subdirs into one flat set (reuses the same merge step as CI),
   - **sign** every package with the secret key (same byte-identical outer sidecars
     as `release:publish`; default key source is a local key file, overridable via
     `C3_MINISIGN_SECRET_KEY[_FILE]`), write a shippable `minisign.pub`, and self-verify one
     signature against it,
   - **verify-dist** (the publish gate) — manifest ↔ SHA256SUMS ↔ on-disk; required-target set is
     narrowed to what was downloaded (build/CI already gated P0 completeness), missing P0 logged,
   - **bootstrap** the public repo's default branch with one README commit if it is still empty
     (outward-facing — confirmed before push, skip with `--yes`),
   - **`gh release create`** on the **public** repo (`--repo`, default `$C3_PUBLISH_REPO` or
     `sequencestream/c3`) with every artifact + sidecar + `SHA256SUMS`(`.minisig`) + `minisign.pub`.

`--dry-run` prints the full plan (version, key id, targets, bootstrap-needed, create-vs-clobber)
and touches nothing — no merge, sign, commit, or `gh`. `--clobber` re-uploads assets to an
existing tag; `--allow-unsigned` (not recommended) ships hashes without `.minisig`. This flow is
distinct from CI's `release:publish`, which cuts the Release **in the private source repo**.

## Commands

```bash
pnpm release:build                                  # P0 matrix, parallel, harden=basic, +manifest (bytecode off)
pnpm release:build --targets=linux-x64              # subset
pnpm release:build --harden=none                    # no minify/manifest (debug)
pnpm release:build --harden=standard                # standard tier (release 7/7): bundle → javascript-obfuscator → compile
RELEASE_HARDEN=standard pnpm release:build          #   (env form, equivalent); string-array + identifier rename; fallback = bare compile on failure
pnpm release:build --dry-run                        # print the plan, execute nothing
pnpm release:sign                                    # SHA256SUMS + .sha256 + .minisig (reads manifest)
pnpm release:notes                                   # release notes (version + top CHANGELOG section)
pnpm release:gate                                    # pregate: typecheck→lint→test→i18n:check→check-freeze
pnpm release:smoke -- --file=<inner-binary>        # headless smoke the inner BINARY (extract tarball first in CI)
pnpm release:smoke -- --manifest=<manifest>        # or: pick the inner binary from the package via the manifest
pnpm release:verify-dist                              # publish final check: manifest↔SHA256SUMS↔disk + P0
pnpm release:publish --dry-run                        # rehearse publish: plan only, no tag/gh/sign
pnpm release --no-publish                             # gate + build + sign + notes, no GitHub Release
pnpm release --skip-gate                              # skip the source pregate (debug)
RELEASE_HARDEN=standard pnpm release                  # additionally forces `pnpm e2e --obfuscated` (release 7/7)
pnpm e2e --obfuscated                                 # e2e against the obfuscated server bundle (requires standard build first)
pnpm release                                          # gate → build(+smoke) → notes → publish (full)
pnpm release:keygen                                   # mint a minisign keypair
pnpm binary                                          # native single binary (self-use quickcut, bytecode off)
# Public mirror (private source → public binaries):
# (first download a CI run's per-target artifacts to the local machine)
pnpm publish:binaries --dry-run                        # rehearse public-mirror publish: plan only, no merge/sign/commit/gh
pnpm publish:binaries [<version>]                      # sign locally + cut a GitHub Release on sequencestream/c3
pnpm publish:binaries --repo=owner/name --clobber      # override target repo / re-upload to an existing tag
# CI:
#   GH Actions release workflow  →  workflow_dispatch (manual) or push tags: v*
```

## Responsibilities (capabilities, not files)

The release machinery decomposes into these responsibilities — described by what they do, not by
where they live:

- **Build orchestrator** — fans the per-target build out across the P0 matrix (`--targets`,
  `--harden`, `--dry-run`, `--skip-smoke`), and carries the Phase3 artifact smoke.
- **Top-level orchestrator** — chains gate → build → notes → publish (`--dry-run`,
  `--no-publish`, `--skip-gate`), and forces the obfuscated e2e on the standard tier.
- **Target classification** — the single source of truth for the P0 / P1 / experimental /
  known / default target sets, host-target detection, and host-runnable detection.
- **Platform branches** — the `claude`-discovery and SQLite-driver-probe branches per OS, and
  the per-target build matrix (incl. the P1 + Windows `.exe` cases).
- **Pregate** — the strict-ordered source gate.
- **Artifact smoke** — the headless artifact gate plus its free-port / version-assertion helpers.
- **Publish gate** — the final manifest ↔ `SHA256SUMS` ↔ disk + required-target check.
- **Single-target build primitive** — bundle → (obfuscate) → compile, the harden tiers
  (bytecode disabled — ESM/CJS), and ad-hoc codesign.
- **Standard-tier obfuscation** — the staged obfuscation pass, the enable check, the fallback
  decision, and the locked (no-aggressive-options) configuration.
- **Version source of truth** — version/commit/build-time resolution and the build-define values.
- **Manifest** — building the distribution manifest and per-artifact hashing.
- **Artifact naming** — the binary name, package name, package extension, and version normalization.
- **Packaging** — inner sidecars + the `.tar.gz` / `.zip` archive.
- **minisign core, signing, notes, publish, keygen** — the signing primitives and the
  notes/publish/keygen steps.
- **Public-mirror publish** — pull CI artifacts, then merge → sign → verify-dist → bootstrap →
  `gh release` on the public repo.
- **Embedded pubkey + verify** — the in-binary public key and the offline `c3 verify` self-check.
- **Runtime version** — the version string the binary reports.
- **Snapshot generator** — produces the embeddable web-bundle snapshot.
- **CI release workflow** — the matrix `pregate → 4 build → 4 smoke → verify-dist → provenance →
publish` with `needs:` enforcing order.
- **Tests** — cover the build, harden, signing (proving signer/verifier parity), smoke
  (artifact-gate helpers + conditional real smoke), and obfuscation (helper, NOT-doing option
  set, fallback decision, manifest obfuscation block, publish-gate tolerance) behaviors.
