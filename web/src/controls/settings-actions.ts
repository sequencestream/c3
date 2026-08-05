import type {
  ActionTarget,
  SystemSettings,
  UiLang,
  UiTheme,
  WorkspaceSetting as WorkspaceSettingType,
} from '@ccc/shared/protocol'
import { toSystemSettingsTarget } from '@/lib/action-descriptor'
import { applyLocale, i18n, type Locale } from '@/i18n'
import {
  hasLocalPersonalized,
  readLocalPersonalized,
  writeLocalPersonalized,
} from '@/lib/personalized-settings'
import { applyTheme, DEFAULT_THEME } from '@/lib/theme'
import type { AppCtx } from './types'

// Install system/workspace/personalized settings, skill-install, locale, and
// view-mode actions.
export function installSettingsActions(ctx: AppCtx): void {
  const send = ctx.send
  const t = ctx.t
  const {
    settingsOpen,
    settingsTarget,
    personalizedSettingOpen,
    personalizedSettings,
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

  /**
   * The single dispatcher behind every derived `ActionDescriptor`: translate the
   * wire target into a one-shot panel instruction and open system settings on it.
   * Navigation only — it never enables an agent, edits credentials, saves the
   * panel, or clears the failure the descriptor came from.
   */
  ctx.openActionTarget = (target: ActionTarget): void => {
    settingsTarget.value = toSystemSettingsTarget(target)
    ctx.openSettings()
  }

  /** The panel consumed the one-shot target (or settings closed). */
  ctx.clearActionTarget = (): void => {
    settingsTarget.value = null
  }

  // Personalized settings are already in memory (browser seed + server echo), so
  // opening the page needs no fetch; refresh anyway so a page left open picks up an
  // account record created on another device.
  ctx.openPersonalizedSetting = (): void => {
    personalizedSettingOpen.value = true
    ctx.fetchPersonalizedSettings()
  }

  /**
   * Ask the server for this connection's personalized settings, offering this
   * browser's own record as the seed for a not-yet-existing account record. Sent on
   * every handshake, so a login (which reconnects) adopts the account value and a
   * logout falls back to the browser's.
   */
  ctx.fetchPersonalizedSettings = (): void => {
    const localFallback = readLocalPersonalized()
    // Only a browser that actually recorded something offers a seed: an absent field
    // must stay absent so it is not mistaken for a deliberate choice.
    send({
      type: 'get_personalized_settings',
      ...(hasLocalPersonalized() ? { localFallback } : {}),
    })
  }

  ctx.openWorkspaceSetting = (): void => {
    workspaceSettingOpen.value = true
    const path = currentWorkspace.value
    if (path) send({ type: 'load_workspace_setting', workspaceId: path })
  }

  // Persist workspace settings. The panel now saves per-tab and stays open so the
  // saved tab can reflect the server-normalized echo while other tabs keep their
  // unsaved drafts. The panel still closes on workspace switch / reconnect / the
  // user's explicit close (handled elsewhere).
  ctx.saveWorkspaceSetting = (config: WorkspaceSettingType): void => {
    const path = currentWorkspace.value
    if (path) send({ type: 'save_workspace_setting', workspaceId: path, config })
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

  // Persist system settings. The panel now saves per-tab and stays open so the
  // saved tab can reflect the server-normalized echo while other tabs keep their
  // unsaved drafts (2026-07-11-001).
  ctx.saveSettings = (settings: SystemSettings): void => {
    send({ type: 'save_settings', settings })
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
   * Switch the display language at runtime (no page reload): flip vue-i18n locale +
   * `<html lang>`, record it in this browser, then persist it for the current
   * identity. The browser copy is written even when an account backs the value, so
   * this browser keeps the latest choice for its signed-out state.
   * If the WS send fails, roll the UI back and toast — the stored value is untouched.
   */
  ctx.setLocale = (next: UiLang): void => {
    const prev = i18n.global.locale.value as Locale
    if (next === prev) return
    applyLocale(next)
    writeLocalPersonalized({ uiLang: next })
    const previousSettings = personalizedSettings.value
    personalizedSettings.value = { ...previousSettings, uiLang: next }
    try {
      if (!ctx.client) throw new Error('no connection')
      send({ type: 'save_personalized_settings', settings: personalizedSettings.value })
    } catch {
      applyLocale(prev)
      writeLocalPersonalized({ uiLang: prev })
      personalizedSettings.value = previousSettings
      ctx.showToast(t('error.personalizedSetting.saveFailed'))
    }
  }

  /**
   * Switch the display theme at runtime (no page reload): swap the root element's
   * `data-theme`, record it in this browser, then persist it for the current
   * identity — the same immediate-apply, immediate-save shape the language uses.
   * The saved payload is the whole settings object, so a theme change never drops
   * the language (and vice versa).
   * If the WS send fails, roll the theme, the browser record and the in-memory
   * snapshot all the way back and toast, so what is on screen is what is stored.
   */
  ctx.setTheme = (next: UiTheme): void => {
    const previousSettings = personalizedSettings.value
    const prev = previousSettings.theme ?? DEFAULT_THEME
    if (next === prev) return
    applyTheme(next)
    writeLocalPersonalized({ theme: next })
    personalizedSettings.value = { ...previousSettings, theme: next }
    try {
      if (!ctx.client) throw new Error('no connection')
      send({ type: 'save_personalized_settings', settings: personalizedSettings.value })
    } catch {
      applyTheme(prev)
      writeLocalPersonalized({ theme: prev })
      personalizedSettings.value = previousSettings
      ctx.showToast(t('error.personalizedSetting.saveFailed'))
    }
  }

  // ---- View mode (workspace / workcenter) ----
  ctx.setViewMode = (next: 'workspace' | 'workcenter'): void => {
    if (next === viewMode.value) return
    if (next === 'workcenter') {
      // 记住当前标签页
      savedTab.value = activeTab.value
      viewMode.value = 'workcenter'
      // Load whichever page-internal nav is active (Notifications by default).
      if (ctx.workcenterPage.value === 'dashboard') ctx.loadDashboard()
      else if (flags.viewModeFirstWorkcenter) {
        flags.viewModeFirstWorkcenter = false
        ctx.reloadWorkcenter()
      }
    } else {
      viewMode.value = 'workspace'
      // 恢复之前标签页
      if (savedTab.value === 'console' && serverSettings.value?.showSessionsPage !== true) {
        savedTab.value = 'intents'
        ctx.onSelectTab('intents')
      } else {
        activeTab.value = savedTab.value
        ctx.persistViewMode()
      }
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
