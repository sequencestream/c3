# 0012 — Host-binary probing is the first capability gate

- **Status:** accepted
- **Date:** 2026-06-06

## Context

ADR-0011 made the agent layer vendor-neutral: a vendor adapter (driver + approval bridge + session
store) gives every vendor one shape. But ADR-0011's reference adapter had **no runtime caller** —
there was no registry deciding _which_ vendors are actually drivable on a given host.

That decision cannot be made from capabilities alone, because of a fact ADR-0003 already established
for Claude and which generalizes to every vendor: **none of the three vendor CLIs can be packed into
c3's `bun build --compile` single binary.** Inside the compiled binary there is no dependency tree
for a bundled CLI to live in, so each vendor's agent loop runs as a **host-CLI subprocess** resolved
from the host PATH. The single binary ships c3 itself and nothing else — "self-contained" is an
illusion. The honest distribution contract is: **install the host CLI for each agent type you want
to use.**

This makes host-binary presence the _first_ thing that gates an agent type. If `claude` is not on
PATH, no capability flag matters — the vendor simply cannot run. Today Claude-binary discovery is
hard-pinned to `claude`, consumed by a handful of runtime call sites, with no equivalent for other
vendors and no gating of registration on the result.

## Options considered

1. **Leave discovery Claude-pinned; gate later, ad hoc.** Each future vendor re-implements its own
   per-vendor executable lookup. _Con:_ duplicates the probe logic per vendor, scatters the
   install-guidance copy, and leaves no single place that turns "binary present?" into "agent type
   available?".
2. **Probe lazily at run start only.** Resolve the binary when a run launches; if absent, fail the run.
   _Con:_ the failure surfaces late (mid-launch) as an error, not up front as a product convention; the
   UI/registry still lists an agent type that can never start, and there is no boot-time operator signal.
3. **A vendor-agnostic process launcher as the front gate, feeding a registry.** Generalize discovery
   into a launcher keyed by vendor: resolve a vendor to an absolute path or null, backed by a
   host-binaries table (binary name + per-vendor path-override env var + install hint) and a
   probe-all health check. A registry probes **before constructing** each vendor adapter; an unresolved
   binary short-circuits so the adapter is never built and the vendor is reported as _missing_ with
   install guidance. _Pro:_ one probe layer, one place for the gate, capabilities only ever considered
   for present binaries. _Con:_ the legacy Claude-pinned functions must be refactored to delegate
   without any behavior change for their call sites.

## Decision

Adopt option 3.

- **A vendor-agnostic process launcher** — the host-binary probe. A host-binaries table declares each
  vendor's binary name, its path-override env var, and an operator-facing install hint. Resolving a
  vendor returns the absolute path or null (precedence: the override env var → PATH probe → per-vendor
  cache). A pure platform seam looks up a command (`command -v` on POSIX, `where` on Windows). A probe /
  probe-all feeds the health check.
- **Probing is the first capability gate.** An unresolved binary ⇒ the vendor's adapter is **never
  constructed**, so its capability ledger is never reached. The gate sits strictly ahead of
  capabilities: present-binary first, capability ledger second.
- **Adapter registry** — a factory table maps each _implemented_ vendor to its adapter factory (only
  Claude today). Resolving available adapters probes each, returning an available set and a missing set:
  a hit constructs the adapter (available), a miss records the vendor, its binary, and its install hint
  (missing) without building it. The available set is the kernel's source of truth for the available
  agent types.
- **First-launch health check** — a host-binary health check runs at boot next to the database-driver
  probe, logging present vs missing host CLIs with install guidance. Like the DB probe it is **loud but
  non-fatal**: c3 starts; only the affected vendor's agent type is unavailable.
- **Legacy delegation (additive, behavior-preserving).** The Claude-pinned executable lookup becomes a
  thin Claude-pinned shim over the generic launcher, preserving the `CLAUDE_PATH` override and the exact
  shape the runtime call sites rely on.

**Distribution contract (product convention, not a bug).** A missing host CLI is the documented,
expected state for an un-installed vendor, surfaced as actionable install guidance — never as an error.
The single binary is c3 only; agent types are opt-in by installing their host CLI.

## Consequences

- **Easier:** a new vendor adds a host-binaries row + an adapter-factory entry and is automatically
  gated by probing — no bespoke discovery code. The install-guidance copy lives in exactly one table.
- **Honest surface:** the registry can only ever offer agent types whose host CLI is actually present;
  an absent binary is a first-class "missing + how to install" state, not a late run failure.
- **Boundary:** the process launcher is pure process-infra (ADR-0009) — no SDK / run / permission
  knowledge, just "is the binary on PATH, and where". The registry depends only on the neutral vendor
  adapter and the launcher.
- **Deferred:** surfacing vendor availability through the wire protocol / front-end settings list is a
  later phase (decision D3 — this phase stops at the kernel registry + boot health check). `codex` and
  the remote vendor remain registry candidates until their adapters land.

## Compliance

- The process launcher MUST NOT import any vendor SDK nor the features / transport layers (ADR-0009 R1).
- The Claude-pinned executable lookup MUST remain behavior-equivalent: its tests stay green and the
  runtime call sites are untouched.
- Probing an absent binary MUST exclude the vendor from the available set and list it in the missing set
  with a non-empty install hint; probing a present binary MUST construct the adapter. The probe MUST run
  **before** the factory (no adapter built on a miss).
- `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` over the process and adapter modules MUST be green.

## References

- [ADR 0003](0003-single-binary-via-bun-compile.md) — the single binary can't bundle the vendor CLI; the
  host-`claude` resolution this ADR generalizes across vendors.
- [ADR 0011](0011-vendor-neutral-agent-abstraction.md) — the vendor-adapter three-piece + capability
  ledger this gate feeds; the registry is its missing runtime caller.
- [ADR 0009](0009-unidirectional-boundaries.md) — the kernel-purity boundary the process launcher honors.
- [release non-functional spec](../../non-functional/release.md) — the distribution contract ("install the
  host CLI per agent type") this ADR makes explicit.
- This phase's spec: `changes/2026/06/05/2026-06-05-012-process-launcher-host-binary-probe/2026-06-05-012-process-launcher-host-binary-probe-spec.md`.
