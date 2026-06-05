# Non-Functional — Security

Security is c3's primary value (constitution § Mission & values). Targets here refine the
constitution's `C-SEC-*` rules into checkable expectations.

## Threat model

- **Trusted:** the local OS user running c3 and the browser on the same machine.
- **Untrusted:** anything off-host. c3 is not designed to be exposed to a network.
- **Out of scope:** protecting against a malicious local user; sandboxing the `claude`
  process; protecting the project directory contents.

## Requirements

| ID    | Requirement                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-1 | The server binds to `localhost` only. Binding to a non-loopback interface requires an ADR and an auth design (constitution C-SEC-5).                                                                                                              |
| SEC-2 | No persistent store, no logging of tool inputs/outputs to disk by c3. State lives in memory for the connection's lifetime only.                                                                                                                   |
| SEC-3 | The SDK runs with `settingSources: ['user', 'project']` — user and project settings, hooks, and allow/deny rules are inherited and applied before c3's browser gate. Tools not pre-decided by them flow through `canUseTool` (C-SEC-1, ADR 0005). |
| SEC-4 | A sensitive tool executes only on an explicit `allow`, or under a mode the user explicitly selected that authorizes auto-execution (`acceptEdits`, `bypassPermissions`) (C-SEC-2).                                                                |
| SEC-5 | The default outcome is **deny**: an unrecognized decision or an aborted run never yields `allow` (C-SEC-3). An unanswered request does not resolve at all — it blocks until the user decides or the run is aborted.                               |
| SEC-6 | c3 never reads, stores, or transmits Claude credentials; the `claude` CLI owns auth (C-SEC-4).                                                                                                                                                    |
| SEC-7 | Switching into `bypassPermissions` is always the result of an explicit, observable UI action; it is never set silently by c3.                                                                                                                     |
| SEC-8 | Distribution trust (DIST-1): released binaries carry a per-artifact sha256 and an Ed25519 (minisign) signature; `c3 verify` self-checks against a public key embedded in the binary. A tampered or unsigned artifact fails verification.          |

## Distribution trust (DIST-1 / SEC-8)

Since SEC-6 keeps credentials out of the binary, the real distribution threat is **artifact
impersonation / supply-chain tampering** (a malicious mirror or MITM serving a trojaned
`c3`), not reverse-engineering. The trust anchor is an **offline Ed25519 signing key** (held
as the `C3_MINISIGN_SECRET_KEY` GitHub Secret); only its public half is committed
(`server/src/release-pubkey.ts`, README). Mechanism (release 3/7):

- **`SHA256SUMS` + per-artifact `.sha256`** — integrity, `shasum -a 256 -c` compatible.
- **minisign `.minisig`** (Ed25519, standard format) over each artifact and over
  `SHA256SUMS` — authenticity. Interoperable with the official `minisign` CLI.
- **`c3 verify <file>`** — offline self-verification using only `node:crypto`
  (Ed25519 + BLAKE2b-512) against the **embedded** public key; no network, no external tool.
- **macOS ad-hoc `codesign -s -`** — applied before hashing so the signed bytes are what the
  sha256/minisig cover. (Ad-hoc only; not Apple notarization — Gatekeeper quarantine is
  cleared by the user with `xattr -dr com.apple.quarantine`, documented in the README.)

A consumer with the README public key can verify any download offline; the matching secret
never leaves the maintainer's control.

## Non-goal: anti-decompilation / obfuscation

Resistance to **decompilation or reverse-engineering is explicitly NOT a security goal**.
`minify`/`strip` (harden tiers, release 2/7) only raise the bar against casual copying — they
are **not** a confidentiality or integrity control and must never be relied on as one. Real
distribution trust comes entirely from the signing chain above (DIST-1). Treating obfuscation
as security is a known anti-pattern; c3 does not.

## Anti-scenarios (must never happen)

- A malformed WebSocket frame is interpreted as an `allow`.
- A permission request hangs forever with no resolution.
- Credentials appear in a log line, error message, or wire message.
- A tampered binary passes `c3 verify`, or obfuscation is treated as a trust control.
