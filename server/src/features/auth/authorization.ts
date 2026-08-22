/**
 * The ONE place that answers "who is this, and what may they reach?".
 *
 * Two consumers, one result: the console's workspace list and the external MCP
 * call gate. They were separate answers before — the console listed the raw
 * registry, the MCP route trusted whatever workspace a key was minted against —
 * and two answers to one question is how a workspace ends up visible to someone
 * who was never granted it. Everything here is derived from the same three
 * inputs, so the two surfaces cannot disagree.
 *
 * The three inputs, intersected:
 *  1. the key's own workspace scope — currently the whole registered universe, so
 *     the owner policy is the limiting set; the shape leaves room for per-key
 *     narrowing later without moving the gate;
 *  2. the owner's administrator-managed workspace scope (`user_workspace_scopes`,
 *     default-deny);
 *  3. the key's tool scope intersected with the externally-grantable catalog.
 *
 * Default-deny is structural, not a policy choice: a missing row, an
 * uninterpretable mode, a workspace name the registry no longer has, an owner the
 * account roster does not know — every one of them produces an EMPTY set, and
 * there is no branch anywhere below that turns absence into `all`. The two
 * subjects that DO get everything are explicit branches (the configured
 * administrator, and the `local` principal a no-auth deployment synthesizes),
 * because an administrator must not be able to edit away their own recovery
 * access and a single-user localhost install must not need a policy row to work.
 */
import { EXTERNAL_MCP_TOOL_NAMES, type WorkspaceInfo } from '@ccc/shared/protocol'
import { loadSettings } from '../../kernel/config/index.js'
import { readPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import { isDirectory, listWorkspaces, resolveWorkspaceRoot } from '../../state.js'
import { configuredAdmin } from './authz.js'
import { normalizeSubject, readWorkspaceScope } from './scope-store.js'

/**
 * The subject a deployment without accounts acts as. Not a username: no `basic`
 * account can be created with an empty name, and a real account called `local`
 * still only matches when basic auth is off — the two branches never overlap
 * because they are selected by the auth configuration, not by the string.
 */
export const LOCAL_SUBJECT = 'local'

/** The auth facts authorization depends on, read once per decision. */
interface AuthFacts {
  /** The configured administrator, or `null` when no admin gate applies. */
  admin: string | null
  /** Every account the roster knows. Empty when no roster applies. */
  accounts: ReadonlySet<string>
}

function authFacts(): AuthFacts {
  const auth = loadSettings().auth
  const admin = configuredAdmin(auth)
  const provider = auth?.provider
  const accounts =
    provider?.kind === 'basic'
      ? new Set(provider.accounts.map((a) => a.username))
      : new Set<string>()
  return { admin, accounts }
}

/**
 * The subject a connection or request acts as, or `null` when authentication is
 * enforced and nobody proved an identity.
 *
 * `rawSubject` is whatever the caller already verified — a WebSocket's bound
 * `conn.subject`, or nothing at all for an MCP peer. It is never a client-stated
 * identity. When no admin gate applies (auth absent, disabled, `none`, or a
 * `basic` shell still waiting for its first account) every caller is the same
 * trusted local principal, which is why the no-account console keeps working
 * without a stored policy while default-deny still governs real accounts.
 */
export function resolveAuthSubject(rawSubject: string | null): string | null {
  const { admin } = authFacts()
  if (admin === null) return LOCAL_SUBJECT
  return normalizeSubject(rawSubject ?? '')
}

/**
 * Whether a key's stored owner is still a principal this deployment recognizes.
 *
 * `local` is valid only while no admin gate applies. A key minted on a localhost
 * install therefore stops working the moment basic auth is configured — silently
 * re-pointing it at the new administrator would hand a credential that was
 * created without any account authority to the account with the most.
 */
export function isValidOwner(ownerSubject: string): boolean {
  const owner = normalizeSubject(ownerSubject)
  if (!owner) return false
  const { admin, accounts } = authFacts()
  if (admin === null) return owner === LOCAL_SUBJECT
  return accounts.has(owner)
}

/**
 * The registered workspace names a subject may reach, in registry order.
 *
 * Order matters: the console renders this list, so a filtered list has to look
 * like the unfiltered one with entries missing — not like a re-sorted one.
 */
function scopedWorkspaces(subject: string): WorkspaceInfo[] {
  if (!isValidOwner(subject)) return []
  const registry = listWorkspaces()
  const { admin } = authFacts()
  if (admin === null) return subject === LOCAL_SUBJECT ? registry : []
  if (subject === admin) return registry
  const scope = readWorkspaceScope(subject)
  if (!scope) return []
  if (scope.mode === 'all') return registry
  const selected = new Set(scope.workspaces)
  return registry.filter((w) => selected.has(w.name))
}

/**
 * The workspaces one subject may see. The console's `ready` snapshot, its
 * `workspaces` refreshes and the MCP workspace resolution all call THIS — an
 * unresolvable subject sees nothing rather than the raw registry.
 */
export function listWorkspacesForSubject(subject: string | null): WorkspaceInfo[] {
  const normalized = subject === null ? null : normalizeSubject(subject)
  return normalized ? scopedWorkspaces(normalized) : []
}

/**
 * An authenticated external-MCP caller, before any workspace or tool decision.
 * The trusted-local principal has key id and owner `local` and secret version 0 —
 * a value no stored record can hold, so a synthesized principal can never be
 * mistaken for a persisted one.
 */
export interface ExternalMcpPrincipal {
  keyId: string
  ownerSubject: string
  secretVersion: number
  /** The names the key carries. Intersected with the catalog before it grants anything. */
  tools: readonly string[]
}

/**
 * The frozen result of one authorization. Handlers receive THIS and never a
 * client-supplied path: `workspacePath` is resolved from the registry here, so
 * there is no request field a caller could aim at another directory.
 *
 * It doubles as the session-pinning tuple source — `keyId`, `secretVersion`,
 * `workspaceName` and `policyEpoch` are exactly what a later request must still
 * match to keep using an initialized transport.
 */
export interface EffectiveScope {
  readonly keyId: string
  readonly ownerSubject: string
  readonly secretVersion: number
  readonly policyEpoch: number
  readonly workspaceName: string
  readonly workspacePath: string
  readonly tools: readonly string[]
}

/** Why a call was refused. The transport maps these onto its responses. */
export type AuthorizeDenial = 'owner' | 'workspace' | 'tool'

export type AuthorizeResult =
  { ok: true; scope: EffectiveScope } | { ok: false; reason: AuthorizeDenial }

/** The principal a no-auth loopback peer acts as: everything, owned by nobody. */
export function localPrincipal(): ExternalMcpPrincipal {
  return {
    keyId: LOCAL_SUBJECT,
    ownerSubject: LOCAL_SUBJECT,
    secretVersion: 0,
    tools: [...EXTERNAL_MCP_TOOL_NAMES],
  }
}

/** The key's tool scope reduced to names the catalog still offers, in key order. */
function effectiveTools(tools: readonly string[]): string[] {
  const catalog = new Set<string>(EXTERNAL_MCP_TOOL_NAMES)
  return [...new Set(tools.filter((name) => catalog.has(name)))]
}

/**
 * The single external-MCP call gate.
 *
 * `toolName` is `null` when no tool is being invoked — establishing a session or
 * listing the catalog — and the returned scope then carries the full effective
 * tool set for the caller to advertise. A non-null name must survive the same
 * intersection the list was built from, so discovery and execution can never
 * disagree about what is granted.
 *
 * Order is a security property: owner first (an unrecognized owner learns nothing
 * about which workspaces exist), then workspace, then tool.
 */
export function authorizeCall(
  auth: ExternalMcpPrincipal,
  workspaceName: string,
  toolName: string | null,
): AuthorizeResult {
  if (!isValidOwner(auth.ownerSubject)) return { ok: false, reason: 'owner' }

  const wanted = typeof workspaceName === 'string' ? workspaceName.trim() : ''
  if (!wanted) return { ok: false, reason: 'workspace' }
  const allowed = scopedWorkspaces(auth.ownerSubject).some((w) => w.name === wanted)
  if (!allowed) return { ok: false, reason: 'workspace' }
  // Resolved here rather than passed in: matching a name the caller sent against
  // a path the caller also sent would authorize one thing and act on another.
  const workspacePath = resolveWorkspaceRoot(wanted)
  if (!workspacePath || !isDirectory(workspacePath)) return { ok: false, reason: 'workspace' }

  const tools = effectiveTools(auth.tools)
  if (toolName !== null && !tools.includes(toolName)) return { ok: false, reason: 'tool' }

  return {
    ok: true,
    scope: Object.freeze({
      keyId: auth.keyId,
      ownerSubject: auth.ownerSubject,
      secretVersion: auth.secretVersion,
      policyEpoch: readPolicyEpoch(),
      workspaceName: wanted,
      workspacePath,
      tools: Object.freeze(tools),
    }),
  }
}
