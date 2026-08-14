/**
 * The two console surfaces over `user_workspace_scopes`: the administrator's
 * account × workspace editor, and the read-only "who can reach this workspace"
 * view a workspace settings tab shows.
 *
 * They read the SAME resolver the external MCP gate and the console workspace list
 * read (`listWorkspacesForSubject`), never the raw scope rows. That is what keeps
 * the displayed answer from drifting away from the enforced one: there is no
 * second place that decides who can see what, only a second rendering of the
 * first.
 *
 * Their authorization is deliberately DIFFERENT, because they disclose different
 * things:
 *  - the editor returns the whole account roster and the whole workspace
 *    registry, which is the inventory of the deployment. Administrator-only, and
 *    enforced here rather than by hiding a tab.
 *  - the workspace view returns only who can reach ONE workspace, and is offered
 *    to any authenticated caller who can already reach that workspace themselves.
 *    An unknown workspace and one outside the caller's scope get the SAME refusal,
 *    so the read cannot be turned into a probe for workspace names.
 *
 * Writes are persist-first, close-second. `putWorkspaceScope` commits the policy
 * and the policy-epoch bump in one transaction; only after it returns are the
 * edited owner's live external-MCP sessions closed. A close that fails cannot
 * restore the old policy — the epoch check refuses those sessions on their next
 * request anyway — and a write that fails closes nothing at all.
 */
import type {
  UserWorkspaceAccessAccount,
  WorkspaceInfo,
  WorkspaceScopeMode,
} from '@ccc/shared/protocol'
import { loadSettings } from '../../kernel/config/index.js'
import { listWorkspaces } from '../../state.js'
import type { Conn, Handler } from '../../transport/handler-registry.js'
import { requireAdmin, configuredAdmin } from './authz.js'
import { LOCAL_SUBJECT, listWorkspacesForSubject, resolveAuthSubject } from './authorization.js'
import { putWorkspaceScope, readWorkspaceScope } from './scope-store.js'

/**
 * Composition-root sink that tears down every live external-MCP session of ONE
 * owner. Null until the server wires it (unit tests and embedders never stand up
 * the route), in which case the policy epoch still refuses the stale sessions on
 * their next request.
 */
let closeSessionsForOwner: ((ownerSubject: string) => void) | null = null

/** Register the live-session teardown used after a workspace-policy change. */
export function setExternalMcpOwnerSessionCloser(
  hook: ((ownerSubject: string) => void) | null,
): void {
  closeSessionsForOwner = hook
}

/** The `basic` account usernames this deployment knows, in configured order. */
function accountNames(): string[] {
  const provider = loadSettings().auth?.provider
  return provider?.kind === 'basic' ? provider.accounts.map((a) => a.username) : []
}

/**
 * The editor's account roster.
 *
 * The two implicit identities are rows, not omissions — an administrator has to
 * be able to see WHY they themselves reach everything — but they are `editable:
 * false` and hold no stored policy. `local` appears only when it is the
 * deployment's active identity (no configured administrator); showing it under
 * basic auth would advertise a principal that cannot authenticate.
 */
function accessRoster(): UserWorkspaceAccessAccount[] {
  const admin = configuredAdmin(loadSettings().auth)
  if (admin === null) {
    return [{ subject: LOCAL_SUBJECT, isAdmin: true, editable: false, policy: null }]
  }
  const rows: UserWorkspaceAccessAccount[] = []
  for (const subject of accountNames()) {
    if (subject === admin) {
      rows.push({ subject, isAdmin: true, editable: false, policy: null })
      continue
    }
    const stored = readWorkspaceScope(subject)
    rows.push({
      subject,
      isAdmin: false,
      editable: true,
      // `null` (nobody configured this account) is kept distinct from
      // `{ mode: 'selected', workspaces: [] }` (an administrator deliberately
      // selected nothing). Both deny; only one of them is a decision.
      policy: stored ? { mode: stored.mode, workspaces: [...stored.workspaces] } : null,
    })
  }
  return rows
}

function accessSnapshot(): {
  type: 'user_workspace_access'
  workspaces: WorkspaceInfo[]
  accounts: UserWorkspaceAccessAccount[]
} {
  return { type: 'user_workspace_access', workspaces: listWorkspaces(), accounts: accessRoster() }
}

export const getUserWorkspaceAccessHandler: Handler<'get_user_workspace_access'> = (_ctx, conn) => {
  // Before ANY read: the reply is the deployment's account and workspace
  // inventory, so the gate cannot sit at the rendering layer.
  if (!requireAdmin(conn)) return
  conn.send(accessSnapshot())
}

/** Refuse the whole save, naming what was wrong. Nothing was written. */
function refuse(conn: Conn, code: 'unknownAccount' | 'immutableSubject', subject: string): void {
  conn.send({ type: 'error', error: { code: `userAccess.${code}`, params: { subject } } })
}

export const saveUserWorkspaceAccessHandler: Handler<'save_user_workspace_access'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!requireAdmin(conn)) return
  const subject = typeof msg.subject === 'string' ? msg.subject.trim() : ''
  const admin = configuredAdmin(loadSettings().auth)
  // The administrator and the synthesized `local` principal reach everything
  // through a resolver branch, never a row. Writing one here would create a row
  // the resolver ignores while looking like it took effect — and, worse, would be
  // the shape an administrator could later use to lock themselves out.
  if (!subject || subject === admin || (admin === null && subject === LOCAL_SUBJECT)) {
    refuse(conn, 'immutableSubject', subject)
    return
  }
  if (admin === null || !accountNames().includes(subject)) {
    refuse(conn, 'unknownAccount', subject)
    return
  }
  // A mode c3 cannot interpret is never guessed at: guessing `selected` would
  // silently narrow, guessing `all` would silently widen.
  if (msg.mode !== 'all' && msg.mode !== 'selected') {
    conn.send({ type: 'error', error: { code: 'userAccess.invalidMode' } })
    return
  }
  const mode: WorkspaceScopeMode = msg.mode
  // `all` follows the registry, so it names nothing; a client that sent names
  // anyway does not get them stored under a mode that ignores them.
  const requested = mode === 'selected' ? (msg.workspaces ?? []) : []
  const known = new Set(listWorkspaces().map((w) => w.name))
  const names: string[] = []
  for (const raw of requested) {
    const name = typeof raw === 'string' ? raw.trim() : ''
    // All-or-nothing: an unknown or empty name aborts before the transaction, so
    // a saved policy is always exactly the submitted one.
    if (!name || !known.has(name)) {
      conn.send({
        type: 'error',
        error: { code: 'userAccess.unknownWorkspace', params: { workspaceName: String(raw) } },
      })
      return
    }
    if (!names.includes(name)) names.push(name)
  }

  try {
    // Policy rows and the epoch land together or not at all.
    putWorkspaceScope(subject, mode, names, Date.now())
  } catch (err) {
    console.error('[c3] saving a workspace access policy failed:', err)
    conn.send({ type: 'error', error: { code: 'userAccess.saveFailed' } })
    return
  }
  // Storage is authoritative from here on, so the teardown can only ever be
  // early — never the thing that makes the change real.
  closeSessionsForOwner?.(subject)
  conn.send(accessSnapshot())
}

export const getWorkspaceAccessorsHandler: Handler<'get_workspace_accessors'> = (
  _ctx,
  conn,
  msg,
) => {
  const wanted = typeof msg.workspaceName === 'string' ? msg.workspaceName.trim() : ''
  const viewer = resolveAuthSubject(conn.subject)
  // One refusal for "no such workspace", "not yours" and "not authenticated": a
  // caller must not be able to tell a hidden workspace from a missing one.
  const visible = viewer !== null && listWorkspacesForSubject(viewer).some((w) => w.name === wanted)
  if (!visible) {
    conn.send({ type: 'error', error: { code: 'workspaceAccessors.forbidden' } })
    return
  }
  const admin = configuredAdmin(loadSettings().auth)
  const candidates = admin === null ? [LOCAL_SUBJECT] : [...new Set([admin, ...accountNames()])]
  const subjects = candidates.filter((subject) =>
    listWorkspacesForSubject(subject).some((w) => w.name === wanted),
  )
  conn.send({ type: 'workspace_accessors', workspaceName: wanted, subjects })
}
