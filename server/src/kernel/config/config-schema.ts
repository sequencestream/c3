/**
 * How each settings shape maps onto config rows — the one place that decides which
 * fields expand into their own `config_key` and which stay a single JSON row.
 *
 * The rule of thumb the tables were designed around: **a key names a field**. A
 * subtree becomes JSON only when expanding it would not produce field keys — a list
 * of values with no stable identity (`degradationChain`, `sandbox.extraMounts`), or a
 * map whose keys are file paths rather than field names (the skill-mount index).
 */
import type { ConfigRules } from './config-codec.js'

/**
 * System settings (`SystemSettings` minus `projectConfigs`, which lives in
 * `workspace_configs`) plus the `state.*` namespace that holds the global bits of
 * the former `state.json` files.
 */
export const SYSTEM_RULES: ConfigRules = {
  recordArrays: {
    agents: 'id',
    'auth.provider.accounts': 'username',
    // Deprecated top-level mirror of the per-workspace list; still read for migration.
    skillRepos: 'id',
  },
  secrets: ['agents.*.config.apiKey', 'auth.provider.accounts.*.passwordHash'],
  json: [
    'degradationChain',
    'consensus.agentIds',
    // Keyed by `${projectDir}:${vendor}:${id}` and by project dir — path-shaped keys,
    // not field names, so expanding them would produce keys nobody can address.
    'state.skillLink',
    'state.skillAcks',
    'state.skillSupport.*',
  ],
}

/** Per-workspace settings (`WorkspaceSetting`), one scope per workspace name. */
export const WORKSPACE_RULES: ConfigRules = {
  recordArrays: { skillRepos: 'id' },
  json: ['consensus.agentIds', 'sandbox.extraMounts', 'sandbox.sandboxSessionKinds'],
}

/** Per-account personalized settings (`PersonalizedSettings`), one scope per subject. */
export const PERSONALIZED_RULES: ConfigRules = {}

/** Per-session facts (agent binding, permission mode, codex policy, group cursor). */
export const SESSION_RULES: ConfigRules = {}

/**
 * One MCP API key record per scope. `hash` is the scrypt digest of the key's secret
 * half — never the plaintext, but still key material, so it is stored encrypted; the
 * salt beside it is not a secret and stays readable.
 */
export const MCP_KEY_RULES: ConfigRules = { secrets: ['hash'], json: ['tools'] }

// ---------------------------------------------------------------------------
// Key constants
// ---------------------------------------------------------------------------

/** Prefix of the system-scope keys that hold former `state.json` globals. */
export const STATE_PREFIX = 'state'

/**
 * The global authorization-policy freshness counter. It shares the `auth.*` key
 * space with `SystemSettings.auth` but is NOT part of that object — it is derived
 * policy state nobody edits by hand — so a whole-settings save must preserve it
 * instead of deleting a row it never states.
 */
export const POLICY_EPOCH_KEY = 'auth.policyEpoch'

export const STATE_KEYS = {
  activeSessionId: `${STATE_PREFIX}.activeSessionId`,
  skillSupport: `${STATE_PREFIX}.skillSupport`,
  skillLink: `${STATE_PREFIX}.skillLink`,
  skillAcks: `${STATE_PREFIX}.skillAcks`,
} as const

/** Keys inside a `session_configs` scope. */
export const SESSION_KEYS = {
  /** The bound agent of a real session, or the desired agent of a pending intent. */
  agentId: 'agentId',
  vendor: 'vendor',
  storeScope: 'storeScope',
  groupCursor: 'groupCursor',
  mode: 'mode',
  codexSandboxMode: 'codexPolicy.sandboxMode',
  codexApprovalPolicy: 'codexPolicy.approvalPolicy',
  /** Present only on pending-intent rows; also their creation instant. */
  pendingCreatedAt: 'pendingCreatedAt',
} as const

/** The one system key that is NOT part of `SystemSettings`: the per-agent UI language. */
export const AGENT_LANG_KEY = 'agentLang'
