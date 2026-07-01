# 0012 — Vendor executable resolution is the first capability gate

- **Status:** accepted, revised 2026-07-01
- **Date:** 2026-06-06

## Context

ADR-0011 made the agent layer vendor-neutral, but every implemented vendor still
executes through its own CLI. Relying by default on the user's login-shell PATH
made c3 behavior drift with whatever `claude` / `codex` happened to be installed
on the host. It also failed under daemon and OS service launches, where PATH often
differs from an interactive shell.

## Decision

c3 owns the default vendor CLI source. The launcher resolves each vendor in this
fixed order:

1. explicit `CLAUDE_PATH` / `CODEX_PATH`;
2. c3-managed CLI under `~/.c3/vendor/<vendor>/<version>/bin/<binary>`;
3. degraded host `PATH` fallback.

An invalid explicit override is a hard resolution failure for that vendor. It is
not silently bypassed, because an operator-provided path is intentional
configuration.

The managed installer reads npm packuments over HTTPS, downloads the selected
package tarball, verifies npm `dist.integrity`, stages and self-checks the binary,
then publishes the version directory. State is recorded in
`~/.c3/vendor/manifest.json`, including selected/manual/latest-compatible version,
source, path, compatible range, errors, and recent version history. c3 never writes
vendor credentials or login state.

Host PATH remains only for migration and failure recovery. When used, health and
settings status must say `host-path-fallback` and preserve the managed failure
reason so fallback does not hide install or upgrade failures.

## Consequences

- daemon and OS service launches use the same `~/.c3/vendor` default as terminal
  launches and do not require a shell PATH injection;
- c3 upgrades can change the compatible vendor range, and the next start syncs
  managed CLIs to the new compatible selection;
- env overrides stay useful for development, debugging, and enterprise pinning;
- c3 now owns npm package download, integrity verification, atomic replacement,
  platform tags, and version compatibility policy;
- c3 does not modify user PATH, shell profiles, Homebrew/npm global installs, or
  Claude/Codex credentials.

## Compliance

- Resolution results must be structured, with source states for `env-override`,
  `managed`, `host-path-fallback`, `missing`, `install-failed`, and
  `override-invalid`.
- Managed install failures must not delete or overwrite an existing usable
  version.
- Manual version pins in `vendorCliVersions.claude` / `vendorCliVersions.codex`
  must take precedence over automatic latest-compatible selection.
- Version parsing is vendor-specific; a generic loose regex is not sufficient.
- Tests must cover resolver priority, install failure recovery, service-like empty
  PATH managed resolution, npm packument selection, and health/status source
  reporting.

## References

- [ADR 0011](0011-vendor-neutral-agent-abstraction.md) — vendor adapter abstraction.
- [ADR 0009](0009-unidirectional-boundaries.md) — kernel boundary rules.
- [release non-functional spec](../../non-functional/release.md) — distribution and
  service expectations.
