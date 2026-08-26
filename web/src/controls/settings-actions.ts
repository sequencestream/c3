import type {
  ActionTarget,
  SystemSettings,
  VendorId,
  UiLang,
  UiTheme,
  WorkspaceScopeMode,
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
import { applyFontScale, DEFAULT_FONT_SCALE } from '@/lib/font-scale'
import type { AppCtx } from './types'
import { providerProbeKey } from '@/lib/model-provider'

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
    providerProbes,
  } = ctx

  ctx.openSettings = (): void => {
    settingsOpen.value = true
    send({ type: 'get_settings' })
    // 迁移报告是注册表的派生视图,不随 settings 回包一起来。开面板时顺带问一次,
    // 「还有旧内联配置没迁」这件事才会在用户真正看得到的地方出现。
    send({ type: 'provider_migration', action: 'plan' })
  }

  /**
   * The single dispatcher behind every derived `ActionDescriptor`: translate the
   * wire target into navigation. Navigation only — it never approves a spec,
   * answers a permission/Ask prompt, enables an agent, edits credentials, or
   * clears the fact the descriptor came from.
   */
  ctx.openActionTarget = (target: ActionTarget): void => {
    if (target.type === 'system-settings-agent') {
      settingsTarget.value = toSystemSettingsTarget(target)
      ctx.openSettings()
      return
    }
    if (target.type === 'intent-spec') {
      const workspace = currentWorkspace.value
      if (!workspace) return
      ctx.setViewMode('workspace')
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = target.intentId
      ctx.requestedIntentSubTab.value = 'spec'
      return
    }
    if (target.type === 'intent-work-session') {
      // The inspection entry for a stalled intent. It only selects the intent and
      // asks for its work-session tab — it never resumes, restarts or retries the
      // session, and an intent without one lands on its default tab instead.
      const workspace = currentWorkspace.value
      if (!workspace) return
      ctx.setViewMode('workspace')
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = target.intentId
      ctx.requestedIntentSubTab.value = 'workSession'
      return
    }
    if (target.type === 'intent-detail') {
      // 只换查看对象:选中目标意图并停在它的默认页签。不改任何意图状态、不起会话、
      // 不批准 spec,也不放行把当前意图挡住的那道依赖闸门。
      const workspace = currentWorkspace.value
      if (!workspace) return
      ctx.setViewMode('workspace')
      ctx.openIntents(workspace)
      ctx.requestedIntentId.value = target.intentId
      ctx.requestedIntentSubTab.value = null
      return
    }
    // workcenter-event
    ctx.setViewMode('workcenter')
    if (ctx.workcenterPage.value !== 'notifications') {
      ctx.setWorkcenterPage('notifications')
    }
    ctx.requestedWorkcenterEventId.value = target.eventId
    ctx.reloadWorkcenter('todo')
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
    ctx.dismissMyMcpApiKeyReveal()
    ctx.fetchMyMcpApiKeys()
    ctx.dismissImIdentityChallengeReveal()
    ctx.fetchMyImIdentity()
    ctx.loadRobots()
  }

  /**
   * Close the personalized-settings page, dropping any still-revealed plaintext
   * key: leaving it in memory to reappear the next time the page opens would
   * contradict the "shown once" promise.
   */
  ctx.closePersonalizedSetting = (): void => {
    personalizedSettingOpen.value = false
    ctx.dismissMyMcpApiKeyReveal()
    ctx.dismissImIdentityChallengeReveal()
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
    const id = currentWorkspace.value
    if (id) {
      send({ type: 'load_workspace_setting', workspaceName: id })
      // Who can reach THIS workspace — a derived, read-only answer. The page
      // administers no credential, so it asks for no key roster.
      send({ type: 'get_workspace_accessors', workspaceName: id })
    }
    ctx.loadParkRecoveryStats()
    // Drop the previous workspace's titles before asking for this one's: the page
    // may be reopening on a different workspace, and memories are content — showing
    // one workspace's list under another's name, even for one frame, would be wrong.
    ctx.workspaceMemories.value = null
    ctx.loadWorkspaceMemories()
  }

  /**
   * Fetch the current workspace's local park-recovery counts. A pure read that
   * stands beside the setting load rather than inside it: the numbers are
   * observation, not configuration, so they never enter the settings draft. Also
   * the observation section's retry — the previous error is cleared as the new
   * request goes out so a stale failure cannot outlive it.
   */
  ctx.loadParkRecoveryStats = (): void => {
    const path = currentWorkspace.value
    if (!path || !ctx.client) return
    ctx.parkRecoveryError.value = null
    ctx.parkRecoveryLoading.value = true
    send({ type: 'get_park_recovery_stats', workspaceName: path })
  }

  /**
   * Fetch the current workspace's memory listing. Stands beside the setting load
   * exactly like the observation counts: memories are what an agent wrote down,
   * not configuration, so they never enter the settings draft. Also the tab's
   * refresh/retry — the previous error is cleared as the new request goes out so a
   * stale failure cannot outlive it.
   */
  ctx.loadWorkspaceMemories = (): void => {
    const path = currentWorkspace.value
    if (!path || !ctx.client) return
    ctx.workspaceMemoriesError.value = null
    ctx.workspaceMemoriesLoading.value = true
    send({ type: 'list_workspace_memories', workspaceName: path })
  }

  /**
   * Soft-delete one memory. Deliberately NOT optimistic: the row leaves the list
   * only when the server confirms which title it removed, so a refused delete can
   * never look like it worked. The id is marked in flight meanwhile, which is also
   * what the failure path clears.
   */
  ctx.deleteWorkspaceMemory = (id: string): void => {
    const path = currentWorkspace.value
    if (!path) return
    if (!ctx.deletingMemoryIds.value.includes(id)) {
      ctx.deletingMemoryIds.value = [...ctx.deletingMemoryIds.value, id]
    }
    send({ type: 'delete_workspace_memory', workspaceName: path, id })
  }

  // Persist workspace settings. The panel now saves per-tab and stays open so the
  // saved tab can reflect the server-normalized echo while other tabs keep their
  // unsaved drafts. The panel still closes on workspace switch / reconnect / the
  // user's explicit close (handled elsewhere).
  ctx.saveWorkspaceSetting = (config: WorkspaceSettingType): void => {
    const path = currentWorkspace.value
    if (path) send({ type: 'save_workspace_setting', workspaceName: path, config })
  }

  // Fetch link status for every configured skill repo in the current workspace.
  ctx.querySkillLinkStatus = (): void => {
    const path = currentWorkspace.value
    if (path) send({ type: 'get_skill_link_status', workspaceName: path })
  }

  // Explicitly (re)install a configured skill repo; marks the row busy.
  ctx.installSkill = (skillId: string): void => {
    const path = currentWorkspace.value
    if (!path) return
    if (!installingSkillIds.value.includes(skillId)) {
      installingSkillIds.value = [...installingSkillIds.value, skillId]
    }
    send({ type: 'install_skill', workspaceName: path, skillId })
  }

  // Persist system settings. The panel now saves per-tab and stays open so the
  // saved tab can reflect the server-normalized echo while other tabs keep their
  // unsaved drafts (2026-07-11-001).
  ctx.saveSettings = (settings: SystemSettings): void => {
    send({ type: 'save_settings', settings })
  }

  /**
   * One-click agent bootstrap: ask the server to probe which vendors can run here
   * and persist a system-mode agent for each that has none. Carries no payload —
   * the vendor list is a runtime fact the server owns, and the result lands as a
   * dedicated reply plus the ordinary `settings` echo that refreshes the panel.
   */
  ctx.autoConfigureAgents = (): void => {
    send({ type: 'auto_configure_agents' })
  }

  /**
   * Drive one step of the inline-config → provider migration. Never part of a
   * settings save: the report is computed server-side over the whole registry, and
   * the write it performs is exactly the one the user asked for — an ordinary save
   * carrying a half-migrated draft would be a different, silent, change.
   */
  ctx.providerMigration = (payload: {
    action: 'plan' | 'apply' | 'revert' | 'clear'
    providerIds?: string[]
    agentIds?: string[]
  }): void => {
    send({ type: 'provider_migration', ...payload })
  }

  /**
   * Ask the server to dial one provider connection. The browser cannot do it
   * (cross-origin, and the stored key must never reach it), so the answer comes
   * back as its own frame rather than riding the settings echo.
   */
  ctx.probeModelProvider = (payload: {
    providerId: string
    vendor: VendorId
    baseUrl?: string
    apiKey?: string
  }): void => {
    // 先落 pending,按钮点下去立刻有反馈;回包会整条覆盖这个键。
    providerProbes.value = {
      ...providerProbes.value,
      [providerProbeKey(payload.providerId, payload.vendor)]: { pending: true },
    }
    send({ type: 'probe_model_provider', ...payload })
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

  // ---- External MCP API keys, self-service (see features/settings/mcp-api-keys.ts)
  // Every operation replies with the WHOLE roster of THIS identity's keys, so none
  // of these mutates local state optimistically: what the list shows is always what
  // the server confirmed. The owner is never sent — the server takes it from the
  // verified connection.

  /** Load this identity's own keys. Metadata only; no plaintext is ever re-sent. */
  ctx.fetchMyMcpApiKeys = (): void => {
    send({ type: 'list_my_mcp_api_keys' })
  }

  /** Mint a key for this identity, labelled by device or client. The reply is the only message that will ever carry its plaintext. */
  ctx.createMyMcpApiKey = (payload: { name: string }): void => {
    send({ type: 'create_my_mcp_api_key', ...payload })
  }

  /**
   * Replace one of my keys' secrets in place. Same key, new secret: whatever was
   * configured with the previous one stops working at once, with no grace period.
   */
  ctx.resetMyMcpApiKey = (payload: { id: string }): void => {
    send({ type: 'reset_my_mcp_api_key', ...payload })
  }

  /** Revoke one of my keys. Takes effect on that key's very next request. */
  ctx.revokeMyMcpApiKey = (payload: { id: string }): void => {
    send({ type: 'revoke_my_mcp_api_key', ...payload })
  }

  /**
   * Drop the one-time plaintext from memory. Called when the user dismisses the
   * reveal or closes the page — after this the key is unrecoverable, which is
   * exactly the guarantee the server makes.
   */
  ctx.dismissMyMcpApiKeyReveal = (): void => {
    ctx.myMcpApiKeyCreated.value = null
  }

  ctx.fetchMyImIdentity = (): void => {
    send({ type: 'get_my_im_identity' })
  }

  ctx.createImIdentityChallenge = (robotId: string): void => {
    send({ type: 'create_im_identity_challenge', robotId })
  }

  ctx.cancelImIdentityChallenge = (challengeId: string): void => {
    send({ type: 'cancel_im_identity_challenge', challengeId })
  }

  ctx.revokeMyImIdentity = (bindingId: string): void => {
    send({ type: 'revoke_my_im_identity', bindingId })
  }

  ctx.dismissImIdentityChallengeReveal = (): void => {
    ctx.imIdentityChallengeCreated.value = null
  }

  // ---- Account × workspace access (administrator-only) ----

  /** Load the account × workspace roster. Refused server-side for a non-admin. */
  ctx.fetchUserWorkspaceAccess = (): void => {
    send({ type: 'get_user_workspace_access' })
  }

  /**
   * Replace ONE account's policy. `workspaces` is the complete selected set —
   * never what a search box happens to be showing — so filtering the view cannot
   * revoke a hidden selection.
   */
  ctx.saveUserWorkspaceAccess = (payload: {
    subject: string
    mode: WorkspaceScopeMode
    workspaces: string[]
  }): void => {
    send({ type: 'save_user_workspace_access', ...payload })
  }

  /** Refresh the read-only "who can reach this workspace" list. */
  ctx.fetchWorkspaceAccessors = (): void => {
    const id = currentWorkspace.value
    if (!id) return
    send({ type: 'get_workspace_accessors', workspaceName: id })
  }

  /** Close the system-settings panel. */
  ctx.closeSettings = (): void => {
    settingsOpen.value = false
  }

  /**
   * The workspace-setting page's "go configure this in system settings" jump.
   * Closes the workspace page first so the two modals never stack.
   */
  ctx.openSettingsFromWorkspaceSetting = (): void => {
    workspaceSettingOpen.value = false
    ctx.openSettings()
  }

  /**
   * The personal key page's "go configure the public address" jump. Closes the
   * page first so the two panels never stack — which also drops any revealed
   * plaintext, exactly as an ordinary close does.
   */
  ctx.openSettingsFromPersonalizedSetting = (): void => {
    ctx.closePersonalizedSetting()
    ctx.openSettings()
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

  /**
   * Set the console UI font scale at runtime (no page reload): write the ratio onto
   * the root element's `--c-font-scale`, record it in this browser, then persist it
   * for the current identity — the same immediate-apply, immediate-save shape the
   * language and theme use. The saved payload is the whole settings object, so a
   * scale change never drops the language or theme (and vice versa).
   * If the WS send fails, roll the CSS variable, the browser record and the
   * in-memory snapshot all the way back and toast.
   */
  ctx.setFontScale = (next: number): void => {
    const previousSettings = personalizedSettings.value
    const prev = previousSettings.fontScale ?? DEFAULT_FONT_SCALE
    if (next === prev) return
    applyFontScale(next)
    writeLocalPersonalized({ fontScale: next })
    personalizedSettings.value = { ...previousSettings, fontScale: next }
    try {
      if (!ctx.client) throw new Error('no connection')
      send({ type: 'save_personalized_settings', settings: personalizedSettings.value })
    } catch {
      applyFontScale(prev)
      writeLocalPersonalized({ fontScale: prev })
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
