/**
 * Agent resolution + degradation chain (server refactor 3/3, ADR-0009 — sunk from
 * the old root `settings.ts`).
 *
 * An *agent* is a vendor-agnostic shell + a `vendor`-discriminated `config`.
 * Connection comes from a named {@link ModelProvider} (`providerId`) or the
 * vendor CLI's own login — agents do not carry their own baseUrl/apiKey.
 * A session launches using its assigned agent, or the default agent when
 * unassigned (see {@link resolveSessionLaunch}). The built-in system agent
 * ({@link SYSTEM_AGENT_ID}) always exists as a claude agent with an empty
 * default config, and cannot be removed — binding to it means "no overrides,
 * use the SDK defaults".
 *
 * These readers call `loadSettings` / `getSessionAgentId` from `kernel/config`
 * (the persistence store); the pure agent-shape normalizers come from
 * `./normalize` (a leaf). config → normalize and readers → config + normalize,
 * so the boundary stays acyclic.
 */
import { createHash } from 'node:crypto'
import type {
  AgentConfig,
  ConsensusConfig,
  ModelProvider,
  SessionAgentSwitch,
  StoreScope,
  SystemSettings,
  VendorId,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID, hasProviderConfig } from '@ccc/shared/protocol'
import type { ConnectionWarning } from './provider-resolve.js'
import {
  resolveAgentConnection,
  resolveModelCaps,
  takeFreshConnectionWarnings,
} from './provider-resolve.js'
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
  /**
   * Optional model capabilities (2026-08-08-013), read from the FIRST
   * relay-capable leading-segment member's codex config (the member whose model
   * the CLI launches with). When set, the codex driver's relay branch registers
   * the model in a local catalog (`model_catalog_json`) so codex stops falling
   * back to default metadata for an id it does not know. Absent ⇒ no catalog,
   * current behaviour. Only a `custom` codex member produces them — a system
   * member (no relay candidate) never does.
   */
  contextWindow?: number
  /** Optional max output tokens — same catalog mechanism as {@link LaunchOverrides.contextWindow}. */
  maxOutputTokens?: number
}
import {
  bindSessionAgent,
  changeSessionAgentFact,
  getProxyConfig,
  getSessionAgentId,
  getSessionGroupCursor,
  getSessionStoreScope,
  loadSettings,
  saveSettings,
  setPendingIntent,
  setSessionGroupCursor,
} from '../config/index.js'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { systemAgent } from './normalize.js'
import {
  AgentGroupUnavailableError,
  ModelProviderPausedError,
  isModelProviderPausedError,
} from './errors.js'

export {
  AGENT_ICON_MAX_CHARS,
  defaultSettings,
  normalizeDegradationChain,
  normalizeIcon,
  systemAgent,
} from './normalize.js'
export {
  AgentGroupUnavailableError,
  ModelProviderPausedError,
  isAgentGroupUnavailableError,
  isModelProviderPausedError,
  isDegradableError,
  isSocketDisconnect,
} from './errors.js'
export { resolveAgentConnection, resolveModelCaps } from './provider-resolve.js'
export type { ConnectionResolution, ConnectionWarning } from './provider-resolve.js'
export { parseQuotaResetAt } from './quota-reset.js'

export function getDefaultAgentId(): string {
  return loadSettings().defaultAgentId
}

/**
 * The five agent ROLES a session can be launched for. `default` is the fallback
 * every other role follows when its own field is the empty "follow the default"
 * sentinel; the other four are the dedicated slots (background tool sessions,
 * intent communication, spec authoring, spec review). One enum + one field map
 * ({@link ROLE_SETTINGS_FIELD}) is what keeps the four dedicated roles from each
 * re-implementing the resolution rules.
 */
export type AgentRole = 'default' | 'tool' | 'intent' | 'spec' | 'spec_review'

/** Which `SystemSettings` field carries each role's configured reference. */
const ROLE_SETTINGS_FIELD: Record<AgentRole, keyof SystemSettings> = {
  default: 'defaultAgentId',
  tool: 'toolAgentId',
  intent: 'intentAgentId',
  spec: 'specAgentId',
  spec_review: 'specReviewAgentId',
}

/**
 * A resolved agent target — the pair every binding site needs:
 *
 *  - `ref` is the **routing identity to persist**: the group reference
 *    `_c3_<vendor>_<group>` when the target is a group (so every later run
 *    re-resolves the group and re-failovers through it), else the concrete agent
 *    id (fallbacks already applied).
 *  - `agent` is the **representative member** — the first enabled member in
 *    `order_seq` order for a group, the agent itself otherwise. Vendor, display
 *    info, default mode and the first launch's parameters ALL derive from it, so a
 *    binding can never pair a group ref with another agent's vendor.
 *  - `candidates` is the ordered launch candidate list handed to the relay.
 *
 * Never carries an unusable group: resolution fails loudly instead
 * ({@link AgentGroupUnavailableError}).
 */
export interface AgentTarget {
  ref: string
  agent: AgentConfig
  candidates: AgentConfig[]
  isGroup: boolean
}

/** The non-throwing form of {@link resolveAgentTarget}: the target, or the
 *  unusable group reference that stopped it. */
export type AgentTargetResult = { ok: true; target: AgentTarget } | { ok: false; groupRef: string }

/** A concrete (non-group) agent as a degenerate one-candidate target. */
function singleTarget(agent: AgentConfig): AgentTarget {
  return { ref: agent.id, agent, candidates: [agent], isGroup: false }
}

/**
 * A group reference as a target: its enabled members in `order_seq` order, the
 * first one representing the group. Throws when the group has no enabled member —
 * an empty group is a configuration error, NOT a reason to fall back.
 *
 * `cursor` (a member id) rotates the list so that member leads — the resume-time
 * half of group failover (ADR-0029): a run that died on a degradable error moves
 * the session's cursor on, and the next launch starts from there. The list is a
 * RING, so every member stays reachable from any cursor; an unknown cursor (its
 * agent was removed or left the group) simply falls back to the natural order.
 */
function groupTarget(
  groupRef: string,
  vendor: VendorId,
  group: string,
  cursor?: string | null,
): AgentTarget {
  const members = rotateToCursor(groupAgents(vendor, group), cursor)
  if (members.length === 0) throw new AgentGroupUnavailableError(groupRef)
  return { ref: groupRef, agent: members[0], candidates: members, isGroup: true }
}

/** A group's members with `cursor`'s member rotated to the front (ring order). */
function rotateToCursor(members: AgentConfig[], cursor?: string | null): AgentConfig[] {
  if (!cursor) return members
  const at = members.findIndex((a) => a.id === cursor)
  return at <= 0 ? members : [...members.slice(at), ...members.slice(0, at)]
}

/**
 * **The single agent-reference resolver** every role and every session binding
 * goes through. One rule set, applied in order:
 *
 *  1. a group reference (`_c3_<vendor>_<group>`) ⇒ that group's target;
 *  2. a known concrete agent id ⇒ that agent;
 *  3. empty (the "follow the default" sentinel) or an unknown id ⇒ follow
 *     `defaultAgentId`, applying rules 1–2 to it — so a GROUP default resolves as a
 *     group instead of being skipped by an id lookup that can never match a virtual
 *     reference;
 *  4. no usable default ⇒ the system agent, else the synthesized fallback (the
 *     "settings empty/corrupt" safety net that keeps c3 launchable).
 *
 * Throws {@link AgentGroupUnavailableError} when the target — direct or reached via
 * the default — is a group with no enabled member. That failure is deliberately NOT
 * absorbed into rule 4: falling back would hide an actionable misconfiguration
 * behind an agent the user never chose.
 */
export function resolveAgentTarget(ref: string | null, cursor?: string | null): AgentTarget {
  const settings = loadSettings()
  const wanted = ref?.trim() ?? ''
  if (wanted) {
    const g = parseGroupAgentRef(wanted)
    if (g) return groupTarget(wanted, g.vendor, g.group, cursor)
    const byId = settings.agents.find((a) => a.id === wanted)
    if (byId) return singleTarget(byId)
  }
  // Follow the default: the empty-role sentinel AND the unknown-id compat chain.
  const fallbackId = settings.defaultAgentId?.trim() ?? ''
  if (fallbackId) {
    const dg = parseGroupAgentRef(fallbackId)
    if (dg) return groupTarget(fallbackId, dg.vendor, dg.group, cursor)
    const byDefault = settings.agents.find((a) => a.id === fallbackId)
    if (byDefault) return singleTarget(byDefault)
  }
  return singleTarget(settings.agents.find((a) => a.id === SYSTEM_AGENT_ID) ?? systemAgent())
}

/**
 * {@link resolveAgentTarget} without the throw — for the callers that must DECIDE
 * on an unusable group (refuse a session creation with a structured error) or
 * survive one (display/projection reads of an already-bound session).
 */
export function tryResolveAgentTarget(
  ref: string | null,
  cursor?: string | null,
): AgentTargetResult {
  try {
    return { ok: true, target: resolveAgentTarget(ref, cursor) }
  } catch (err) {
    if (err instanceof AgentGroupUnavailableError) return { ok: false, groupRef: err.groupRef }
    throw err
  }
}

/** The configured reference for a role — `''` for the "follow the default" sentinel. */
export function getRoleAgentId(role: AgentRole): string {
  const raw = loadSettings()[ROLE_SETTINGS_FIELD[role]]
  return typeof raw === 'string' ? raw : ''
}

/**
 * A ROLE's agent target — the entry every session-creation path binds from. All
 * five roles share {@link resolveAgentTarget}, so "role field set to a group" and
 * "role field empty, default is a group" land on the SAME target. Throws
 * {@link AgentGroupUnavailableError} for an unusable group.
 */
export function resolveRoleAgentTarget(role: AgentRole): AgentTarget {
  return resolveAgentTarget(getRoleAgentId(role) || null)
}

/** {@link resolveRoleAgentTarget} without the throw (see {@link tryResolveAgentTarget}). */
export function tryResolveRoleAgentTarget(role: AgentRole): AgentTargetResult {
  return tryResolveAgentTarget(getRoleAgentId(role) || null)
}

/**
 * The vendor behind a reference, resolved without ever throwing: the
 * representative member's vendor, or — for an unusable group — the vendor the
 * group reference itself encodes (a group is vendor-locked, so this is still the
 * session's real vendor). For display/projection reads that must stay renderable
 * while the configuration is broken.
 */
export function resolveAgentVendor(ref: string | null): VendorId {
  const result = tryResolveAgentTarget(ref)
  return result.ok
    ? result.target.agent.vendor
    : (parseGroupAgentRef(result.groupRef)?.vendor ?? 'claude')
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
 * The configured spec-REVIEW agent id (read-only review sessions' executor). An
 * empty string means "follow the default agent" — see {@link resolveSpecReviewAgent}.
 */
export function getSpecReviewAgentId(): string {
  return loadSettings().specReviewAgentId
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
 * The single-agent view of a reference — {@link resolveAgentTarget}'s
 * representative member. A virtual group reference (`_c3_<vendor>_<group>`), given
 * directly or reached by following a GROUP `defaultAgentId`, resolves to that
 * group's highest-priority enabled member (for vendor/model display and the
 * single-agent callers).
 *
 * Throws {@link AgentGroupUnavailableError} when that group has no enabled member:
 * an empty group is a configuration error and must not degrade into the system
 * agent. Callers that cannot fail (display, projection reads) use
 * {@link tryResolveAgentTarget} / {@link resolveAgentVendor} instead.
 */
export function resolveAgent(agentId: string | null): AgentConfig {
  return resolveAgentTarget(agentId).agent
}

/**
 * The agent that runs **background tool sessions** (completion judge, session
 * summary; the exception-handling session is not yet agent-driven — reserved for
 * a follow-up intent). The single-agent view of
 * `resolveRoleAgentTarget('tool')`, so the fall-through is `toolAgentId →
 * defaultAgentId → system → synthesized fallback` and a group on either end
 * resolves to its representative member.
 */
export function resolveToolAgent(): AgentConfig {
  return resolveRoleAgentTarget('tool').agent
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
 * requirement-breakdown conversation). The single-agent view of
 * `resolveRoleAgentTarget('intent')` — same rules as {@link resolveToolAgent}, so
 * `intentAgentId → defaultAgentId → system → synthesized fallback` with a group on
 * either end resolving to its representative member.
 */
export function resolveIntentAgent(): AgentConfig {
  return resolveRoleAgentTarget('intent').agent
}

/**
 * The agent that runs **spec-authoring sessions** (writing/refining the project
 * specification). The single-agent view of `resolveRoleAgentTarget('spec')`;
 * mirrors {@link resolveIntentAgent} exactly.
 */
export function resolveSpecAgent(): AgentConfig {
  return resolveRoleAgentTarget('spec').agent
}

/**
 * The agent that runs **spec-REVIEW sessions** (the read-only reviewer). The
 * single-agent view of `resolveRoleAgentTarget('spec_review')`; mirrors
 * {@link resolveSpecAgent} exactly. There is no sandbox variant —
 * `sandboxSessionKinds` alone decides whether a review session runs inside the
 * sandbox.
 */
export function resolveSpecReviewAgent(): AgentConfig {
  return resolveRoleAgentTarget('spec_review').agent
}

/**
 * The provider registry every launch resolution reads. Split out so the resolution
 * helpers below stay one `loadSettings()` away from the pure
 * {@link resolveAgentConnection} — which takes the registry as an argument, so it
 * can also answer "what WOULD this agent connect to" for an unsaved console edit.
 */
function providerRegistry(): readonly ModelProvider[] {
  return loadSettings().modelProviders ?? []
}

/**
 * Report a connection resolution's warnings once while the misconfiguration
 * persists. The same (agent, warning, config fingerprint) is logged once so a
 * busy launch path cannot bury the rest of the log; when the condition clears —
 * or the underlying provider config actually changes — the remembered key
 * is dropped so a later recurrence re-alerts.
 */
const reportedConnectionWarnings = new Set<string>()

/**
 * Fingerprint of the resolution-relevant config: provider identity + its current
 * urls/key/paused bit. Two resolutions with the same warning kind but a different
 * fingerprint (e.g. dangling id rewritten, urls emptied again after a brief fix)
 * are treated as a new episode.
 */
function connectionWarningFingerprint(
  agent: AgentConfig,
  providers: readonly ModelProvider[],
): string {
  const providerId = agent.providerId?.trim() ?? ''
  const provider = providerId ? providers.find((p) => p.id === providerId) : undefined
  const providerPart = provider
    ? [
        provider.paused ? '1' : '0',
        provider.apiKey,
        // Manual join — kernel must not JSON.stringify (transport concern).
        `openai=${provider.urls.openai ?? ''}`,
        `anthropic=${provider.urls.anthropic ?? ''}`,
        provider.wireApi ?? '',
      ].join('\0')
    : 'missing'
  const raw = `${providerId}\0${providerPart}`
  // Hashed so the account/provider keys embedded above never sit in plaintext in
  // this module-level, process-lifetime `Set` — a heap dump or debug print of it
  // would otherwise hand out live credentials for free. Collision-freedom is not
  // the point here (only de-duping a warning), so a short digest is enough.
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function reportConnectionWarnings(
  agent: AgentConfig,
  warnings: readonly ConnectionWarning[],
  providers: readonly ModelProvider[],
): void {
  const fresh = takeFreshConnectionWarnings(
    reportedConnectionWarnings,
    agent.id,
    warnings,
    connectionWarningFingerprint(agent, providers),
  )
  for (const w of fresh) {
    switch (w.kind) {
      case 'dangling-provider':
        console.warn(
          `[c3] agent "${agent.id}" references unknown model provider "${w.providerId}" — falling back to CLI login.`,
        )
        break
      case 'provider-paused':
        console.warn(
          `[c3] agent "${agent.id}" references paused model provider "${w.providerId}" — launches will fail until it is resumed.`,
        )
        break
      case 'provider-unusable':
        console.warn(
          `[c3] model provider "${w.providerId}" has no usable URL for agent "${agent.id}" (${w.vendor}) — falling back to CLI login.`,
        )
        break
    }
  }
}

/**
 * Map one agent's upstream connection to a relay candidate — the real upstream
 * `{baseUrl, apiKey, model, wireApi?}` the relay binds behind a per-run token
 * (ADR-0029). The connection comes from the referenced {@link ModelProvider} when
 * the agent carries a `providerId` ({@link resolveAgentConnection}). Returns null
 * when the provider yields no base URL ⇒ no relay, the vendor CLI's own login
 * applies. `wireApi` rides only for codex (it selects the relay's
 * translate-vs-passthrough); claude is anthropic passthrough.
 *
 * Throws {@link ModelProviderPausedError} when the referenced provider is paused:
 * an operator took that upstream out of service, so a launch through it must fail
 * with the provider named rather than degrade to somewhere unintended.
 */
function agentToRelayCandidate(
  agent: AgentConfig,
  providers: readonly ModelProvider[],
): RelayCandidate | null {
  // Cursor has no relay: c3 speaks neither its wire protocol nor its auth, and
  // its config carries no provider triple. Refusing here is what stops a
  // mis-tagged agent from being handed the Anthropic relay by the endpoint
  // default and failing with an unrelated error.
  if (!hasProviderConfig(agent)) return null
  const resolved = resolveAgentConnection(agent, providers)
  reportConnectionWarnings(agent, resolved.warnings, providers)
  const paused = resolved.warnings.find((w) => w.kind === 'provider-paused')
  if (paused) throw new ModelProviderPausedError(paused.providerId, agent.id)
  if (!resolved.connection) return null
  const { baseUrl, apiKey, wireApi } = resolved.connection
  const model = agent.config.model
  return agent.vendor === 'codex' ? { baseUrl, apiKey, model, wireApi } : { baseUrl, apiKey, model }
}

/**
 * Non-throwing sibling of {@link agentToRelayCandidate}, for a candidate being only
 * PROBED — a group failover peer behind the leading member, or a degradation-chain
 * fallback that may never actually run. A paused provider there must not abort
 * resolution for the leading/currently-attempted agent: it is reported the same as
 * "no connection" (the peer drops out of consideration), exactly like a peer with a
 * missing base URL. {@link agentToRelayCandidate} keeps the throw for the ONE
 * candidate actually being selected to launch — that case must surface loudly, not
 * degrade to system mode.
 */
function probeRelayCandidate(
  agent: AgentConfig,
  providers: readonly ModelProvider[],
): RelayCandidate | null {
  try {
    return agentToRelayCandidate(agent, providers)
  } catch (err) {
    if (isModelProviderPausedError(err)) return null
    throw err
  }
}

/**
 * The LEADING SEGMENT of a candidate list — the part one launch can actually serve
 * (ADR-0029). Whether a run goes through the relay is decided once, at spawn: the
 * provider endpoint is baked into the subprocess env (`ANTHROPIC_BASE_URL`, codex's
 * `model_provider`), so a single launch cannot cross between "relayed custom
 * provider" and "the CLI's own login". The segment is therefore:
 *
 *  - leading member is relay-capable ⇒ it plus every relay-capable member that
 *    directly follows (the relay fails over inside this run, before the first byte);
 *  - leading member is not (a `system` agent, or a vendor with no provider triple)
 *    ⇒ just that member, launched on the CLI's own login.
 *
 * The leading member is ALWAYS used. Collecting every relay-capable member instead
 * would silently skip a leading `system` member and run somewhere the user did not
 * put first — the visible order would stop matching what runs. Crossing the segment
 * boundary is the resume path's job (the session's group cursor).
 *
 * Only `candidates[0]` — the leading member, the one actually selected to launch —
 * is probed with the throwing {@link agentToRelayCandidate}: a paused provider there
 * is a real launch failure and must surface as one. Every other member is scanned
 * with the non-throwing {@link probeRelayCandidate}, so a paused PEER further down
 * the list just ends the segment there (same as a peer with no connection at all)
 * instead of aborting resolution for the healthy leading member.
 */
export function launchSegment(
  candidates: AgentConfig[],
  providers: readonly ModelProvider[] = providerRegistry(),
): AgentConfig[] {
  if (candidates.length === 0) return candidates
  if (!agentToRelayCandidate(candidates[0], providers)) return [candidates[0]]
  const end = candidates.findIndex((a) => !probeRelayCandidate(a, providers))
  return end < 0 ? candidates : candidates.slice(0, end)
}

/**
 * Map an ordered candidate list (one agent ⇒ length 1, a group ⇒ its members in
 * priority order) to {@link LaunchOverrides} (ADR-0029). Only the list's leading
 * segment ({@link launchSegment}) takes part in this launch; each of its `custom`
 * members becomes a relay candidate — the real key is bound behind a per-run token
 * at the spawn site, never handed to the vendor subprocess. A leading `system`
 * member yields no candidate at all, so the run uses the CLI's own login. The CLI's
 * fixed launch `model` is the first candidate's real model (a placeholder — the
 * relay overrides it per hit candidate); with no candidate it is the leading agent's
 * standalone `model` override. Codex's launch-time policy gate is derived from the
 * session `defaultMode` in the driver (2026-06-06-008), not here.
 */
export function launchForCandidates(candidates: AgentConfig[]): LaunchOverrides {
  const env: Record<string, string> = {}
  const relayCandidates: RelayCandidate[] = []
  let hasCustomClaude = false
  // The first relay-capable leading-segment member — the agent whose model the CLI
  // launches with. Its codex config's optional capability fields ride the overrides
  // (2026-08-08-013); a system member (no candidate) has none, so no catalog is
  // ever produced for a system launch.
  let firstRelayAgent: AgentConfig | undefined
  const providers = providerRegistry()
  const segment = launchSegment(candidates, providers)
  for (const agent of segment) {
    const cand = agentToRelayCandidate(agent, providers)
    if (!cand) continue
    if (!firstRelayAgent) firstRelayAgent = agent
    relayCandidates.push(cand)
    if (agent.vendor === 'claude') hasCustomClaude = true
  }
  // model: the CLI's fixed launch model — the first candidate's real model, else the
  // leading agent's standalone model override (read in both system and custom mode).
  const model = relayCandidates[0]?.model || segment[0]?.config.model || undefined
  // Only a `codex` agent carries model capability fields; other vendors have none,
  // so the spread below stays empty for them. The values are resolved most-specific
  // first — the agent's own `modelOverrides`, then the provider's model catalog,
  // then the agent's own codex config (see `resolveModelCaps`).
  const codexCaps =
    firstRelayAgent?.vendor === 'codex'
      ? resolveModelCaps(firstRelayAgent, providers, model ?? firstRelayAgent.config.model)
      : {}

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
    ...(codexCaps.contextWindow !== undefined ? { contextWindow: codexCaps.contextWindow } : {}),
    ...(codexCaps.maxOutputTokens !== undefined
      ? { maxOutputTokens: codexCaps.maxOutputTokens }
      : {}),
  }
}

/**
 * Whether this agent runs on the VENDOR CLI's OWN login (a subscription / the
 * vendor's system config) rather than an upstream c3 relays for it. The question
 * every sandbox and transcript-location decision actually asks — a run on the
 * vendor's own login needs the host credential store opened and writes its
 * transcript where the vendor's host config lives.
 *
 * Asking the resolver, not `configMode === 'system'`: a dangling or paused
 * provider still reads as `'custom'` but has no connection, and those runs must
 * follow the vendor-login path (or fail loudly) rather than invent an upstream.
 */
export function usesVendorLogin(agent: AgentConfig): boolean {
  if (!hasProviderConfig(agent)) return true
  return resolveAgentConnection(agent, providerRegistry()).connection === null
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
 *  - a real id              → `[that agent]` (length 1)
 *  - `_c3_<vendor>_<group>`  → that `(vendor, group)`'s enabled members, priority order
 *  - unknown / empty         → the default-agent target's candidates
 * Never empty. A group with no enabled member throws
 * {@link AgentGroupUnavailableError} instead of degrading to another agent — every
 * run re-expands the group, so a group that lost its last member must fail visibly
 * rather than run somewhere the user never configured.
 */
export function resolveAgentCandidates(ref: string | null): AgentConfig[] {
  return resolveAgentTarget(ref).candidates
}

/**
 * Resolve a reference (real id / `_c3_<vendor>_<group>` / empty) to its bound agent id
 * plus candidate launch overrides. A group reference stays bound as the agent id so
 * every run re-resolves the group and re-failovers from its highest-priority member; a
 * real reference binds to the resolved (fallback-applied) id.
 */
function resolveLaunchForRef(ref: string | null): { agentId: string } & LaunchOverrides {
  const target = resolveAgentTarget(ref)
  return { agentId: target.ref, ...launchForCandidates(target.candidates) }
}

/**
 * Resolve how to launch a session: its bound agent (real id or `_c3_<group>`) mapped
 * to the candidate launch overrides. A group binding re-resolves + re-failovers each
 * run, starting from the session's group cursor — so a resume after a degradable
 * failure picks up at the next candidate rather than re-hitting the failed one.
 */
export function resolveSessionLaunch(
  sessionId: string | null,
): { agentId: string } & LaunchOverrides {
  if (!sessionId) return resolveLaunchForRef(null)
  const target = resolveAgentTarget(getSessionAgentId(sessionId), getSessionGroupCursor(sessionId))
  return { agentId: target.ref, ...launchForCandidates(target.candidates) }
}

/**
 * Advance a session's group failover cursor past the segment that just ran, so the
 * next launch starts on the next candidate (ADR-0029). No-op unless the session is
 * bound to a group that still resolves — a plain agent has nothing to advance
 * through, and a group that lost every member is reported where it is actionable,
 * not from an error handler. Returns the member the next launch will lead with, or
 * null when nothing moved. Wrapping past the last member is intended: the group is
 * a ring, so a session is never stranded on an exhausted tail.
 */
export function advanceGroupCursor(sessionId: string): string | null {
  const ref = getSessionAgentId(sessionId)
  if (!ref || !parseGroupAgentRef(ref)) return null
  const result = tryResolveAgentTarget(ref, getSessionGroupCursor(sessionId))
  if (!result.ok || !result.target.isGroup) return null
  // `candidates` is already rotated to the current cursor, so the next lead is
  // simply the member just past this run's segment.
  const { candidates } = result.target
  if (candidates.length < 2) return null
  const next = candidates[launchSegment(candidates).length % candidates.length]
  setSessionGroupCursor(sessionId, next.id)
  return next.id
}

/**
 * The agent binding a session actually carries — the `{agentId, vendor}` PAIR
 * derived from one read of its binding (a real session's frozen fact, a pending
 * session's intent, else the default-agent fallback). The single source every
 * display/projection consumer must derive BOTH halves from: reading the id from
 * the current settings while reading the vendor from the session would mint a
 * split row (`agent_id` of one agent, `vendor` of another) that no launch can
 * honour. Group refs (`_c3_<vendor>_<group>`, ADR-0029) stay refs, matching
 * {@link resolveSessionLaunch}'s binding rule.
 *
 * DISPLAY-SAFE by design: a session whose group lost its last enabled member keeps
 * its own identity here (the group ref + the vendor that ref encodes) instead of
 * throwing. The configuration error is raised where it is actionable — creating or
 * (re)binding a session, and launching a run — not while rendering a session that
 * already exists.
 */
export function resolveSessionAgentBinding(sessionId: string | null): {
  agentId: string
  vendor: VendorId
} {
  const ref = sessionId ? getSessionAgentId(sessionId) : null
  // No fact: a session that ran through a path which never froze one (historical
  // automation sessions are the known case). Falling straight through to the
  // DEFAULT agent would report SOMEBODY ELSE'S vendor — a codex automation
  // rendering as claude — while the session list, reading the projection, shows the
  // real one. So consult the projection first: its row was written by the run that
  // owns this session, which makes it a weaker but still first-hand record of the
  // same binding. The vendor comes from the ROW (authoritative even when the row
  // carries no agent id); the agent id is resolved through the normal target rules.
  if (!ref && sessionId && !sessionId.startsWith(PENDING_SESSION_PREFIX)) {
    const projected = onSessionBindingFallback?.(sessionId) ?? null
    if (projected) return { agentId: projected.agentId, vendor: projected.vendor }
  }
  const result = tryResolveAgentTarget(ref)
  if (result.ok) return { agentId: result.target.ref, vendor: result.target.agent.vendor }
  return {
    agentId: ref ?? result.groupRef,
    vendor: parseGroupAgentRef(result.groupRef)?.vendor ?? 'claude',
  }
}

/**
 * The vendor a session will (or did) run on (ADR-0015), for display: a real
 * session resolves to its bound agent's vendor; a pending session to its intent's
 * (or, when Auto, the default agent's) vendor. Always returns a vendor — it falls
 * back through {@link resolveAgent} exactly like {@link resolveSessionLaunch}.
 */
export function resolveSessionVendor(sessionId: string | null): VendorId {
  return resolveSessionAgentBinding(sessionId).vendor
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
  // Preserve a virtual group binding (`_c3_<group>`, ADR-0029): the session stays
  // bound to the group so every future run re-resolves it and re-failovers from the
  // highest-priority member. The frozen vendor is the group's locked vendor (the
  // resolved representative member's vendor). A real ref binds to the resolved id.
  //
  // Freezing records what ALREADY ran, so it never fails on an unusable group: the
  // run got here, and a group emptied mid-run must still leave the session a
  // recoverable fact rather than an unbound orphan. The vendor then comes from the
  // group ref itself (a group is vendor-locked).
  const result = tryResolveAgentTarget(agentId)
  const boundId = isGroupAgentRef(agentId) ? agentId : result.ok ? result.target.agent.id : agentId
  const vendor = resolveAgentVendor(agentId)
  // storeScope is frozen alongside the vendor: whether this first run was
  // sandboxed decides which native data root holds the transcript for its life.
  bindSessionAgent(pendingId, realId, boundId, vendor, storeScope)
  onBind?.({
    pendingId,
    realId,
    workspacePath,
    vendor,
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
 * A reference that resolves to an unusable GROUP is refused the same way
 * (`{ ok: false }`, nothing written): binding is where a group configuration error
 * must surface, so the caller reports it instead of persisting a substitute id.
 *
 * Both branches fire the {@link onAgentSwap} composition-time hook so the
 * feature layer can mirror the swap into the projection.
 */
export function setSessionAgent(sessionId: string, agentId: string | null): { ok: boolean } {
  if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
    if (agentId) {
      const result = tryResolveAgentTarget(agentId)
      if (!result.ok) return { ok: false }
      // Dual-write: the pending intent is written to BOTH state.json
      // (legacy, for backward compat with scripts / tests) AND the
      // projection table (new SoT). The projection callback fires only
      // when the composition root has wired it (production); the
      // state.json write is unconditional (tests without a db).
      //
      // Preserve a virtual group ref (`_c3_<group>`) so the pending session
      // re-resolves the group each run (ADR-0029); a real ref uses the resolved id.
      const boundId = isGroupAgentRef(agentId) ? agentId : result.target.agent.id
      setPendingIntent(sessionId, boundId)
      onAgentSwap?.({
        scope: 'pending',
        sessionId,
        vendor: result.target.agent.vendor,
        agentId: boundId,
      })
      return { ok: true }
    }
    setPendingIntent(sessionId, agentId)
    return { ok: true }
  }
  if (agentId === null || agentId === '') return { ok: false }
  const result = tryResolveAgentTarget(agentId)
  if (!result.ok) return { ok: false }
  const resolved = result.target.agent
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

/** The binding a projection row records for a real session (see the hook below). */
export interface SessionBindingFallback {
  agentId: string
  vendor: VendorId
}

let onBind: ((input: OnBindInput) => void) | null = null
let onAgentSwap: ((input: OnAgentSwapInput) => void) | null = null
let onSessionBindingFallback: ((realId: string) => SessionBindingFallback | null) | null = null

/** Register the bind hook (composition root only). */
export function setOnBind(cb: ((input: OnBindInput) => void) | null): void {
  onBind = cb
}

/** Register the agent-swap hook (composition root only). */
export function setOnAgentSwap(cb: ((input: OnAgentSwapInput) => void) | null): void {
  onAgentSwap = cb
}

/**
 * Register the projection-backed binding fallback for factless real sessions
 * (composition root only). Unwired (tests / scripts without the projection) the
 * resolution keeps its previous default-agent behaviour.
 */
export function setOnSessionBindingFallback(
  cb: ((realId: string) => SessionBindingFallback | null) | null,
): void {
  onSessionBindingFallback = cb
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
  // the frozen vendor. A real binding shows the agent itself. Display-safe: a group
  // that lost its last member still names itself here (with the vendor its ref
  // encodes) — the switcher is how the user gets OUT of that state.
  const group = rawId ? parseGroupAgentRef(rawId) : null
  const binding = resolveSessionAgentBinding(sessionId)
  const vendor = binding.vendor
  const currentId = binding.agentId
  // A group shows as its prefixed ref `_c3_<vendor>_<group>`; a real agent as its name.
  const currentName = group
    ? rawId!
    : (loadSettings().agents.find((a) => a.id === currentId)?.displayName ?? currentId)
  // Candidates: the other same-vendor real agents PLUS the same-vendor virtual group
  // agents (so a session can be switched onto a group — relay failover). Group refs
  // read as `_c3_<vendor>_<group>`. The current binding (real id or group ref) is excluded.
  const realCandidates = sameVendorEnabledAgents(vendor, group ? null : currentId)
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
