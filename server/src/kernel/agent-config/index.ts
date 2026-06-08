/**
 * Agent resolution + degradation chain (server refactor 3/3, ADR-0009 — sunk from
 * the old root `settings.ts`).
 *
 * An *agent* is a vendor-agnostic shell + a `vendor`-discriminated `config`
 * (claude ⇒ baseUrl / apiKey / model). A session launches using its assigned
 * agent, or the default agent when unassigned (see {@link resolveSessionLaunch}).
 * The built-in system agent ({@link SYSTEM_AGENT_ID}) always exists as a claude
 * agent with an empty default config, and cannot be removed — binding to it
 * means "no overrides, use the SDK defaults".
 *
 * These readers call `loadSettings` / `getSessionAgentId` from `kernel/config`
 * (the persistence store); the pure agent-shape normalizers come from
 * `./normalize` (a leaf). config → normalize and readers → config + normalize,
 * so the boundary stays acyclic.
 */
import type {
  AgentConfig,
  SessionAgentSwitch,
  SystemSettings,
  VendorId,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'

/**
 * The launch overrides {@link launchForAgent} resolves from one agent. `claude`
 * routes provider config into {@link envOverrides} (env vars); driver-path vendors
 * (`codex`) carry raw {@link baseUrl}/{@link apiKey} their SDK takes as
 * constructor options; `model` is neutral. Empty/system-mode agents yield `{}`
 * (no overrides). Codex's launch-time policy gate is NOT here — it is derived from
 * the session `defaultMode` in the driver, not from the agent config (2026-06-06-008).
 */
export interface LaunchOverrides {
  envOverrides?: Record<string, string>
  model?: string
  baseUrl?: string
  apiKey?: string
}
import {
  bindSessionAgent,
  changeSessionAgentFact,
  getSessionAgentId,
  loadSettings,
  setPendingIntent,
} from '../config/index.js'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { systemAgent } from './normalize.js'

export {
  AGENT_ICON_MAX_CHARS,
  defaultSettings,
  normalizeDegradationChain,
  normalizeIcon,
  systemAgent,
} from './normalize.js'
export { isDegradableError, isSocketDisconnect } from './errors.js'

export function getDefaultAgentId(): string {
  return loadSettings().defaultAgentId
}

/**
 * The enabled agents only — the canonical "list of agents" every consumer pool
 * draws from (discussion participants, consensus voters, default-agent picker).
 * Back-compat: an agent with no `enabled` field counts as enabled. NOTE this is
 * deliberately NOT used by {@link resolveAgent}/{@link resolveSessionLaunch}: a
 * disabled agent is still a valid launch fallback so a session is never locked
 * out (AC-R10).
 */
export function enabledAgents(settings: SystemSettings = loadSettings()): AgentConfig[] {
  return settings.agents.filter((a) => a.enabled !== false)
}

/**
 * Find the first enabled agent whose vendor matches `vendor`. Falls back to the
 * default agent when no enabled agent of that vendor exists, or when `vendor` is
 * unknown. Used by the schedule dispatcher to route LLM prompt execution to the
 * right vendor's adapter.
 */
export function resolveFirstAgentOfVendor(vendor: VendorId): AgentConfig {
  const settings = loadSettings()
  const match = settings.agents.find((a) => a.enabled !== false && a.vendor === vendor)
  return match ?? resolveAgent(null)
}

/** The agent for an id, or the default agent if the id is null/unknown. */
export function resolveAgent(agentId: string | null): AgentConfig {
  const settings = loadSettings()
  const byId = agentId ? settings.agents.find((a) => a.id === agentId) : undefined
  return (
    byId ??
    settings.agents.find((a) => a.id === settings.defaultAgentId) ??
    settings.agents.find((a) => a.id === SYSTEM_AGENT_ID) ??
    systemAgent()
  )
}

/**
 * Map one agent's config to {@link LaunchOverrides}, routed by its `vendor` tag
 * and gated by its `configMode` (2026-06-06-007). `configMode: 'system'` ⇒ use
 * the vendor CLI's own config: NO provider override (`baseUrl`/`apiKey`/`model`
 * are ignored) — the old system-agent behaviour, now available on any vendor.
 * `configMode: 'custom'` ⇒ apply the provider triple. Codex's launch-time policy
 * gate (`sandboxMode`/`approvalPolicy`) is NOT a provider override and is NOT
 * carried here — the driver derives it from the session `defaultMode`
 * (2026-06-06-008). Shared by session launches and consensus advisor calls.
 */
export function launchForAgent(agent: AgentConfig): LaunchOverrides {
  const env: Record<string, string> = {}
  let model: string | undefined
  let baseUrl: string | undefined
  let apiKey: string | undefined

  // `custom` applies the provider triple; `system` leaves it to the vendor CLI.
  const custom = agent.configMode === 'custom'

  switch (agent.vendor) {
    case 'claude': {
      if (custom) {
        const { baseUrl: u, apiKey: k, model: m } = agent.config
        if (u) env.ANTHROPIC_BASE_URL = u
        if (k) {
          // Cover both auth schemes: ANTHROPIC_API_KEY for first-party,
          // ANTHROPIC_AUTH_TOKEN for gateways/proxies that expect a bearer token.
          env.ANTHROPIC_API_KEY = k
          env.ANTHROPIC_AUTH_TOKEN = k
        }
        if (m) model = m
        // WORKAROUND (remove later): recent Claude Code introduced an "adaptive
        // thinking" mechanism that changes the request message format. Third-party
        // Anthropic-compatible gateways (e.g. DeepSeek) don't yet accept that format —
        // they reject the inline `system`-role messages with a 400
        // (`messages[].role: unknown variant system`). CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
        // turns off just that mechanism, restoring the compatible message format while
        // keeping CLAUDE.md/memory, Skills, and hooks (unlike the heavier
        // CLAUDE_CODE_SIMPLE=1 / `--bare` fallback). REMOVE once third-party providers
        // support the new format. Only a `custom` claude agent is third-party; a
        // `system` claude agent (first-party Anthropic) skips this whole arm.
        env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
      }
      break
    }
    case 'opencode': {
      // OpenCode runs as a shared c3-supervised server (2026-06-06-003), so only
      // the model is a per-run override; baseUrl/apiKey are server-level provider
      // config applied at supervisor boot, not per-run child env.
      if (custom && agent.config.model) model = agent.config.model
      break
    }
    case 'codex': {
      // Provider connection (custom only): raw baseUrl/apiKey for the Codex SDK
      // constructor (NOT env — CodexOptions.env replaces process.env), model neutral.
      if (custom) {
        const { baseUrl: u, apiKey: k, model: m } = agent.config
        if (u) baseUrl = u
        if (k) apiKey = k
        if (m) model = m
      }
      // The launch-time policy gate (sandbox/approval) is the per-tool-approval
      // substitute (008), but it is NOT stored on the agent: the codex driver
      // derives it from the session `defaultMode` via the neutral grid (2026-06-06-008).
      break
    }
  }

  return {
    ...(Object.keys(env).length > 0 ? { envOverrides: env } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  }
}

/**
 * Resolve how to launch Claude Code for a session: the resolved agent's id plus
 * its Claude config mapped to SDK launch overrides.
 */
export function resolveSessionLaunch(
  sessionId: string | null,
): { agentId: string } & LaunchOverrides {
  const agentId = sessionId ? getSessionAgentId(sessionId) : null
  const agent = resolveAgent(agentId)
  return { agentId: agent.id, ...launchForAgent(agent) }
}

/**
 * The vendor a session will (or did) run on (ADR-0015), for display: a real
 * session resolves to its bound agent's vendor; a pending session to its intent's
 * (or, when Auto, the default agent's) vendor. Always returns a vendor — it falls
 * back through {@link resolveAgent} exactly like {@link resolveSessionLaunch}.
 */
export function resolveSessionVendor(sessionId: string | null): VendorId {
  return resolveAgent(sessionId ? getSessionAgentId(sessionId) : null).vendor
}

/**
 * First bind (pending → real): freeze the session's fact onto the agent it just
 * ran with, resolving that agent's vendor here (the storage layer is vendor-blind
 * — ADR-0015 — so the resolution lives in this layer, which already depends on
 * `config`). `agentId` is the resolved launch agent (default fallback applied), so
 * the fact records reality. Idempotent at the storage layer (a re-bind never
 * re-freezes the vendor). Called from the run lifecycle alongside `bindPending`.
 *
 * Fires the {@link onBind} composition-time hook so the feature layer can
 * mirror the bind into the `work_session_metadata` projection (F-5). The kernel
 * itself does not import the store (kernel ↛ features boundary, ADR-0009);
 * the composition root wires `onBind` to `upsertForBind` in the store.
 */
export function freezeSessionAgent(
  pendingId: string,
  realId: string,
  agentId: string,
  workspacePath: string,
): void {
  const resolved = resolveAgent(agentId)
  bindSessionAgent(pendingId, realId, resolved.id, resolved.vendor)
  onBind?.({
    pendingId,
    realId,
    workspacePath,
    vendor: resolved.vendor,
    agentId: resolved.id,
  })
}

/**
 * Re-target a session's agent (the UI / future binding path). A still-pending
 * session just updates its mutable intent (always succeeds) AND the
 * projection's pending row's `agent_id` (F-6 pending branch). A real
 * session's vendor is frozen (ADR-0015): a same-vendor swap succeeds
 * (and the projection's real row's `agent_id` is updated), a cross-vendor
 * change is rejected — `{ ok: false }` — because the existing transcript
 * lives only in the frozen vendor's native store. A null/empty agent
 * clears a pending intent.
 *
 * Both branches fire the {@link onAgentSwap} composition-time hook so the
 * feature layer can mirror the swap into the projection.
 */
export function setSessionAgent(sessionId: string, agentId: string | null): { ok: boolean } {
  if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
    // Dual-write: the pending intent is written to BOTH state.json
    // (legacy, for backward compat with scripts / tests) AND the
    // projection table (new SoT). The projection callback fires only
    // when the composition root has wired it (production); the
    // state.json write is unconditional (tests without a db).
    setPendingIntent(sessionId, agentId)
    if (agentId) {
      const resolved = resolveAgent(agentId)
      onAgentSwap?.({
        scope: 'pending',
        sessionId,
        vendor: resolved.vendor,
        agentId: resolved.id,
      })
    }
    return { ok: true }
  }
  if (agentId === null || agentId === '') return { ok: false }
  const resolved = resolveAgent(agentId)
  const ok = changeSessionAgentFact(sessionId, resolved.id, resolved.vendor)
  if (ok) {
    onAgentSwap?.({
      scope: 'real',
      sessionId,
      vendor: resolved.vendor,
      agentId: resolved.id,
    })
  }
  return { ok }
}

// ---- Composition-time hooks (kernel ↛ features boundary) ----
//
// The kernel layer doesn't import from `features/`, so write-throughs into
// the `work_session_metadata` projection table go through these registered
// callbacks. The composition root (`server.ts` / a wiring module) wires each
// hook to its corresponding store function. The hooks default to `null` (no
// wiring) so the kernel layer still works in tests / scripts that don't
// bring the projection up.

export interface OnBindInput {
  pendingId: string
  realId: string
  workspacePath: string
  vendor: VendorId
  agentId: string
}

export interface OnAgentSwapInput {
  scope: 'pending' | 'real'
  sessionId: string
  vendor: VendorId
  agentId: string
}

let onBind: ((input: OnBindInput) => void) | null = null
let onAgentSwap: ((input: OnAgentSwapInput) => void) | null = null

/** Register the bind hook (composition root only). */
export function setOnBind(cb: ((input: OnBindInput) => void) | null): void {
  onBind = cb
}

/** Register the agent-swap hook (composition root only). */
export function setOnAgentSwap(cb: ((input: OnAgentSwapInput) => void) | null): void {
  onAgentSwap = cb
}

/**
 * The degradation chain for the current settings. Returns undefined when
 * unconfigured — the caller then runs a single attempt with no fallback
 * (the existing behaviour). The returned array is always non-empty when
 * present (normalizeDegradationChain filters down to known agent ids).
 */
export function getDegradationChain(): string[] | undefined {
  return loadSettings().degradationChain
}

/**
 * Resolve an agent by its chain position, returning the same shape as
 * {@link resolveSessionLaunch}. Returns null when the chain is absent or
 * the index is out of range.
 */
export function resolveDegradationAgent(
  chainIndex: number,
): ({ agentId: string } & LaunchOverrides) | null {
  const chain = getDegradationChain()
  if (!chain || chainIndex < 0 || chainIndex >= chain.length) return null
  const agent = resolveAgent(chain[chainIndex])
  return { agentId: agent.id, ...launchForAgent(agent) }
}

/**
 * The agents that vote in a consensus round: every *enabled* agent except the
 * one the session itself runs on (`currentAgentId`, already resolved). Disabled
 * agents never vote. **Vendor-homogeneous** — only same-vendor agents are kept
 * (see {@link vendorScopedVoters}); cross-vendor agents never vote because tool
 * names and risk semantics are not comparable across vendors.
 */
export function consensusVoters(currentAgentId: string | null): AgentConfig[] {
  return vendorScopedVoters(currentAgentId).voters
}

/**
 * Consensus is **vendor-homogeneous** (2026-06-06-006 heterogeneous-tolerance):
 * voting is limited to agents of the **session's own vendor**, because a tool
 * name + risk meaning the voter must judge is not comparable across vendors
 * (a Claude `Bash` and a Codex `shell` are different verdicts). So this resolves
 * the session agent's vendor, keeps only same-vendor enabled non-self agents as
 * voters, and reports how many enabled non-self agents of a **different** vendor
 * were excluded — so the gateway can label the outcome honestly rather than
 * implying the whole heterogeneous table weighed in. A table where the session's
 * vendor is the only one present yields `voters: []` ⇒ consensus is skipped and
 * the human is prompted as usual (the existing no-voter fallback).
 */
export function vendorScopedVoters(currentAgentId: string | null): {
  voters: AgentConfig[]
  vendorScope: VendorId
  crossVendorExcluded: number
} {
  const vendorScope = resolveAgent(currentAgentId).vendor
  const others = enabledAgents().filter((a) => a.id !== currentAgentId)
  const voters = sameVendorEnabledAgents(vendorScope, currentAgentId)
  return { voters, vendorScope, crossVendorExcluded: others.length - voters.length }
}

/**
 * The **same-vendor candidate rule** (2026-06-06-006 vendor-homogeneity), the
 * single source the consensus voters, the manual agent switcher, and the
 * degradation chain's homogeneity all agree on: every *enabled* agent of
 * `vendorScope` except `excludeId` (the session's own agent). Cross-vendor agents
 * are never candidates — a different vendor cannot carry context (no `resume`), so
 * neither voting, switching, nor fallback may cross the frozen vendor boundary.
 */
export function sameVendorEnabledAgents(
  vendorScope: VendorId,
  excludeId: string | null,
): AgentConfig[] {
  return enabledAgents().filter((a) => a.vendor === vendorScope && a.id !== excludeId)
}

/**
 * Resolve the agent-switcher payload for a session (ADR-0015 / AS-R22):
 * the other same-vendor, host-binary-present, enabled agents it may switch to,
 * plus whether the current agent's host CLI is missing. Always includes the
 * session's current agent (even with no candidates) so the status bar can
 * display the correct name. Returns null only for pending/null sessions
 * (those without a real sessionId). `presentVendors` is the set of vendors
 * whose host CLI resolved on PATH (the caller probes via `probeAll`, keeping
 * this layer free of the launcher).
 */
export function resolveSessionAgentSwitch(
  sessionId: string | null,
  presentVendors: Set<VendorId>,
): SessionAgentSwitch | null {
  if (!sessionId) return null
  const current = resolveAgent(getSessionAgentId(sessionId))
  const vendor = current.vendor
  const candidates = sameVendorEnabledAgents(vendor, current.id)
    .filter((a) => presentVendors.has(a.vendor))
    .map((a) => ({ id: a.id, displayName: a.displayName }))
  const currentUnavailable = !presentVendors.has(vendor)
  return {
    current: { id: current.id, displayName: current.displayName },
    candidates,
    currentUnavailable,
  }
}
