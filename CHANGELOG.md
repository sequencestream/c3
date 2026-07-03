# Changelog

All notable changes to `c3` (Code Creative Center). The version source-of-truth is the git
tag (`git describe --tags`); `package.json` is the fallback baseline.

## v0.9.1

- automation refactor

## v0.9.0

- add intent log

## v0.8.0

- optimization and improvement

## v0.7.0

- optimization and improvement

## v0.6.0

- optimization and improvement

## v0.5.0

- optimization and improvement

## v0.4.3

- optimization and improvement

## v0.4.0

- optimization and improvement

## v0.3.0

- worktree support
- schedules improvement

## v0.2.0

c3 (Code Creative Center) is a coding platform that fuses harness and loop engineering
with AI software-engineering practice. Instead of throwing a raw prompt at a
model and hoping, c3 turns vague, half-formed requirements into structured intents — each
with a clear scope, dependencies, and a verifiable definition of done. From there it drives
the work through automated flows: planning, implementation, and validation run as
repeatable loops rather than one-shot guesses, so progress is steady and auditable. Multi-
agent discussions let perspectives converge before code is written, while scheduled tasks
keep long-running and recurring work moving without a human babysitting the loop.
c3 spec mode is spec-first and constitution-governed: the specification is the source of truth,
every decision is traceable, and the whole thing runs as a single local process you fully own.

## v0.1.0

### Distribution trust

- **Signed, verifiable releases.** Every `release:build` artifact ships with a `.sha256` and
  a minisign `.minisig` signature, plus aggregate `SHA256SUMS`(`.minisig`). Signatures use
  Ed25519 (minisign format) and are interoperable with the official `minisign` CLI.
- **`c3 verify <file>`** — offline self-check against a public key embedded in the binary
  (no network, no external `minisign`). Verifies the sha256 sidecar and the minisign
  signature; passes for genuine artifacts, fails for tampered ones.
- **macOS ad-hoc code signing** (`codesign -s -`) applied at build time on macOS hosts.
- **Release orchestration:** `pnpm release` (build → notes → publish) with `--dry-run` and
  `--no-publish`; `pnpm release:notes`, `pnpm release:sign`, `pnpm release:publish`,
  `pnpm release:keygen`.
- **Versioned artifact names:** `c3-v{version}-{os}-{arch}{.exe?}`.
- Package stays `private: true` — binaries are distributed via GitHub Releases, not npm.
