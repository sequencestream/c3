/**
 * External-skill install + link-status handlers (ADR-0016/0017, 2026-06-12).
 *
 * External skills are no longer mounted at launch; the settings panel drives them
 * explicitly:
 *  - `get_skill_link_status` → report each configured skill's `_c3_<id>` symlink
 *    presence in the two shared public dirs (read-only, zero network).
 *  - `install_skill` → clone/pull the ref's latest head and force-relink into both
 *    public dirs (keeps the one-time `.gitignore` ack).
 */
import type { Handler } from '../../transport/handler-registry.js'
import { resolveWorkspaceRoot, pathToId } from '../../state.js'
import { getSkillRepos } from '../../kernel/config/index.js'
import { getSkillLinkStatuses, installSkill } from '../../kernel/skill-loader/index.js'

/** Reply to `get_skill_link_status`. A config read error degrades to empty statuses. */
export const getSkillLinkStatus: Handler<'get_skill_link_status'> = async (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  let statuses: Awaited<ReturnType<typeof getSkillLinkStatuses>> = []
  try {
    const configs = getSkillRepos(proj)
    statuses = await getSkillLinkStatuses(proj, configs)
  } catch (err) {
    // Invalid/unreadable config ⇒ nothing to report; never leave the client hanging.
    console.warn('[c3] skill link status error:', err)
  }
  conn.send({ type: 'skill_link_status', workspaceId: pathToId(proj)!, statuses })
}

/** Reply to `install_skill`. Resolves the config by id, then runs the install action. */
export const installSkillHandler: Handler<'install_skill'> = async (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  const reply = (
    ok: boolean,
    reason?: 'not-configured' | 'repo-error' | 'gitignore-cancelled',
    detail?: string,
  ): void =>
    conn.send({
      type: 'skill_install_result',
      workspaceId: pathToId(proj)!,
      skillId: msg.skillId,
      ok,
      reason,
      detail,
    })

  let config
  try {
    config = getSkillRepos(proj).find((c) => c.id === msg.skillId)
  } catch (err) {
    return reply(false, 'repo-error', err instanceof Error ? err.message : String(err))
  }
  if (!config) return reply(false, 'not-configured')

  const result = await installSkill({ projectDir: proj, config })
  reply(result.ok, result.reason, result.detail)
}
