# 0012 — Host-binary probing is the first capability gate

- **Status:** accepted
- **Date:** 2026-06-06

## Context

ADR-0011 made the agent layer vendor-neutral: a `VendorAdapter` (driver + approval bridge +
session store) plus an `AdapterCapabilities` ledger lets c3 drive Claude, Codex, or OpenCode through
one shape. But ADR-0011's reference adapter (`createClaudeAdapter`) had **no runtime caller** — there
was no registry deciding _which_ vendors are actually drivable on a given host.

That decision cannot be made from capabilities alone, because of a fact ADR-0003 already established
for Claude and which generalizes to every vendor: **none of the three vendor CLIs can be packed into
c3's `bun build --compile` single binary.** Inside the compiled binary there is no `node_modules` for
a bundled CLI to live in, so each vendor's agent loop runs as a **host-CLI subprocess** resolved from
the host PATH. The single binary ships c3 itself and nothing else — "self-contained" is an illusion.
The honest distribution contract is: **install the host CLI for each agent type you want to use.**

This makes host-binary presence the _first_ thing that gates an agent type. If `claude` is not on
PATH, no `AdapterCapabilities` flag matters — the vendor simply cannot run. Today Claude-binary
discovery lives in `infra/child-env.ts` (`findClaudeExecutable` / `claudeLookupCommand`), hard-pinned
to `claude` and consumed by four runtime call sites, with no equivalent for other vendors and no
gating of registration on the result.

## Options considered

1. **Leave discovery Claude-pinned; gate later, ad hoc.** Each future vendor re-implements its own
   `find<Vendor>Executable`. _Con:_ duplicates the probe logic per vendor, scatters the install-guidance
   copy, and leaves no single place that turns "binary present?" into "agent type available?".
2. **Probe lazily at run start only.** Resolve the binary when a run launches; if absent, fail the run.
   _Con:_ the failure surfaces late (mid-launch) as an error, not up front as a product convention; the
   UI/registry still lists an agent type that can never start, and there is no boot-time operator signal.
3. **A vendor-agnostic ProcessLauncher as the front gate, feeding a registry.** Generalize discovery into
   `agent/process/launcher.ts` keyed by `VendorId`: `resolve(vendor) → absolute path | null`, with a
   `HOST_BINARIES` table (binary name + `*_PATH` override + install hint) and a `probeAll` health check.
   A registry (`adapters/registry.ts`) probes **before constructing** each vendor adapter; an unresolved
   binary short-circuits so the adapter is never built and the vendor is reported as _missing_ with
   install guidance. _Pro:_ one probe layer, one place for the gate, capabilities only ever considered for
   present binaries. _Con:_ the legacy Claude-pinned functions must be refactored to delegate without any
   behavior change for their four call sites.

## Decision

Adopt option 3.

- **ProcessLauncher (`server/src/kernel/agent/process/launcher.ts`)** — the vendor-agnostic host-binary
  probe. `HOST_BINARIES: Record<VendorId, HostBinarySpec>` declares each vendor's `binary`, its
  `*_PATH` override env var, and an operator-facing `installHint`. `resolve(vendor)` returns the absolute
  path or `null` (precedence: `$<PATH_ENV>` → PATH probe → per-vendor cache). `lookupCommand(binary,
platform)` is the pure platform seam (`command -v` on POSIX, `where` on Windows). `probe` / `probeAll`
  feed the health check.
- **Probing is the first capability gate.** `resolve(vendor) === null` ⇒ the vendor's adapter is **never
  constructed**, so its `AdapterCapabilities` are never reached. The gate sits strictly ahead of
  capabilities: present-binary first, capability ledger second.
- **Adapter registry (`server/src/kernel/agent/adapters/registry.ts`)** — `VENDOR_FACTORIES` maps each
  _implemented_ vendor to its factory (`{ claude: createClaudeAdapter }` today). `resolveAvailableAdapters`
  probes each, returning `{ available: VendorAdapter[], missing: MissingVendor[] }`: a hit constructs the
  adapter (`available`), a miss records `{ vendor, binary, installHint }` (`missing`) without building it.
  `available` is the kernel's source of truth for the available agent types.
- **First-launch health check** — `logHostBinaryHealth()` runs at boot next to `checkDbDriver`
  (`server.ts`), logging present vs missing host CLIs with install guidance. Like the DB probe it is
  **loud but non-fatal**: c3 starts; only the affected vendor's agent type is unavailable.
- **Legacy delegation (additive, behavior-preserving).** `findClaudeExecutable` / `claudeLookupCommand`
  in `infra/child-env.ts` become thin Claude-pinned shims over `resolve('claude')` / `lookupCommand('claude')`,
  preserving names, the `CLAUDE_PATH` override, and the exact shape the four runtime call sites rely on.

**Distribution contract (product convention, not a bug).** A missing host CLI is the documented,
expected state for an un-installed vendor, surfaced as actionable install guidance — never as an error.
The single binary is c3 only; agent types are opt-in by installing their host CLI.

## Consequences

- **Easier:** a new vendor adds a `HOST_BINARIES` row + a `VENDOR_FACTORIES` entry and is automatically
  gated by probing — no bespoke discovery code. The install-guidance copy lives in exactly one table.
- **Honest surface:** the registry can only ever offer agent types whose host CLI is actually present;
  an absent binary is a first-class "missing + how to install" state, not a late run failure.
- **Boundary:** ProcessLauncher is pure process-infra (ADR-0009) — no SDK / run / permission knowledge,
  just "is the binary on PATH, and where". The registry depends only on the neutral `VendorAdapter` and
  the launcher.
- **Deferred:** surfacing vendor availability through the wire protocol / front-end settings list is a
  later phase (decision D3 — this phase stops at the kernel registry + boot health check). `codex` /
  `opencode` are listed in `HOST_BINARIES` for the health check but have no factory yet, so they are not
  registry candidates until their adapters land.

## Compliance

- `server/src/kernel/agent/process/launcher.ts` MUST NOT import any vendor SDK (`git grep
"from '@anthropic-ai/claude-agent-sdk'" server/src/kernel/agent/process/` empty) nor `features/` /
  `transport/` (ADR-0009 R1).
- `findClaudeExecutable` / `claudeLookupCommand` MUST remain behavior-equivalent: `child-env.test.ts`
  stays green and the four runtime call sites are untouched.
- `resolveAvailableAdapters(() => null)` MUST exclude the vendor from `available` and list it in `missing`
  with a non-empty `installHint`; `resolveAvailableAdapters(() => '<path>')` MUST construct it. Pinned by
  `registry.test.ts`. The probe MUST run **before** the factory (no adapter built on a miss).
- `pnpm typecheck` + `pnpm lint` + `pnpm vitest run server/src/kernel/agent/process server/src/kernel/agent/adapters`
  MUST be green.

## References

- [ADR 0003](0003-single-binary-via-bun-compile.md) — the single binary can't bundle the vendor CLI; the
  host-`claude` resolution this ADR generalizes across vendors.
- [ADR 0011](0011-vendor-neutral-agent-abstraction.md) — the `VendorAdapter` three-piece + capability
  ledger this gate feeds; the registry is its missing runtime caller.
- [ADR 0009](0009-unidirectional-boundaries.md) — the kernel-purity boundary ProcessLauncher honors.
- [release non-functional spec](../../non-functional/release.md) — the distribution contract ("install the
  host CLI per agent type") this ADR makes explicit.
- This phase's spec: `changes/2026/06/05/2026-06-05-012-process-launcher-host-binary-probe/spec.md`.
