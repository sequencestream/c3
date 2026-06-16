# Non-Functional — Security

Security is c3's primary value (constitution § Mission & values). Targets here refine the
constitution's `C-SEC-*` rules into checkable expectations.

## Threat model

- **Trusted:** the local OS user running c3 and the browser on the same machine.
- **Untrusted:** anything off-host. c3 is not designed to be exposed to a network.
- **Out of scope:** protecting against a malicious local user; sandboxing the `claude`
  process; protecting the project directory contents.

## Requirements

| ID     | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-1  | The server binds to `localhost` only. Binding to a non-loopback interface requires an ADR and an auth design (constitution C-SEC-5).                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SEC-2  | No persistent store, no logging of tool inputs/outputs to disk by c3. State lives in memory for the connection's lifetime only.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SEC-3  | The SDK runs with `settingSources: ['user', 'project']` — user and project settings, hooks, and allow/deny rules are inherited and applied before c3's browser gate. Tools not pre-decided by them flow through `canUseTool` (C-SEC-1, ADR 0005).                                                                                                                                                                                                                                                                                                                                          |
| SEC-4  | A sensitive tool executes only on an explicit `allow`, or under a mode the user explicitly selected that authorizes auto-execution (`acceptEdits`, `bypassPermissions`) (C-SEC-2).                                                                                                                                                                                                                                                                                                                                                                                                         |
| SEC-5  | The default outcome is **deny**: an unrecognized decision or an aborted run never yields `allow` (C-SEC-3). An unanswered request does not resolve at all — it blocks until the user decides or the run is aborted.                                                                                                                                                                                                                                                                                                                                                                        |
| SEC-6  | c3 never reads, stores, or transmits Claude credentials; the `claude` CLI owns auth (C-SEC-4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| SEC-7  | Switching into `bypassPermissions` is always the result of an explicit, observable UI action; it is never set silently by c3.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SEC-8  | Distribution trust (DIST-1): released binaries carry a per-artifact sha256 and an Ed25519 (minisign) signature; `c3 verify` self-checks against a public key embedded in the binary. A tampered or unsigned artifact fails verification.                                                                                                                                                                                                                                                                                                                                                   |
| SEC-9  | **Workspace identity is a server-assigned opaque id.** Every workspace-scoped wire message carries a `workspaceId` (random, persisted in the registry), never an absolute path. The server is the sole authority that maps `id → realpath` via `resolveWorkspaceRoot(id)`, which rejects any unregistered/forged id — so a client cannot inject an arbitrary filesystem root by construction (it can neither read nor fabricate a valid id). `add_workspace`/`remove_workspace` are the ONLY messages that carry a path; absolute paths never appear on any other message (grep-enforced). |
| SEC-10 | **`add_workspace` (and `remove_workspace`) require an authenticated session.** They are the only entry where an absolute path legitimately enters the system — i.e. where a new trust root is established — so they are refused on an unauthenticated connection (`unauthenticated` reply). This is the hook for future per-role authorization; single-user localhost + login-gate is unchanged otherwise.                                                                                                                                                                                 |

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

## Non-goal: hardening (release 7/7 — full NOT-doing list)

The **standard** harden tier (`RELEASE_HARDEN=standard`, opt-in) enables a narrow obfuscation
pass — `javascript-obfuscator` with `stringArray` + `identifierRename` only. The following
hardening options are **explicitly NOT** part of c3's release pipeline. They were evaluated
and rejected; the list lives here so future contributors don't re-introduce them and code
review has a single place to point at.

| Class                                  | Why we don't do it                                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control-flow flattening**            | E2E/smoke become hard to diagnose on regression (a stack trace tells you less); doubles bundle size; gives zero defensive value against the real threat.                    |
| **String encryption (full)**           | Redundant with `stringArray` (which is what we use); adds 5–10% startup; would also break e2e regex assertions on the obfuscated bundle.                                    |
| **Object-key transformation**          | Breaks runtime dispatch (`obj['key']`); high regression risk; no real defensive value.                                                                                      |
| **`selfDefending` / anti-debug**       | False-positives our smoke tests and CI on first run; bypassed by `eval`-aware tooling in the same minute an attacker bothers.                                               |
| **Debug-protection / anti-VM**         | Same as above — false-positives + bypass; e2e/smoke catches the noise as FAIL.                                                                                              |
| **UPX packing / exe compression**      | `upx -d` reverses it in ~1s; triggers Windows Defender false positives; slows startup; nothing more than a fingerprint for malware scanners.                                |
| **License / activation checks**        | Conflicts with **SEC-6** (c3 does not read, store, or transmit credentials); no server to validate against; users copying to friends is **by design**, not a vulnerability. |
| **Anti-tamper / integrity self-check** | Adds a startup-time bypass surface; redundant with the manifest sha256 + minisign chain that already covers integrity end-to-end.                                           |

The locked option set used by the standard tier is in
`server/scripts/release/obfuscate.mjs` `OBFUSCATOR_OPTIONS`; the test
`scripts/release/release-obfuscate.test.mjs` asserts the NOT-doing list is honored
(`controlFlowFlattening` falsy, `selfDefending: false`, `debugProtection: false`,
`transformObjectKeys: false`, `renameGlobals: false`, options object frozen).

## Anti-scenarios (must never happen)

- A malformed WebSocket frame is interpreted as an `allow`.
- A permission request hangs forever with no resolution.
- Credentials appear in a log line, error message, or wire message.
- A tampered binary passes `c3 verify`, or obfuscation is treated as a trust control.
- A hardening option from the NOT-doing list (control-flow flattening, UPX, anti-debug, license check, …) sneaks into the standard tier's option set.
- An absolute path reaches a feature handler from any wire message other than `add_workspace`/`remove_workspace` (SEC-9), or a forged/unregistered `workspaceId` resolves to a filesystem root instead of being rejected.
- `add_workspace`/`remove_workspace` register/tear down a trust root on an unauthenticated connection (SEC-10).
