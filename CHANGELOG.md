# Changelog

All notable changes to `c3` (Claude Code Center). The version source-of-truth is the git
tag (`git describe --tags`); `package.json` is the fallback baseline.

## 0.2.0

### Distribution trust (release 3/7)

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
