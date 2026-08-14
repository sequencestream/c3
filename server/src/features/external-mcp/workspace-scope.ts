/**
 * The bridge between "a path an external caller (or an administrator) named" and
 * "a workspace c3 actually serves".
 *
 * The workspace registry stores lexically-resolved absolute paths; an API key's
 * authorization set and an administrator-named workspace are both canonicalized
 * (symlinks followed, trailing separators and dot segments collapsed). Comparing
 * the two forms directly would let an equivalent spelling of a registered
 * workspace read as "unknown" — or worse, let two spellings disagree about
 * whether a key is authorized. So every comparison happens in the canonical form,
 * on both sides.
 *
 * A registered-but-vanished directory answers `false`: an authorization that
 * still names a removed workspace must degrade to "not found", never to a read
 * against a path that is no longer there.
 */
import { canonicalizeWorkspacePath } from '../../kernel/config/mcp-api-keys.js'
import { isDirectory, listWorkspaces, resolveWorkspaceRoot } from '../../state.js'

/** Every registered workspace's canonical path (order follows the registry's own). */
export function listRegisteredWorkspaceCanonicalPaths(): string[] {
  const out: string[] = []
  for (const ws of listWorkspaces()) {
    const canonical = canonicalizeWorkspacePath(ws.path)
    if (canonical && !out.includes(canonical)) out.push(canonical)
  }
  return out
}

/**
 * The canonical path a registered workspace id points at, or `null` for an
 * unknown/forged id. This is how an administrator's id-addressed grant becomes
 * the path form an authorization check compares.
 */
export function workspaceNameToCanonicalPath(id: string): string | null {
  const path = resolveWorkspaceRoot(id)
  return path ? canonicalizeWorkspacePath(path) : null
}

/**
 * The reverse: which registered workspace id (if any) a canonical path belongs
 * to. `null` means the grant now names a workspace c3 no longer has — the key
 * keeps the record so an administrator can see the stale entry, but nothing can
 * be reached through it.
 */
export function canonicalPathToWorkspaceName(canonicalPath: string): string | null {
  const wanted = canonicalizeWorkspacePath(canonicalPath)
  if (!wanted) return null
  for (const ws of listWorkspaces()) {
    if (canonicalizeWorkspacePath(ws.path) === wanted) return ws.name
  }
  return null
}

/**
 * Resolve a canonical path to the workspace path c3 ITSELF uses — the registry's
 * own spelling — or `null` when no registered workspace matches or the directory
 * is gone.
 *
 * The distinction matters. Canonicalization exists only to decide *equivalence*
 * (is this the same directory the key was granted?); it must not become the path
 * handed to feature code. The intent and discussion stores partition by
 * `resolve(workspacePath)`, so a workspace registered through a symlink would
 * have its rows under the registry spelling while a realpath-canonical query
 * looked somewhere else and quietly found nothing. Matching in canonical space,
 * then acting on the registry path, keeps an external caller reading exactly what
 * an internal one reads.
 */
export function resolveRegisteredWorkspacePath(canonicalPath: string): string | null {
  const wanted = canonicalizeWorkspacePath(canonicalPath)
  if (!wanted) return null
  for (const ws of listWorkspaces()) {
    if (canonicalizeWorkspacePath(ws.path) === wanted) return isDirectory(ws.path) ? ws.path : null
  }
  return null
}
