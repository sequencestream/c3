/**
 * Agent identity and per-vendor agent configuration.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { VendorId } from './vendor.js'

/**
 * The id the **synthesized fallback agent** and the **legacy system-agent
 * migration** use (2026-06-06-007). Historically `'system'` was a reserved,
 * undeletable singleton; that special-casing is gone — `configMode: 'system'`
 * (see {@link AgentConfigBase.configMode}) is now the per-agent way to say "use
 * the vendor CLI's own config, no overrides", available on any vendor. This
 * constant survives only as ① the migration sentinel for old configs that still
 * carry an `id === 'system'` agent, and ② the id of the agent synthesized when
 * settings are empty/corrupt (so a session is never locked out).
 */
export const SYSTEM_AGENT_ID = 'system'

/**
 * Reserved prefix for **virtual group agents** (ADR-0029). A non-empty
 * {@link AgentConfigBase.group} `<group>` on a `<vendor>` agent is surfaced in every
 * agent-selection point as a virtual agent with id `_c3_<vendor>_<group>`; resolving
 * it yields that `(vendor, group)`'s ordered candidate list (relay failover). Real
 * (user-configured) agent ids may never start with this prefix — `normalize` guards
 * the namespace.
 */
export const GROUP_AGENT_PREFIX = '_c3_'

/**
 * The vendor-agnostic public shell common to every agent profile (ADR-0011's
 * `vendor` dimension applied to the config layer). The per-vendor launch
 * specifics live in a discriminated `config` sub-object — see {@link AgentConfig}.
 */
export interface AgentConfigBase {
  /** Stable id. Minted as `<millisecond timestamp>-<counter>` (web console on add
   *  or copy, server on normalize for an id-less record) and never rewritten
   *  afterwards, so older ids may carry other shapes; {@link SYSTEM_AGENT_ID}
   *  only for the synthesized fallback. */
  id: string
  /** Which vendor this agent drives. The discriminant of {@link AgentConfig}. */
  vendor: VendorId
  /**
   * Where this agent's *provider* connection comes from — orthogonal to
   * {@link vendor} (2026-06-06-007):
   *  - `'system'` — use the vendor CLI's own system config / login; the
   *    `config` connection fields (`baseUrl`/`apiKey`) are **ignored**, but
   *    `model` IS a standalone override read in both modes (2026-07-02-001).
   *    For `claude` this means first-party (no `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`
   *    workaround).
   *  - `'custom'` — apply the full `config` provider triple (baseUrl, apiKey,
   *    model) as launch overrides.
   * This governs ONLY the provider connection uniformly across vendors — model
   * is an independent override in both modes.
   * Back-compat: a legacy config without this field defaults to `'custom'` on
   * load (so previously-configured agents surface with editable provider fields);
   * `'system'` is only ever set explicitly in the console.
   */
  configMode: 'system' | 'custom'
  /** Display name. */
  displayName: string
  /**
   * Whether this agent is enabled. Absent/`true` ⇒ enabled (back-compat: old
   * configs without the field are treated as enabled). When `false`, the agent
   * is excluded from every "list of agents" consumer (discussion participants,
   * consensus voters, degradation chain, default-agent picker) — yet it stays
   * a valid launch target, so `resolveSessionLaunch` can still fall back to a
   * bound/default/system agent that happens to be disabled (a session is never
   * locked out). The system agent may be disabled too.
   */
  enabled?: boolean
  /**
   * Optional display icon: an emoji or short text used to identify this agent
   * in multi-speaker contexts (e.g. discussion chat bubbles). Empty/absent
   * ⇒ no custom icon (consumers fall back to a default marker). Stored
   * verbatim aside from trim and a length cap; not validated as a real emoji.
   * Back-compat: old configs without the field load as `''`. The system agent
   * may have an icon too.
   */
  icon?: string
  /**
   * The agent's position in the user-controlled global ordering — the single
   * sort key every *implicit* "list of agents" consumer reads (the settings list,
   * the default/tool-agent dropdowns, discussion participants, consensus voters,
   * and the default-agent "fall through to the next enabled one" picker). Smaller
   * sorts earlier. The server `normalize` regularizes these to a dense, stable
   * `0..n` sequence on every load/save: the system agent ({@link SYSTEM_AGENT_ID})
   * is pinned to the front, then agents with an explicit `order_seq` in ascending
   * order, then any missing ones appended at the tail in their current array
   * order; duplicates are broken stably. The SettingsPanel drag-reorder writes it
   * back so the order survives a Save.
   *
   * NOT consulted by the *explicit* `degradationChain` (its user-authored id order
   * IS the fallback priority — see {@link SystemSettings.degradationChain}), nor by
   * `resolveSessionLaunch` (a launch target is resolved by id, never by position).
   *
   * Back-compat: a legacy config without this field is filled in by `normalize`
   * using the current array order (insertion order), so existing installs keep
   * their present visual order until the user drags to re-rank.
   */
  order_seq?: number
  /**
   * Optional group name (ADR-0029). Non-empty ⇒ this agent joins the
   * `(group, vendor)` group; empty/absent ⇒ it participates in no group. Every
   * non-empty group is exposed as a virtual **group agent** `_c3_<group>` in every
   * agent-selection point; a request to that virtual agent picks the highest-priority
   * (`order_seq` ascending) enabled member and fails over to the next through the
   * relay. A group-name belongs to a single vendor: `normalize` locks a group's
   * vendor to the FIRST agent that defines it and drops same-name / different-vendor
   * agents from the group (with a warning). Real agent ids may not start with the
   * reserved `_c3_` prefix (normalize enforces this).
   */
  group?: string
}

/**
 * The `claude` vendor's config sub-object: the Claude Code launch overrides.
 * Each empty field ⇒ no override (the system agent's config is all-empty).
 */
export interface ClaudeAgentConfig {
  /** ANTHROPIC_BASE_URL override. Empty ⇒ no override. */
  baseUrl: string
  /**
   * API key / auth token override. Empty ⇒ no override.
   *
   * Encrypted at rest: a non-empty value is stored in settings.json as
   * `c3secretvN:` + base64url(AES-256-GCM) and decrypted back to plaintext on load
   * (SEC-13; primitives in `server/src/kernel/config/encryption.ts`). On the wire /
   * in memory it is always plaintext — encryption is a disk-boundary concern only.
   */
  apiKey: string
  /** Model alias or id. Empty ⇒ no override. */
  model: string
}

/**
 * The `codex` vendor's config sub-object (2026-06-06-005). The neutral launch
 * overrides (mirroring claude); each empty string ⇒ no override.
 *
 * Codex has NO per-tool runtime approval (Phase 0 probe 008 NO-GO), so its
 * launch-time policy gate (`sandboxMode` + `approvalPolicy`) is the substitute for
 * in-the-loop allow/deny. That gate is NOT persisted here (2026-06-06-008):
 * instead it is DERIVED at launch from the session's `defaultMode`
 * ({@link SystemSettings.defaultMode}) via the neutral `ActionMode × ToolGate`
 * grid — one permission knob drives every vendor — so a codex agent needs no
 * separate sandbox/approval configuration.
 */
export interface CodexAgentConfig {
  /** OpenAI-compatible base URL override. Empty ⇒ no override. */
  baseUrl: string
  /**
   * API key / auth token override. Empty ⇒ no override.
   *
   * Encrypted at rest with the same scheme as {@link ClaudeAgentConfig.apiKey}
   * (`c3secretvN:` prefix, SEC-13) — plaintext on the wire / in memory, ciphertext
   * only on disk.
   */
  apiKey: string
  /** Model alias or id. Empty ⇒ no override. */
  model: string
  /**
   * Which wire protocol the (custom) provider speaks — codex's own `wire_api`
   * term (2026-06-12-006). It declares the upstream's REAL API surface so the
   * driver routes deterministically instead of guessing from `baseUrl`:
   *  - `'responses'` ⇒ the provider natively serves OpenAI Responses
   *    (`/responses`); codex connects DIRECT, no relay translation.
   *  - `'chat'` ⇒ the provider is Chat-Completions-only (most third parties);
   *    codex is pointed at c3's in-process Responses→Chat relay (ADR-0014).
   * Legacy records without the field migrate to `'chat'` (the relay default —
   * preserves the pre-existing third-party-via-relay behaviour). Irrelevant to
   * `system`-mode codex (no provider override ⇒ DIRECT regardless).
   */
  wireApi: 'responses' | 'chat'
}

/**
 * The `cursor` vendor's config sub-object — a key and a model, no base URL.
 *
 * The Cursor SDK authenticates with an API key only: it does not read the
 * credential `cursor-agent login` writes to the OS keychain. So unlike the other
 * vendors, whose `system` mode means "use the vendor CLI's own login", a Cursor
 * agent always needs a key — from here, or from `CURSOR_API_KEY` in the server's
 * environment when this is empty.
 *
 * There is deliberately no `baseUrl`: c3 has no relay that speaks Cursor's
 * protocol, so a Cursor agent cannot be pointed at a different provider and is
 * always `configMode: 'system'`. Its absence is what keeps that a type-level fact
 * instead of a runtime convention.
 */
export interface CursorAgentConfig {
  /**
   * The Cursor API key. Empty ⇒ fall back to `CURSOR_API_KEY` in the server's
   * environment; empty with no such variable ⇒ the run fails at the door.
   *
   * Encrypted at rest with the same scheme as {@link ClaudeAgentConfig.apiKey}
   * (`c3secretvN:` prefix, SEC-13) — plaintext on the wire / in memory, ciphertext
   * only on disk.
   */
  apiKey: string
  /** Model alias or id (e.g. `auto`, `claude-4.5-sonnet`). Empty ⇒ Cursor's `auto`. */
  model: string
}

/**
 * One agent profile under the system-config module: a vendor-agnostic public
 * shell ({@link AgentConfigBase}) plus a `vendor`-discriminated `config`
 * sub-object. A session launches the agent's vendor CLI using its agent (or the
 * default agent when unassigned), routing the `config` per its `vendor` tag.
 *
 * `claude` (ADR-0011 reference) and `codex` (read-only advisor seat, Phase 0
 * 008 NO-GO, 2026-06-06-005) have real adapters and config shapes; `cursor`
 * runs on an in-process SDK that takes a key and a model but cannot be pointed at
 * another provider. The runtime
 * validation/routing lives server-side in `kernel/agent-config/schema.ts` (zod
 * stays out of this zero-runtime, SDK-free wire module — ADR-0009); a type-level
 * assertion there pins the zod schema to this union so the two cannot drift.
 */
export type AgentConfig = AgentConfigBase &
  (
    | { vendor: 'claude'; config: ClaudeAgentConfig }
    | { vendor: 'codex'; config: CodexAgentConfig }
    | { vendor: 'cursor'; config: CursorAgentConfig }
  )

/**
 * Whether an agent's config carries a provider **base URL** — the field every
 * caller that redirects a vendor at a custom provider needs.
 *
 * True for the vendors c3 can point elsewhere; false for `cursor`, which has no
 * relay speaking its protocol and so carries only a key and a model. Routing
 * those reads through this guard, rather than a hard-coded vendor comparison, is
 * what keeps a future provider-locked vendor from silently returning `undefined`
 * for a field it never had.
 */
export function hasProviderConfig(
  agent: AgentConfig,
): agent is AgentConfigBase &
  (
    { vendor: 'claude'; config: ClaudeAgentConfig } | { vendor: 'codex'; config: CodexAgentConfig }
  ) {
  return agent.vendor !== 'cursor'
}
