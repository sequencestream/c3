# Non-Functional — Release & Distribution

> **Status:** release 7/7 + 6/7 + 5/7 + 4/7. Orchestration + P0 matrix (1/7), version injection
>
> - manifest + harden-tier framework (2/7), distribution trust — SHA256SUMS + minisign +
>   macOS ad-hoc + `c3 verify` (3/7), **layered quality gates** — pre-build blocking gate +
>   artifact-level headless smoke + publish final check (5/7), the **P1 platform wave +
>   Windows branches** — macOS-x64 + Windows-x64 in the matrix, Windows platform code paths
>   (4/7), the **GH Actions native matrix** — workflow with `needs:` chain physically enforcing
>   the five-layer gate order, bytecode auto-on for native host builds (cross-compile kept off,
>   oven-sh/bun#18416), macOS ad-hoc codesign runs on darwin runners for real, SLSA provenance
>   (P1) via OIDC keyless, `macos-x64` promoted from P1 to P0 (6/7) — and the **standard
>   obfuscation tier (7/7)** — `javascript-obfuscator` with string-array + identifier rename,
>   e2e/smoke as logic-regression hard evidence, graceful fallback to bare compile on failure,
>   manifest `v1.1` per-artifact `obfuscation.applied` field, source maps local-only — are
>   live. macOS notarization (Developer ID + notarytool) and Windows Authenticode
>   (signtool + PFX) are deferred to **release 8/7** — they need real certificates in
>   GitHub Secrets, which we don't have yet. Source of truth — keep in sync with
>   `scripts/release/`, `server/scripts/release/`, and `.github/workflows/release.yml`.

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

| #   | Gate                | Layer        | Runs                                                                                               | On red                       |
| --- | ------------------- | ------------ | -------------------------------------------------------------------------------------------------- | ---------------------------- |
| 0   | **pregate**         | source       | `typecheck → lint → test → i18n:check → i18n:check-freeze` (strict order)                          | abort **before** any compile |
| 1   | **artifact gate**   | product      | per host-runnable target: `c3 --version` + headless smoke                                          | fail the build               |
| —   | e2e (standard only) | product      | `pnpm e2e --obfuscated` — obfuscated server bundle as logic-regression hard evidence (release 7/7) | fail the release             |
| 2   | **publish gate**    | distribution | manifest ↔ SHA256SUMS ↔ on-disk sha256 agree + **all P0 targets present**                          | abort **before** tag / `gh`  |

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

## CI: GH Actions native matrix (release 6/7)

The `.github/workflows/release.yml` workflow executes the five-layer gate order on real
GH Actions runners and uses `needs:` to **physically** enforce phase sequencing — a red
upstream job skips every downstream job. This is what unlocks the bytecodes + macOS
ad-hoc + SLSA gains (see "Bytecode on native" and "SLSA provenance" below): each target
is built on its **native OS runner** (`ubuntu-latest` / `macos-14` / `macos-13` /
`windows-latest`), so cross-compile is a non-issue and bytecode auto-turns on.

```text
pregate (ubuntu-latest)
  └─ typecheck → lint → test → i18n:check → i18n:check-freeze
build:linux-x64      (ubuntu-latest)     needs: [pregate]
build:macos-arm64    (macos-14)          needs: [pregate]
build:macos-x64      (macos-13)          needs: [pregate]
build:windows-x64    (windows-latest)    needs: [pregate]    ⚠️experimental
  └─ pnpm release:build --targets=<one> --skip-smoke --harden=basic
  └─ ad-hoc codesign on darwin runners (no-op on linux/windows)
  └─ actions/upload-artifact@v4 → c3-<target>
smoke:<target>       (same OS as build)  needs: [build:<target>]
  └─ pnpm release:smoke --file=<artifact>  (--version + headless HTTP probe)
verify-dist          (ubuntu-latest)     needs: [smoke:linux-x64, smoke:macos-arm64,
                                                        smoke:macos-x64, smoke:windows-x64]
  └─ download all 4 artifacts → postgate (manifest↔SHA256SUMS↔disk + P0)
provenance           (ubuntu-latest)     needs: [verify-dist]
  └─ actions/attest-build-provenance@v2 × 4 (OIDC keyless; SLSA L3)
publish              (ubuntu-latest)     needs: [provenance]
  └─ pnpm release:publish (sign + verify-dist re-check + tag + gh release)
```

Phase ordering guarantees from `needs:`:

- A red `pregate` skips all four `build:` jobs (no cross-compile attempted on a red source tree).
- A red `build:<target>` skips its matching `smoke:<target>`, which transitively skips `verify-dist`.
- A red `verify-dist` skips `provenance` and `publish` (no tag, no `gh`).
- A red `provenance` skips `publish`.

The workflow runs on `workflow_dispatch` (manual release entry) and `push tags: 'v*'`
(re-publish re-verify). `workflow_dispatch` has an optional `skip_publish` input that
stops at the sign+verify-dist step without cutting a tag or GitHub Release.

Local `pnpm release` and CI share the **same node scripts** (`release:build`,
`release:smoke`, `release:verify-dist`, `release:publish`) — the matrix is just a fan-out
carrier, not a second implementation.

## Bytecode on native (release 6/7)

Bun `--bytecode` (Bun.build `bytecode: true`) pre-compiles JS to bytecode, shaving a few
hundred ms off cold start and dropping memory peak. **It segfaults under cross-compile**
(oven-sh/bun#18416), so it has to be off whenever the bun target is not the host's. The
single gate is `isHostRunnable(friendly)` inside `buildTarget()`:

- `bytecode: true` when the target's host = the build host (native).
- `bytecode: false` otherwise (cross-compile safety belt, never the default-on path).

The GH Actions matrix puts each target on its native OS runner, so every CI build is
native and bytecode turns on automatically. The local `pnpm binary` quickcut also enables
it when the host matches the target. The `bytecode: true|false` line in the
`[build-target]` log makes the decision explicit per build.

## SLSA provenance — P1 (release 6/7)

`.github/workflows/release.yml` has a `provenance` job (`needs: [verify-dist]`) that
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
| **P0** | macOS-arm64          | `bun-darwin-arm64` | native ✓ | ✓      | live                      |
| **P0** | macOS-x64 (Intel)    | `bun-darwin-x64`   | native ✓ | ✓      | live (promoted in 6/7)    |
| **P0** | Linux-x64-glibc      | `bun-linux-x64`    | native ✓ | ✓      | live                      |
| **P1** | Windows-x64          | `bun-windows-x64`  | native ✓ | ✓      | live — **⚠️experimental** |
| later  | Linux-arm64, musl, … | _tbd_              | _tbd_    | _tbd_  | placeholder               |

**`--bytecode`** is **enabled on NATIVE host builds** (release 6/7). Cross-compile + bytecode
segfaults (oven-sh/bun#18416), so `buildTarget()` keeps the single gate
`bytecode: isHostRunnable(friendly)` — native → on, cross-compile → off. The matrix puts
every target on its native OS runner, so every job turns bytecode on automatically; the
local single-host `pnpm binary` quickcut also enables it when the host matches the target.
`minify`/`sourcemap` are governed by the harden tier (see below), not hard-coded. CI and
local share the same scripts.

**P0 vs P1 (release 4/7, refined 6/7).** P0 is the **required** set — `release:build`
defaults to the full P0 matrix, and **publish gates only on P0** (`postgate`): a missing
P0 target blocks the release. P1 (currently just `windows-x64`) is **best-effort**:
`release-build.mjs` warns and drops a failed experimental target instead of aborting, so
a Windows cross-compile hiccup can't sink the P0 cut. `macos-x64` was promoted from P1
to P0 in release 6/7 because the GH Actions native matrix runs it on a real
`macos-13` (Intel) runner and the headless smoke is green there. The friendly-name
SoT for P0/P1/experimental is `scripts/release/targets.mjs` (`P0_TARGETS`,
`P1_TARGETS`, `EXPERIMENTAL_TARGETS`, `isExperimental`).

### Windows: experimental until a real smoke (release 4/7)

The **Windows platform code paths** are merged ahead of any smoke (they're part of the P1 wave):

- **`claude` discovery** — `findClaudeExecutable` branches on platform (`claudeLookupCommand`):
  `where claude` on `win32` (no `sh` there), portable `sh -c command -v claude` on POSIX.
- **Home dir** — `~/.c3` resolves through `os.homedir()` (→ `%USERPROFILE%\.c3` on Windows),
  never a raw `~`. Already true repo-wide (`db.ts`, `kernel/config`); 4/7 only adds coverage.
- **`bun:sqlite` startup probe** — `checkDbDriver()` (db.ts) opens an in-memory db + `SELECT 1`
  on the platform driver at server boot. A missing `bun:sqlite` on a Windows Bun binary now
  fails **loud** (`[c3] FATAL: SQLite driver "bun:sqlite" unavailable …`) instead of silently
  degrading to a persistence-less app. The app still boots (callers degrade), but loudly.
- **Build host** — `release-build.mjs` `findBun` also branches (`where bun` on win32) so a
  windows-latest runner can build + smoke.

**De-experimental gate (release 6/7 wired).** `windows-x64` stays in `EXPERIMENTAL_TARGETS`
(its manifest entry carries `"experimental": true`, README marks it ⚠️) **until a real headless
smoke passes on a windows-latest runner** — its own OS, since cross-compiled binaries can't
be smoke-run on a foreign host (`isHostRunnable`). That smoke is wired by the GH Actions
release workflow (`smoke:windows-x64` job, `runs-on: windows-latest`); once that job is green,
removing `'windows-x64'` from `EXPERIMENTAL_TARGETS` is the one-line change that drops the
tag (it cascades: manifest entry loses `"experimental": true`, README loses ⚠️, postgate
keeps enforcing P0 completeness unchanged because the P1 set is empty either way).

## Artifact naming

`release:build` output is **version-stamped**: `dist/c3-v{version}-<os>-<arch>{.exe?}` (e.g.
`c3-v0.2.0-macos-arm64`, `c3-v0.2.0-linux-x64`; the P1 Windows target appends `.exe` →
`c3-v0.2.0-windows-x64.exe`). `darwin`→`macos` and `win32`→`windows`; the leading `v` is fixed and a `v`-prefixed version is not
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

## Hardening tiers (release 2/7, obfuscation real in 7/7)

`RELEASE_HARDEN` (env) or `--harden=` selects the tier; default **`basic`**. It governs
the **native binaries** (`pnpm release:build`, `pnpm binary`) only — the esbuild node
bundle (`dist/cli.cjs`, run by `pnpm start`) gets the version `define` but no harden.

| Tier              | minify | sourcemap | manifest                                        | Obfuscation                                                  | Notes                                                   |
| ----------------- | ------ | --------- | ----------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `none`            | ✗      | inline    | ✗                                               | —                                                            | dev/debug; the tsx dev path is `none` by nature         |
| `basic` (default) | ✓      | none      | ✓ (`v1.1`)                                      | —                                                            | strip (Bun `minify` strips) + drop sourcemap + manifest |
| `standard` (7/7)  | ✓      | none      | ✓ (`v1.1` + `obfuscation.applied` per artifact) | string-array + identifier rename via `javascript-obfuscator` | opt-in tier; fallback = bare compile on failure         |

Motivation is **distribution trust ≫ obfuscation**: `basic` lands the trust floor
(traceable version + verifiable artifact manifest) before any obfuscation work. The
`standard` tier is **opt-in, never default** — `RELEASE_HARDEN=standard` (or
`--harden=standard`) is required to enable it. Release 7/7 turns it from a
spec-gated placeholder into a real, opt-in implementation with hard evidence and
graceful fallback (see below).

### Standard tier (release 7/7) — `javascript-obfuscator`

`harden=standard` runs `javascript-obfuscator` between bundling and compiling — the
intermediate bundle in `dist/.obf-stage/<target>.js` is string-array-encoded + identifier-
renamed, then `bun build --compile` produces the final native binary from that bundle.

**Locked option set** (see `server/scripts/release/obfuscate.mjs` `OBFUSCATOR_OPTIONS`):
`stringArray: true` + `stringArrayThreshold: 1.0` (ALL string literals hoisted into a
rotating shuffled array) + `identifierNamesGenerator: 'mangled'` + `renameGlobals: false`
(globals keep real names so bun runtime / Node builtins / dlsym lookups work) +
`sourceMap: true` + `sourceMapMode: 'separate'`. **NOT enabled** (see security.md
"Non-goal: hardening" for the full list + reasons): `controlFlowFlattening`,
`stringEncryption` full set, `transformObjectKeys`, `selfDefending`, `debugProtection`,
`numbersToExpressions`, `simplify`, `unicodeEscapeSequence`.

**Sourcemap sidecar** (release 7/7): a separate source map is written for every obfuscated
artifact to `dist/maps/<target>.js.map` (gitignored, **local-only — never uploaded to
GitHub Releases**). On-demand re-symbolication for the maintainer when triaging an issue;
not a release consumer artifact.

### Fallback behavior (release 7/7)

Obfuscation failure is **graceful**. Any error (obfuscator throws, timeout, the
`C3_OBFUSCATE_FORCE_FAIL` test hook) leaves the bundle **un-obfuscated** and the build
keeps going — the trust floor (minify + signing chain) is intact, and the manifest
records what actually shipped:

- `[build-target] WARN <target>: obfuscation failed (<err>) — falling back to bare compile`
- The artifact ships as the un-obfuscated minified bundle.
- The manifest stamps `obfuscation: { applied: false }` for that artifact (and
  `applied: true, durationMs: N` when it succeeded).
- Build exit code is **0** (release is NOT blocked).
- Override: set `C3_OBFUSCATE_FAIL=abort` to flip the build to hard-fail (used by
  tests that need a red signal, not by production).

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
not emit one. An experimental P1 artifact (release 4/7) additionally carries
`"experimental": true` on its entry (absent on P0/verified entries — schema stays `v1`).

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
pnpm release:build                                  # P0 matrix, parallel, harden=basic, +manifest, +bytecode(native)
pnpm release:build --targets=linux-x64              # subset
pnpm release:build --harden=none                    # no minify/manifest (debug)
RELEASE_HARDEN=standard pnpm release:build          # standard tier (release 7/7): bundle → javascript-obfuscator → compile
                                                    #   (string-array + identifier rename; fallback = bare compile on failure)
pnpm release:build --dry-run                        # print the plan, execute nothing
pnpm release:sign                                    # SHA256SUMS + .sha256 + .minisig (reads manifest)
pnpm release:notes                                   # release notes (version + top CHANGELOG section)
pnpm release:gate                                    # pregate: typecheck→lint→test→i18n:check→check-freeze
pnpm release:smoke -- --file=dist/c3-…               # headless smoke one artifact (or read manifest if no --file)
pnpm release:verify-dist                              # publish final check: manifest↔SHA256SUMS↔disk + P0
pnpm release:publish --dry-run                        # rehearse publish: plan only, no tag/gh/sign
pnpm release --no-publish                             # gate + build + sign + notes, no GitHub Release
pnpm release --skip-gate                              # skip the source pregate (debug)
RELEASE_HARDEN=standard pnpm release                  # additionally forces `pnpm e2e --obfuscated` (release 7/7)
pnpm e2e --obfuscated                                 # e2e against the obfuscated server bundle (requires standard build first)
pnpm release                                          # gate → build(+smoke) → notes → publish (full)
pnpm release:keygen                                   # mint a minisign keypair
pnpm binary                                          # native single binary (self-use quickcut, bytecode auto on host match)
# CI:
#   .github/workflows/release.yml  →  workflow_dispatch (manual) or push tags: v*
```

## Entry points

- Build orchestrator: `scripts/release/release-build.mjs` (`--targets`, `--harden`, `--dry-run`, `--skip-smoke`; Phase3 smoke)
- Top-level orchestrator: `scripts/release/release.mjs` (`--dry-run`, `--no-publish`, `--skip-gate`, passthrough; pregate + e2e on standard)
- Target SoT: `scripts/release/targets.mjs` (`P0_TARGETS`, `P1_TARGETS`, `EXPERIMENTAL_TARGETS`, `KNOWN_TARGETS`, `DEFAULT_TARGETS`, `isExperimental`, `hostTarget`, `isHostRunnable`)
- Platform branches: `server/src/kernel/infra/child-env.ts` (`claudeLookupCommand`), `server/src/kernel/infra/db.ts` (`checkDbDriver`), `server/scripts/release/build-target.mjs` (`TARGETS` incl. P1 + windows `.exe`)
- Pregate (source gate): `scripts/release/pregate.mjs` (`GATES`, `runPregate`)
- Artifact smoke: `scripts/release/smoke.mjs` (`smokeArtifact`, `smokeBuiltArtifacts`, `assertVersionOutput`, `freePort`)
- Publish final check: `scripts/release/postgate.mjs` (`verifyDist`, `parseSha256Sums`)
- Single-target primitive: `server/scripts/release/build-target.mjs` (`buildTarget()`, `HARDEN_TIERS`, bytecode native-only gate, ad-hoc codesign, bundle → (obfuscate) → compile split for the standard tier)
- Standard-tier obfuscation helper: `server/scripts/release/obfuscate.mjs` (`obfuscateStage()`, `isObfuscationEnabled()`, `decideFallback()`, `OBFUSCATOR_OPTIONS` — locked set, no aggressive options exposed)
- Version SoT helper: `scripts/release/version-info.mjs` (`computeVersionInfo`, `versionDefines`)
- Manifest helper: `scripts/release/manifest.mjs` (`buildManifest`, `sha256File`)
- Artifact naming: `scripts/release/artifact-name.mjs` (`artifactName`, `normalizeVersion`)
- minisign core: `scripts/release/minisign.mjs` (`generateKeypair`, `signContent`, `verifyContent`)
- Signing: `scripts/release/sign.mjs` (`signArtifacts`, `artifactsFromManifest`, `secretFromEnv`)
- Notes / publish / keygen: `scripts/release/notes.mjs` (`buildNotes`), `publish.mjs` (`publish`), `keygen.mjs`
- Embedded pubkey + verify: `server/src/release-pubkey.ts`, `server/src/verify.ts` (`verifyArtifact`, `runVerify`), CLI `c3 verify`
- Runtime version: `server/src/version.ts` (`versionString`)
- Snapshot generator: `server/scripts/generate-static-embed.mjs`
- CI release workflow: `.github/workflows/release.yml` (matrix `pregate → 4 build → 4 smoke → verify-dist → provenance → publish`; `needs:` enforces order)
- Tests: `scripts/release/release-build.test.mjs`, `release-harden.test.mjs`, `release-sign.test.mjs` (the last cross-imports `server/src/verify.ts`, proving signer/verifier parity), `release-smoke.test.mjs` (artifact-gate helpers + conditional real smoke), `release-obfuscate.test.mjs` (release 7/7: obfuscate helper, NOT-doing option set, fallback decision, manifest v1.1 obfuscation block, postgate tolerance)
