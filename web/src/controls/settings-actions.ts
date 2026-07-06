import type {
  SystemSettings,
  UiLang,
  WorkspaceSetting as WorkspaceSettingType,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { applyLocale, setStoredLocale, i18n, type Locale } from '@/i18n'
import type { AppCtx } from './types'

// Install system/workspace settings, skill-install, locale, and view-mode actions.
export function installSettingsActions(ctx: AppCtx): void {
  const send = ctx.send
  const t = ctx.t
  const {
    settingsOpen,
    workspaceSettingOpen,
    currentWorkspace,
    installingSkillIds,
    serverSettings,
    skillApprovalRequest,
    viewMode,
    savedTab,
    activeTab,
    flags,
  } = ctx

  ctx.openSettings = (): void => {
    settingsOpen.value = true
    send({ type: 'get_settings' })
  }

  ctx.openWorkspaceSetting = (): void => {
    workspaceSettingOpen.value = true
    const path = currentWorkspace.value
    if (path) send({ type: 'load_workspace_setting', workspaceId: path })
  }

  ctx.saveWorkspaceSetting = (config: WorkspaceSettingType): void => {
    const path = currentWorkspace.value
    if (path) send({ type: 'save_workspace_setting', workspaceId: path, config })
    workspaceSettingOpen.value = false
  }

  // Fetch link status for every configured skill repo in the current workspace.
  ctx.querySkillLinkStatus = (): void => {
    const path = currentWorkspace.value
    if (path) send({ type: 'get_skill_link_status', workspaceId: path })
  }

  // Explicitly (re)install a configured skill repo; marks the row busy.
  ctx.installSkill = (skillId: string): void => {
    const path = currentWorkspace.value
    if (!path) return
    if (!installingSkillIds.value.includes(skillId)) {
      installingSkillIds.value = [...installingSkillIds.value, skillId]
    }
    send({ type: 'install_skill', workspaceId: path, skillId })
  }

  ctx.saveSettings = (settings: SystemSettings): void => {
    send({ type: 'save_settings', settings })
    settingsOpen.value = false
  }

  /** Set/change the admin password (ADR-0023). Plaintext is sent once and hashed
   *  server-side; the panel stays open so the result toast lands in context. */
  ctx.setAdminPassword = (payload: {
    username: string
    password: string
    currentPassword?: string
  }): void => {
    send({ type: 'set_admin_password', ...payload })
  }

  /** Remove a basic account (ADR-0023). The panel stays open so the result toast
   *  (including the admin-must-reassign guard) lands in context. */
  ctx.removeAccount = (payload: { username: string }): void => {
    send({ type: 'remove_account', ...payload })
  }

  /** Designate which basic account is the single admin (ADR-0023). */
  ctx.setAdminAccount = (payload: { username: string }): void => {
    send({ type: 'set_admin_account', ...payload })
  }

  /**
   * Switch the UI language at runtime (no page reload): flip vue-i18n locale +
   * <html lang>, persist to localStorage, then push the change to the server.
   * If the WS send fails, roll the UI back and toast.
   */
  ctx.setLocale = (next: UiLang): void => {
    const prev = i18n.global.locale.value as Locale
    if (next === prev) return
    applyLocale(next)
    setStoredLocale(next)
    try {
      if (!ctx.client) throw new Error('no connection')
      const base: SystemSettings = serverSettings.value ?? {
        agents: [],
        defaultAgentId: SYSTEM_AGENT_ID,
        toolAgentId: '',
        intentAgentId: '',
        specAgentId: '',
        automationAgentId: '',
      }
      const settings: SystemSettings = { ...base, uiLang: next }
      send({ type: 'save_settings', settings })
      serverSettings.value = settings
    } catch {
      applyLocale(prev)
      setStoredLocale(prev)
      ctx.showToast(t('error.uiLang.saveFailed'))
    }
  }

  // ---- View mode (workspace / workcenter) ----
  ctx.setViewMode = (next: 'workspace' | 'workcenter'): void => {
    if (next === viewMode.value) return
    if (next === 'workcenter') {
      // 记住当前标签页
      savedTab.value = activeTab.value
      viewMode.value = 'workcenter'
      if (flags.viewModeFirstWorkcenter) {
        flags.viewModeFirstWorkcenter = false
        ctx.reloadWorkcenter()
      }
    } else {
      viewMode.value = 'workspace'
      // 恢复之前标签页
      activeTab.value = savedTab.value
      ctx.persistViewMode()
    }
  }

  // ---- Skill-load approval (mount layer 2/3) ----
  ctx.approveSkillLoad = (requestId: string): void => {
    send({ type: 'skill_load_approval_resolve', requestId, decision: 'approve' })
    skillApprovalRequest.value = null
  }

  ctx.cancelSkillLoad = (requestId: string): void => {
    send({ type: 'skill_load_approval_resolve', requestId, decision: 'cancel' })
    skillApprovalRequest.value = null
  }

  ctx.dismissSkillApproval = (): void => {
    // The `.gitignore` gate blocks the first external-skill mount; dismissing the
    // modal without deciding would leave the backend hanging. We do NOT auto-cancel
    // here because the user may switch away and come back. The modal stays open
    // until a decision is made.
  }
}
