/**
 * ProcessLauncher — the host-binary probing layer (ADR-0012). Every agent vendor
 * c3 drives runs as a **host CLI subprocess**: the Claude/Codex/OpenCode binaries
 * can NOT be packed into c3's `bun --compile` single binary, so the single binary
 * ships c3 itself and nothing else. "Self-contained" is an illusion — each agent
 * type needs its vendor's CLI installed on the host PATH (ADR-0003 already proved
 * this for `claude`; this layer generalizes it across vendors).
 *
 * Because a missing host binary means the vendor simply cannot run, probing is the
 * **first capability gate**: `resolve(vendor) === null` ⇒ the vendor adapter is
 * never even constructed, so its {@link AdapterCapabilities} never matter. The
 * registry (`adapters/registry.ts`) consults this layer before anything else.
 *
 * Pure-infra (ADR-0009): no SDK / run / permission knowledge — just "is the binary
 * on PATH, and where". The legacy `findClaudeExecutable` / `claudeLookupCommand`
 * in `infra/child-env.ts` now delegate here (additive, behavior-preserving).
 */
import { spawnSync } from 'node:child_process'
import type { VendorId } from '../adapters/types.js'

/** Static description of one vendor's host CLI dependency. */
export interface HostBinarySpec {
  readonly vendor: VendorId
  /** The executable name probed on PATH. */
  readonly binary: string
  /** Env var that overrides the probed path (e.g. `CLAUDE_PATH`). */
  readonly pathEnv: string
  /**
   * Operator-facing guidance shown when the binary is missing — a **product
   * convention, not a bug**: the vendor's agent type is simply unavailable until
   * the host CLI is installed. Exact copy is product-owned (placeholder for now).
   */
  readonly installHint: string
}

/**
 * The host CLI each vendor needs. New vendors add a row here; the table also
 * drives the first-launch health check, so it lists all three vendors even though
 * only `claude` has a runtime adapter today.
 */
export const HOST_BINARIES: Record<VendorId, HostBinarySpec> = {
  claude: {
    vendor: 'claude',
    binary: 'claude',
    pathEnv: 'CLAUDE_PATH',
    installHint:
      'Install the Claude Code CLI (`npm i -g @anthropic-ai/claude-code`) and log in (`claude /login`). Override the path with $CLAUDE_PATH.',
  },
  codex: {
    vendor: 'codex',
    binary: 'codex',
    pathEnv: 'CODEX_PATH',
    installHint:
      'Install the OpenAI Codex CLI (see https://github.com/openai/codex) and ensure `codex` is on PATH. Override the path with $CODEX_PATH.',
  },
  opencode: {
    vendor: 'opencode',
    binary: 'opencode',
    pathEnv: 'OPENCODE_PATH',
    installHint:
      'Install the OpenCode CLI (see https://opencode.ai) and ensure `opencode` is on PATH. Override the path with $OPENCODE_PATH.',
  },
}

/** The probe outcome for one vendor: where its binary is, or `null` if absent. */
export interface VendorProbe {
  readonly vendor: VendorId
  readonly binary: string
  readonly path: string | null
  readonly installHint: string
}

/**
 * The platform-correct "find an executable on PATH" command. POSIX has no portable
 * `which`, but every shell carries `command -v`; Windows has no `sh`, so we use the
 * `where.exe` builtin instead. Pure so it's unit-testable without spawning.
 */
export function lookupCommand(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): [cmd: string, args: string[]] {
  return platform === 'win32' ? ['where', [binary]] : ['sh', ['-c', `command -v ${binary}`]]
}

// Per-vendor resolution cache. A vendor maps to its absolute path, or `null` when
// probed-and-absent (so we don't re-spawn on every lookup). `undefined` ⇒ not yet
// probed. Reset via `resetProbeCache` in tests.
const cache = new Map<VendorId, string | null>()

/**
 * Resolve a vendor's host CLI to an absolute path, or `null` if it isn't installed.
 * Precedence: `$<PATH_ENV>` override → PATH probe → cached result. This is the first
 * capability gate — a `null` here means the vendor's agent type does not exist for
 * this c3 process.
 */
export function resolve(vendor: VendorId): string | null {
  const cached = cache.get(vendor)
  if (cached !== undefined) return cached

  const spec = HOST_BINARIES[vendor]
  const override = process.env[spec.pathEnv]
  if (override) {
    cache.set(vendor, override)
    return override
  }

  let found: string | null
  try {
    const [cmd, args] = lookupCommand(spec.binary)
    const r = spawnSync(cmd, args, { encoding: 'utf-8' })
    // `where` can print multiple matches (one per line); take the first. `command -v`
    // prints a single line. Trim either way.
    const first = r.status === 0 ? (r.stdout.split('\n')[0]?.trim() ?? '') : ''
    found = first || null
  } catch {
    found = null
  }
  cache.set(vendor, found)
  return found
}

/** Probe one vendor into a {@link VendorProbe} (path + install guidance). */
export function probe(vendor: VendorId): VendorProbe {
  const spec = HOST_BINARIES[vendor]
  return { vendor, binary: spec.binary, path: resolve(vendor), installHint: spec.installHint }
}

/** Probe every known vendor — the first-launch health check input. */
export function probeAll(): VendorProbe[] {
  return (Object.keys(HOST_BINARIES) as VendorId[]).map(probe)
}

/** Clear the resolution cache. Test-only — runtime probes are stable per process. */
export function resetProbeCache(): void {
  cache.clear()
}
