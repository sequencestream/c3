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
  ConsensusConfig,
  SessionAgentSwitch,
  SessionKind,
  StoreScope,
  SystemSettings,
  VendorId,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { groupAgentRef, isGroupAgentRef, parseGroupAgentRef } from '@ccc/shared'
import type { RelayCandidate } from '../relay/contract.js'
import { getRelay, withLoopbackNoProxy } from '../relay/runtime.js'

/**
 * The launch overrides {@link launchForCandidates} resolves from an agent (or a
 * group's candidate list). ALL vendors now route their provider connection through
 * the loopback relay (ADR-0029): a `custom` agent yields a {@link relayCandidates}
 * list (the real upstreams, bound behind a per-run token at the spawn site) instead
 * of raw baseUrl/key, so the real key never reaches the vendor subprocess. A
 * `system`/empty agent yields no candidates (the vendor CLI's own login) and only a
 * neutral `model` override. `envOverrides` carries only non-secret env (proxy vars,
 * the claude third-party workaround flag). Codex's launch-time policy gate is NOT
 * here — the driver derives it from the session `defaultMode` (2026-06-06-008).
 */
export interface LaunchOverrides {
  envOverrides?: Record<string, string>
  model?: string
  /**
   * The ordered relay candidate list for a `custom` agent / group (one entry per
   * enabled member, in priority order). Absent ⇒ system mode (own login), direct.
   * The spawn site (`codex` driver / the claude launch path / the one-shot advisor)
   * registers this behind a per-run token; the relay fails over across it.
   */
  relayCandidates?: RelayCandidate[]
}
import {
  bindSessionAgent,
  changeSessionAgentFact,
  getProxyConfig,
  getSessionAgentId,
  getSessionStoreScope,
  loadSettings,
  saveSettings,
  setPendingIntent,
} from '../config/index.js'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { firstEnabledSandboxAgent, systemAgent } from './normalize.js'

export {
  AGENT_ICON_MAX_CHARS,
  defaultSettings,
  normalizeDegradationChain,
  normalizeIcon,
  systemAgent,
} from './normalize.js'
export { isDegradableError, isSocketDisconnect } from './errors.js'
export { parseQuotaResetAt } from './quota-reset.js'

export function getDefaultAgentId(): string {
  return loadSettings().defaultAgentId
}

/**
 * The configured tool-agent id (background tool sessions' executor). An empty
 * string means "follow the default agent" — see {@link resolveToolAgent}.
 */
export function getToolAgentId(): string {
  return loadSettings().toolAgentId
}

/**
 * The configured intent-agent id (intent-communication sessions' executor). An
 * empty string means "follow the default agent" — see {@link resolveIntentAgent}.
 */
export function getIntentAgentId(): string {
  return loadSettings().intentAgentId
}

/**
 * The configured spec-agent id (spec-authoring sessions' executor). An empty
 * string means "follow the default agent" — see {@link resolveSpecAgent}.
 */
export function getSpecAgentId(): string {
  return loadSettings().specAgentId
}

/**
 * The enabled agents only — the canonical "list of agents" every consumer pool
 * draws from (discussion participants, consensus voters, default-agent picker),
 * returned in the user-controlled global order (`order_seq` ascending — the
 * single sort key shared across every implicit agent-list consumer). Back-compat:
 * an agent with no `enabled` field counts as enabled, and a missing `order_seq`
 * sorts as `0` (a fully-normalized registry always carries a dense sequence; the
 * `?? 0` only guards an un-normalized `settings` passed straight in). NOTE this is
 * deliberately NOT used by {@link resolveAgent}/{@link resolveSessionLaunch}: a
 * disabled agent is still a valid launch fallback so a session is never locked
 * out (AC-R10).
 */
export function enabledAgents(settings: SystemSettings = loadSettings()): AgentConfig[] {
  return settings.agents
    .filter((a) => a.enabled !== false)
    .sort((a, b) => (a.order_seq ?? 0) - (b.order_seq ?? 0))
}

/** Persistently enable/disable one agent. Normalization rewrites default/tool fallbacks. */
export function setAgentEnabled(agentId: string, enabled: boolean): boolean {
  const settings = loadSettings()
  if (!settings.agents.some((agent) => agent.id === agentId)) return false
  saveSettings({
    ...settings,
    agents: settings.agents.map((agent) => (agent.id === agentId ? { ...agent, enabled } : agent)),
  })
  return true
}

/**
 * Find the first enabled agent whose vendor matches `vendor`. Falls back to the
 * default agent when no enabled agent of that vendor exists, or when `vendor` is
 * unknown. Used by the automation dispatcher to route LLM prompt execution to the
 * right vendor's adapter.
 */
export function resolveFirstAgentOfVendor(vendor: VendorId): AgentConfig {
  const settings = loadSettings()
  const match = settings.agents.find((a) => a.enabled !== false && a.vendor === vendor)
  return match ?? resolveAgent(null)
}

/**
 * The agent for a reference, or the default agent if it is null/unknown. A virtual
 * group reference (`_c3_<vendor>_<group>`) resolves to that group's highest-priority
 * enabled member (its representative — for vendor/model display and the single-agent
 * callers); an empty group falls through to the default (ADR-0029).
 */
export function resolveAgent(agentId: string | null): AgentConfig {
  const settings = loadSettings()
  const g = agentId ? parseGroupAgentRef(agentId) : null
  if (g) {
    const members = groupAgents(g.vendor, g.group, settings)
    if (members.length > 0) return members[0]
    agentId = null // empty group ⇒ fall through to the default fallback
  }
  const byId = agentId ? settings.agents.find((a) => a.id === agentId) : undefined
  return (
    byId ??
    settings.agents.find((a) => a.id === settings.defaultAgentId) ??
    settings.agents.find((a) => a.id === SYSTEM_AGENT_ID) ??
    systemAgent()
  )
}

/**
 * The agent that runs **background tool sessions** (completion judge, session
 * summary; the exception-handling session is not yet agent-driven — reserved for
 * a follow-up intent). Reads `toolAgentId` and resolves it through
 * {@link resolveAgent}, so the fall-through is `toolAgentId → defaultAgentId →
 * system → synthesized fallback`: an empty/unknown `toolAgentId` (the "follow the
 * default" sentinel) lands on the default agent, never locking a tool session out.
 */
export function resolveToolAgent(): AgentConfig {
  return resolveAgent(loadSettings().toolAgentId)
}

/**
 * Launch overrides for a background tool session — the {@link resolveToolAgent}
 * mirror of {@link resolveSessionLaunch} (model + provider env), so the completion
 * judge / naming one-shots execute on the configured tool agent.
 */
export function resolveToolSessionLaunch(): { agentId: string } & LaunchOverrides {
  return resolveLaunchForRef(getToolAgentId() || null)
}

/**
 * The agent that runs **intent-communication sessions** (the intent analyst's
 * requirement-breakdown conversation). Reads `intentAgentId` and resolves it
 * through {@link resolveAgent}, so the fall-through is `intentAgentId →
 * defaultAgentId → system → synthesized fallback`: an empty/unknown `intentAgentId`
 * (the "follow the default" sentinel) lands on the default agent, never locking an
 * intent comm session out. Mirrors {@link resolveToolAgent} exactly.
 */
export function resolveIntentAgent(): AgentConfig {
  return resolveAgent(loadSettings().intentAgentId)
}

/**
 * The agent that runs **spec-authoring sessions** (writing/refining the project
 * specification). Reads `specAgentId` and resolves it through {@link resolveAgent},
 * so the fall-through is `specAgentId → defaultAgentId → system → synthesized
 * fallback`: an empty/unknown `specAgentId` (the "follow the default" sentinel)
 * lands on the default agent, never locking a spec session out. Mirrors
 * {@link resolveIntentAgent} exactly.
 */
export function resolveSpecAgent(): AgentConfig {
  return resolveAgent(loadSettings().specAgentId)
}

/** The sandbox-role id configured for a session kind (the `sandbox*AgentId` field
 *  matching the kind); "" ("follow the sandbox default") for kinds without a
 *  dedicated field. Custom-validated on store — see {@link normalizeSandboxRoleId}. */
function sandboxRoleIdForKind(settings: SystemSettings, kind: SessionKind): string {
  switch (kind) {
    case 'intent':
      return settings.sandboxIntentAgentId
    case 'spec':
      return settings.sandboxSpecAgentId
    case 'tool':
      return settings.sandboxToolAgentId
    case 'automation':
      return settings.sandboxAutomationAgentId
    default:
      return '' // work / discussion / consensus ⇒ the sandbox default
  }
}

/**
 * The agent a sandboxed run of `kind` should use, in the unchanged order:
 *   sandbox<role>Id → sandboxDefaultAgentId → first enabled agent (same `vendor`
 *   preferred, then any).
 * Candidate admission is `enabled` only — a `system`-mode (subscription) agent is
 * now a legal sandbox agent, because the arapuca wrapper opens the host keychain
 * for it (`--allow-keychain`, arapuca ≥ 0.2.5). Whether that authentication then
 * succeeds is arapuca's and the vendor CLI's business on the given platform; c3 no
 * longer filters by auth mode or by `process.platform`.
 *
 * `vendor` is the bound agent's vendor, preferred so the substitute can re-bind a
 * vendor-frozen session (a real session rejects a cross-vendor swap). Returns null
 * when no enabled agent exists at all — the caller then simply keeps the run's
 * normally-resolved agent (this is no longer a launch blocker).
 */
export function resolveSandboxAgent(kind: SessionKind, vendor: VendorId): AgentConfig | null {
  const settings = loadSettings()
  const usable = (id: string): AgentConfig | undefined => {
    if (!id) return undefined
    const a = settings.agents.find((x) => x.id === id)
    return a && a.enabled !== false ? a : undefined
  }
  return (
    usable(sandboxRoleIdForKind(settings, kind)) ??
    usable(settings.sandboxDefaultAgentId) ??
    firstEnabledSandboxAgent(settings.agents, vendor) ??
    null
  )
}

/** Enabled `custom` agents of one vendor, `order_seq` order — the same-vendor
 *  switch targets offered in the sandbox-conflict dialog (a session's agent swap is
 *  vendor-frozen, so a cross-vendor target would be rejected). */
export function enabledCustomAgentsOfVendor(vendor: VendorId): AgentConfig[] {
  return loadSettings().agents.filter(
    (a) => a.enabled !== false && a.configMode === 'custom' && a.vendor === vendor,
  )
}

/**
 * Map one agent's `custom` provider config to a relay candidate — the real upstream
 * `{baseUrl, apiKey, model, wireApi?}` the relay binds behind a per-run token
 * (ADR-0029). Returns null for a `system`-mode agent or an empty base URL ⇒ no
 * relay, the vendor CLI's own login applies. `wireApi` rides only for codex (it
 * selects the relay's translate-vs-passthrough); claude is anthropic passthrough.
 */
function agentToRelayCandidate(agent: AgentConfig): RelayCandidate | null {
  if (agent.configMode !== 'custom') return null
  const { baseUrl, apiKey, model } = agent.config
  if (!baseUrl) return null
  return agent.vendor === 'codex'
    ? { baseUrl, apiKey, model, wireApi: agent.config.wireApi }
    : { baseUrl, apiKey, model }
}

/**
 * Map an ordered candidate list (one agent ⇒ length 1, a group ⇒ its members in
 * priority order) to {@link LaunchOverrides} (ADR-0029). Every `custom` member
 * becomes a relay candidate — the real key is bound behind a per-run token at the
 * spawn site, never handed to the vendor subprocess. `system`/empty members carry
 * no candidate (the CLI's own login). The CLI's fixed launch `model` is the first
 * candidate's real model (a placeholder — the relay overrides it per hit candidate);
 * with no candidate it is the first agent's standalone `model` override. Codex's
 * launch-time policy gate is derived from the session `defaultMode` in the driver
 * (2026-06-06-008), not here.
 */
export function launchForCandidates(candidates: AgentConfig[]): LaunchOverrides {
  const env: Record<string, string> = {}
  const relayCandidates: RelayCandidate[] = []
  let hasCustomClaude = false
  for (const agent of candidates) {
    const cand = agentToRelayCandidate(agent)
    if (!cand) continue
    relayCandidates.push(cand)
    if (agent.vendor === 'claude') hasCustomClaude = true
  }
  // model: the CLI's fixed launch model — the first candidate's real model, else the
  // first agent's standalone model override (read in both system and custom mode).
  const model = relayCandidates[0]?.model || candidates[0]?.config.model || undefined

  if (hasCustomClaude) {
    // WORKAROUND (remove later): recent Claude Code introduced an "adaptive thinking"
    // mechanism that changes the request message format. Third-party Anthropic-compatible
    // gateways (e.g. DeepSeek) reject that format with a 400 (`messages[].role: unknown
    // variant system`). CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 turns off just that
    // mechanism, restoring the compatible message format while keeping CLAUDE.md/memory,
    // Skills, and hooks. REMOVE once third-party providers support the new format. Only a
    // `custom` claude provider (a relay candidate) is third-party; a `system` claude
    // agent (first-party Anthropic) never sets this.
    env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = '1'
  }

  // Session subprocess proxy env vars: only inject when enabled AND the URL is
  // non-empty. Both uppercase and lowercase variants are set per convention so
  // tools that prefer one case over the other work correctly.
  const proxyCfg = getProxyConfig()
  if (proxyCfg.enabled) {
    if (proxyCfg.httpProxy) {
      env['HTTP_PROXY'] = proxyCfg.httpProxy
      env['http_proxy'] = proxyCfg.httpProxy
    }
    if (proxyCfg.httpsProxy) {
      env['HTTPS_PROXY'] = proxyCfg.httpsProxy
      env['https_proxy'] = proxyCfg.httpsProxy
    }
  }

  return {
    ...(Object.keys(env).length > 0 ? { envOverrides: env } : {}),
    ...(model ? { model } : {}),
    ...(relayCandidates.length > 0 ? { relayCandidates } : {}),
  }
}

/** Back-compat single-agent launch — a length-1 candidate list. */
export function launchForAgent(agent: AgentConfig): LaunchOverrides {
  return launchForCandidates([agent])
}

/** A claude relay binding: the ANTHROPIC env pointing the SDK at the relay + the
 *  per-run token to release when the spawn ends. */
export interface ClaudeRelayBinding {
  envOverrides: Record<string, string>
  token: string
}

/**
 * Register a claude candidate list with the process relay and build the ANTHROPIC
 * env that points the Claude SDK at the relay's anthropic endpoint with the per-run
 * token — the real key stays in the relay, never in the subprocess/sandbox
 * (ADR-0029). Returns null when no relay is wired (tests / no composition root) or
 * there are no candidates (system mode) ⇒ the caller launches with the CLI's own
 * login. The codex driver does the equivalent registration itself; this helper
 * serves the two claude spawn sites (the resident run loop and the one-shot advisor)
 * that drive the SDK directly. Release the token with {@link unbindRelay}.
 */
export function bindClaudeRelay(
  candidates: RelayCandidate[] | undefined,
): ClaudeRelayBinding | null {
  const relay = getRelay()
  if (!relay || !candidates || candidates.length === 0) return null
  const token = relay.register(candidates)
  return {
    token,
    envOverrides: {
      ANTHROPIC_BASE_URL: relay.endpoint('claude'),
      ANTHROPIC_API_KEY: token,
      ANTHROPIC_AUTH_TOKEN: token,
      NO_PROXY: withLoopbackNoProxy(process.env.NO_PROXY),
      no_proxy: withLoopbackNoProxy(process.env.no_proxy),
    },
  }
}

/** Release a relay token bound by {@link bindClaudeRelay} (run/one-shot teardown). */
export function unbindRelay(token: string): void {
  getRelay()?.unregister(token)
}

/**
 * The enabled agents that make up a group `(vendor, group)`, in priority order
 * (`order_seq` ascending). The group identity carries the vendor (ADR-0029), so
 * DIFFERENT vendors may reuse the same group name — each is a distinct group. Empty
 * when no enabled agent of that vendor carries that group.
 */
export function groupAgents(
  vendor: VendorId,
  group: string,
  settings: SystemSettings = loadSettings(),
): AgentConfig[] {
  return enabledAgents(settings).filter(
    (a) => a.vendor === vendor && (a.group?.trim() ?? '') === group,
  )
}

/**
 * Enumerate the virtual group agents (`_c3_<vendor>_<group>`, ADR-0029): for each
 * distinct `(vendor, group)` among enabled agents (in `order_seq` order), one entry.
 * The single source every agent-selection point on the server draws group options
 * from (e.g. the session agent switcher). `id`/`displayName` are both the prefixed ref
 * so the group reads as `_c3_<vendor>_<group>`.
 */
export function enumerateGroupAgents(
  settings: SystemSettings = loadSettings(),
): Array<{ id: string; group: string; vendor: VendorId }> {
  const seen = new Map<string, { id: string; group: string; vendor: VendorId }>()
  for (const a of enabledAgents(settings)) {
    const g = a.group?.trim()
    if (!g) continue
    const id = groupAgentRef(a.vendor, g)
    if (!seen.has(id)) seen.set(id, { id, group: g, vendor: a.vendor })
  }
  return [...seen.values()]
}

/**
 * Resolve an agent reference to its ordered candidate list (ADR-0029):
 *  - a real id             → `[that agent]` (length 1)
 *  - `_c3_<vendor>_<group>` → that `(vendor, group)`'s enabled members, priority order
 *  - unknown / empty group  → the default-agent fallback (length 1)
 * Never empty — a group that resolved to nothing falls back like {@link resolveAgent}.
 * A plain (non-group) agent is the degenerate length-1 candidate list, sharing the
 * same launch/failover path as a group.
 */
export function resolveAgentCandidates(ref: string | null): AgentConfig[] {
  const g = ref ? parseGroupAgentRef(ref) : null
  if (g) {
    const members = groupAgents(g.vendor, g.group)
    return members.length > 0 ? members : [resolveAgent(null)]
  }
  return [resolveAgent(ref)]
}

/**
 * Resolve a reference (real id / `_c3_<vendor>_<group>` / empty) to its bound agent id
 * plus candidate launch overrides. A group reference stays bound as the agent id so
 * every run re-resolves the group and re-failovers from its highest-priority member; a
 * real reference binds to the resolved (fallback-applied) id.
 */
function resolveLaunchForRef(ref: string | null): { agentId: string } & LaunchOverrides {
  const candidates = resolveAgentCandidates(ref)
  const g = ref ? parseGroupAgentRef(ref) : null
  const agentId = g && groupAgents(g.vendor, g.group).length > 0 ? ref! : candidates[0].id
  return { agentId, ...launchForCandidates(candidates) }
}

/**
 * Resolve how to launch a session: its bound agent (real id or `_c3_<group>`) mapped
 * to the candidate launch overrides. A group binding re-resolves + re-failovers each run.
 */
export function resolveSessionLaunch(
  sessionId: string | null,
): { agentId: string } & LaunchOverrides {
  return resolveLaunchForRef(sessionId ? getSessionAgentId(sessionId) : null)
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
 * The frozen store scope of a session (ADR-0015), for the read/resume path. A
 * real session returns its frozen scope; anything without a fact (pending or
 * unknown) defaults to `'host'` — a session that never ran has no transcript to
 * locate, and every legacy session lived on the host. Sibling of
 * {@link resolveSessionVendor}; a thin pass-through to the vendor-blind store.
 */
export function resolveSessionStoreScope(sessionId: string | null): StoreScope {
  return sessionId ? getSessionStoreScope(sessionId) : 'host'
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
 * mirror the bind into the `session_metadata` projection (F-5). The kernel
 * itself does not import the store (kernel ↛ features boundary, ADR-0009);
 * the composition root wires `onBind` to `upsertForBind` in the store.
 */
export function freezeSessionAgent(
  pendingId: string,
  realId: string,
  agentId: string,
  workspacePath: string,
  storeScope: StoreScope,
): void {
  const resolved = resolveAgent(agentId)
  // Preserve a virtual group binding (`_c3_<group>`, ADR-0029): the session stays
  // bound to the group so every future run re-resolves it and re-failovers from the
  // highest-priority member. The frozen vendor is the group's locked vendor (the
  // resolved representative member's vendor). A real ref binds to the resolved id.
  const boundId = isGroupAgentRef(agentId) ? agentId : resolved.id
  // storeScope is frozen alongside the vendor: whether this first run was
  // sandboxed decides which native data root holds the transcript for its life.
  bindSessionAgent(pendingId, realId, boundId, resolved.vendor, storeScope)
  onBind?.({
    pendingId,
    realId,
    workspacePath,
    vendor: resolved.vendor,
    agentId: boundId,
    storeScope,
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
        // Preserve a virtual group ref (`_c3_<group>`) so the pending session
        // re-resolves the group each run (ADR-0029); a real ref uses the resolved id.
        agentId: isGroupAgentRef(agentId) ? agentId : resolved.id,
      })
    }
    return { ok: true }
  }
  if (agentId === null || agentId === '') return { ok: false }
  const resolved = resolveAgent(agentId)
  const boundId = isGroupAgentRef(agentId) ? agentId : resolved.id
  const ok = changeSessionAgentFact(sessionId, boundId, resolved.vendor)
  if (ok) {
    onAgentSwap?.({
      scope: 'real',
      sessionId,
      vendor: resolved.vendor,
      agentId: boundId,
    })
  }
  return { ok }
}

// ---- Composition-time hooks (kernel ↛ features boundary) ----
//
// The kernel layer doesn't import from `features/`, so write-throughs into
// the `session_metadata` projection table go through these registered
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
  /** Frozen transcript store scope for this bind (host vs sandbox run). */
  storeScope: StoreScope
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
  return resolveLaunchForRef(chain[chainIndex])
}

/**
 * The **shared consensus participant selector** — the single source every
 * consensus consumer (tool-permission voting, `AskUserQuestion` voting, and the
 * automation checkpoint vote) resolves its voters from: every *enabled* agent
 * except the one the session itself runs on (`currentAgentId`, already resolved).
 * Disabled agents never vote. Selection is **vendor-neutral** — voters may be of
 * any vendor. Cross-vendor tool-permission requests are made comparable by the
 * server's risk normalizer (a vendor-neutral intent + risk payload) before fan-out,
 * NOT by restricting who votes; `AskUserQuestion` and the checkpoint prompt are
 * already vendor-neutral.
 *
 * `consensus` optionally narrows the set: with `mode: 'custom'` only agents whose
 * id is in `consensus.agentIds` vote (intersected with the enabled non-self set);
 * the allowlist filters by id only, never by vendor. Absent / `mode: 'all'` keeps
 * the full enabled non-self set. A stale/disabled id in `agentIds` is silently a
 * no-op (the set is already the enabled non-self agents). Empty result ⇒ consensus
 * is skipped and the human is prompted as usual (the no-voter fallback).
 *
 * Distinct from {@link sameVendorEnabledAgents} — the manual agent switcher and
 * the degradation chain remain vendor-homogeneous (a different vendor cannot carry
 * a session's context), so they keep their own same-vendor rule; only consensus
 * voting crosses the vendor boundary.
 */
export function selectConsensusVoters(
  currentAgentId: string | null,
  consensus?: Pick<ConsensusConfig, 'mode' | 'agentIds'>,
): AgentConfig[] {
  const others = enabledAgents().filter((a) => a.id !== currentAgentId)
  if (consensus?.mode === 'custom') {
    const allow = new Set(consensus.agentIds ?? [])
    return others.filter((a) => allow.has(a.id))
  }
  return others
}

/**
 * The **same-vendor candidate rule** (2026-06-06-006 vendor-homogeneity), the
 * single source the manual agent switcher and the degradation chain's homogeneity
 * agree on: every *enabled* agent of `vendorScope` except `excludeId` (the
 * session's own agent). Cross-vendor agents are never candidates — a different
 * vendor cannot carry context (no `resume`), so neither switching nor fallback may
 * cross the frozen vendor boundary. (Consensus voting no longer uses this rule — it
 * selects across vendors via {@link selectConsensusVoters}.)
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
  const rawId = getSessionAgentId(sessionId)
  // A group-bound session (`_c3_<vendor>_<group>`, ADR-0029) shows the GROUP as its
  // current agent (id/display = the ref itself); its representative member's vendor is
  // the frozen vendor. A real binding shows the agent itself.
  const group = rawId ? parseGroupAgentRef(rawId) : null
  const current = resolveAgent(rawId)
  const vendor = current.vendor
  const currentId = group ? rawId! : current.id
  // A group shows as its prefixed ref `_c3_<vendor>_<group>`; a real agent as its name.
  const currentName = group ? rawId! : current.displayName
  // Candidates: the other same-vendor real agents PLUS the same-vendor virtual group
  // agents (so a session can be switched onto a group — relay failover). Group refs
  // read as `_c3_<vendor>_<group>`. The current binding (real id or group ref) is excluded.
  const realCandidates = sameVendorEnabledAgents(vendor, group ? null : current.id)
    .filter((a) => presentVendors.has(a.vendor))
    .map((a) => ({ id: a.id, displayName: a.displayName }))
  const groupCandidates = enumerateGroupAgents()
    .filter((g) => g.vendor === vendor && g.id !== currentId && presentVendors.has(g.vendor))
    .map((g) => ({ id: g.id, displayName: g.id }))
  const candidates = [...realCandidates, ...groupCandidates]
  const currentUnavailable = !presentVendors.has(vendor)
  return {
    current: { id: currentId, displayName: currentName },
    candidates,
    currentUnavailable,
  }
}
