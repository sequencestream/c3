<script setup lang="ts">
/*
 * AppHeader.vue — 应用导航壳:桌面顶部栏;移动端顶部精简栏 + 底部 5 视图 tab。
 * 会话标题与权限模式已下移到聊天列顶部的 SessionTitleBar(WC-R9)。
 *
 * 2026-06-08 新增 viewMode 支持:
 * - workspace 模式:左侧 WS switcher + 项目配置,中间标签页,右侧 viewMode 切换 + 设置
 * - workcenter 模式:左侧 workcenter 导航按钮,中间区域隐藏,右侧 viewMode 切换 + 设置
 */
import WorkspaceSwitcher from '../WorkspaceSwitcher/WorkspaceSwitcher.vue'
import type { LicenseStatus, WorkspaceInfo } from '@ccc/shared/protocol'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import { useAuth } from '@/composables/useAuth'
import { computed, onBeforeUnmount, ref } from 'vue'

const { t, d } = useTypedI18n()

// c3 控制台:查看密钥信息 / 续期。密钥按钮在许可下拉内跳转此地址(新标签页)。
const LICENSE_CONSOLE_URL = 'https://c3.sequencestream.com/'
// 仅管理员显示系统设置入口(ADR-0023 authz)。无认证 / 握手前 isAdmin 默认 true,
// 故无认证场景行为不变;服务端 save_settings 仍是真正的鉴权门(AUTH-R10)。
// 登录身份(basic 用户名 / oauth 邮箱),响应式来自每个 `ready`。供桌面账户菜单与
// 移动操作菜单展示「当前登录的是谁」;未登录时为 null(此时 showLogout 亦为 false)。
const { isAdmin, subject } = useAuth()

// 受控 <details> 浮层(移动端「⋯」操作菜单 + 桌面许可状态下拉 + 桌面账户下拉):原生
// details 既不在选项点击后收起,也无外部点击关闭——会悬浮在打开的 sheet/页面之上。
// 三个浮层共用一个文档级 pointerdown 监听,任一打开即挂载、全部关闭即卸载。
const actionsEl = ref<HTMLDetailsElement | null>(null)
const licenseEl = ref<HTMLDetailsElement | null>(null)
const accountEl = ref<HTMLDetailsElement | null>(null)

function closeActions(): void {
  if (actionsEl.value) actionsEl.value.open = false
}

function closeLicense(): void {
  if (licenseEl.value) licenseEl.value.open = false
}

function closeAccount(): void {
  if (accountEl.value) accountEl.value.open = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (actionsEl.value?.open && !actionsEl.value.contains(target)) closeActions()
  if (licenseEl.value?.open && !licenseEl.value.contains(target)) closeLicense()
  if (accountEl.value?.open && !accountEl.value.contains(target)) closeAccount()
}

function syncOutsideListener(): void {
  if (actionsEl.value?.open || licenseEl.value?.open || accountEl.value?.open) {
    document.addEventListener('pointerdown', onDocumentPointerDown)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
  }
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

// 菜单项:先收起菜单再上抛动作,避免浮层悬停在随后打开的 sheet 之上。
function chooseWorkspaceSetting(): void {
  closeActions()
  emit('open-workspace-setting')
}
function chooseSettings(): void {
  closeActions()
  emit('open-settings')
}
function chooseLogout(): void {
  closeActions()
  closeAccount()
  emit('logout')
}
// 触发激活流程:收起两个浮层(桌面许可下拉 / 移动操作菜单皆可承载该入口)再上抛。
function chooseActivate(): void {
  closeLicense()
  closeActions()
  emit('activate-license')
}

interface HeaderTab {
  key: string
  label: string
  badgeCount?: number
}

const props = defineProps<{
  workspaces: WorkspaceInfo[]
  currentWorkspace: string | null
  status: 'connecting' | 'open' | 'closed'
  /** Top-bar tabs (data-driven so a future tab is one more entry). */
  tabs: HeaderTab[]
  /** Currently selected tab key. */
  activeTab: string
  /** Tabs require a current workspace; disabled until one is selected. */
  tabsEnabled?: boolean
  /** Current view mode: workspace or workcenter. */
  viewMode: 'workspace' | 'workcenter'
  /** Pending user-involve events shown on the WorkCenter tab. */
  workcenterBadgeCount?: number
  /** Show the logout button. Only true once authenticated (ADR-0023); when auth
   *  is disabled this stays false so the no-auth UI is unchanged. */
  showLogout?: boolean
  /** Current product-license status for the badge/menu (PL-R7). Null when not yet known. */
  license?: LicenseStatus | null
  /** A manual term refresh (`refresh-license`) is in flight; disables the control + shows loading (PL-R7). */
  licenseRefreshing?: boolean
  /** Inline error shown beside the refresh control when the last manual sync failed (PL-R7). */
  licenseRefreshError?: string | null
}>()

const emit = defineEmits<{
  'select-tab': [key: string]
  'open-settings': []
  'open-workspace-setting': []
  'add-workspace': [path: string]
  'select-workspace': [path: string]
  'remove-workspace': [path: string]
  'update:viewMode': [mode: 'workspace' | 'workcenter']
  logout: []
  'activate-license': []
  'refresh-license': []
}>()

function licenseBadgeKey(state: string): LocaleKey {
  if (state === 'active') return 'license.badge.active' as LocaleKey
  if (state === 'grace') return 'license.badge.grace' as LocaleKey
  if (state === 'expired') return 'license.badge.expired' as LocaleKey
  if (state === 'unactivated') return 'license.badge.unactivated' as LocaleKey
  if (state === 'disabled') return 'license.badge.disabled' as LocaleKey
  return 'license.badge.unactivated' as LocaleKey
}

// 已激活态(entitled):active/grace。决定许可状态控件渲染哪一支——
// 已激活 → 图标 + 信息下拉;未激活/过期/停用 → 红色带下划线文字 + 激活下拉。
const licenseEntitled = computed<boolean>(() => {
  const s = props.license?.state
  return s === 'active' || s === 'grace'
})

// 有效期/到期日(PL-R7):仅 entitled(active/grace)且 termEnd 已知(>0)时展示;
// 过期/未激活/被禁用态沿用 badge 状态文案,不渲染日期。termEnd 是 unix 秒。
const licenseTermText = computed<string>(() => {
  const lic = props.license
  if (!lic) return ''
  if (lic.state !== 'active' && lic.state !== 'grace') return ''
  if (!lic.termEnd || lic.termEnd <= 0) return ''
  const date = d(new Date(lic.termEnd * 1000), 'date')
  return t('license.badge.validUntil' as LocaleKey, { date })
})

// 手动刷新有效期(PL-R7):点击触发一次到 LS 的即时 heartbeat 同步 termEnd。
// 节流仅前端:在途(licenseRefreshing)期间禁用 + 最小冷却间隔防连点;失败由父级
// 经 licenseRefreshError 下传,在按钮旁 inline 展示。
const REFRESH_COOLDOWN_MS = 3000
const refreshCooldown = ref(false)
let refreshCooldownTimer: ReturnType<typeof setTimeout> | undefined
const refreshDisabled = computed<boolean>(
  () => props.licenseRefreshing === true || refreshCooldown.value,
)
function onRefreshLicense(): void {
  if (refreshDisabled.value) return
  emit('refresh-license')
  refreshCooldown.value = true
  refreshCooldownTimer = setTimeout(() => {
    refreshCooldown.value = false
  }, REFRESH_COOLDOWN_MS)
}
onBeforeUnmount(() => {
  if (refreshCooldownTimer) clearTimeout(refreshCooldownTimer)
})

function isTabDisabled(tab: HeaderTab): boolean {
  return tab.key !== 'workcenter' && props.tabsEnabled === false
}

function isTabActive(tab: HeaderTab): boolean {
  if (tab.key === 'workcenter') return props.viewMode === 'workcenter'
  return props.viewMode === 'workspace' && tab.key === props.activeTab
}

function selectTab(tab: HeaderTab): void {
  if (isTabDisabled(tab)) return
  if (tab.key === 'workcenter') {
    emit('update:viewMode', 'workcenter')
    return
  }
  if (props.viewMode !== 'workspace') emit('update:viewMode', 'workspace')
  emit('select-tab', tab.key)
}
</script>

<template>
  <header class="app-header">
    <div class="desktop-header-row">
      <!-- Left area: workspace mode — WorkspaceSwitcher + project config -->
      <template v-if="viewMode === 'workspace'">
        <WorkspaceSwitcher
          :workspaces="workspaces"
          :current-workspace-id="currentWorkspace"
          @add-workspace="emit('add-workspace', $event)"
          @select-workspace="emit('select-workspace', $event)"
          @remove-workspace="emit('remove-workspace', $event)"
        />
        <button
          class="icon-btn project-config-btn"
          :title="t('workspaceSetting.entry.tooltip')"
          :disabled="!currentWorkspace"
          @click="emit('open-workspace-setting')"
        >
          ⚙
        </button>
      </template>

      <!-- Left area: workcenter mode — nav button -->
      <template v-else>
        <button class="header-tab active" disabled>
          {{ t('workcenter.title') }}
        </button>
      </template>

      <!-- Middle: workspace tabs (hidden in workcenter mode) -->
      <nav
        v-if="viewMode === 'workspace'"
        class="header-tabs"
        :class="{ disabled: tabsEnabled === false }"
      >
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="header-tab"
          :class="{ active: tab.key === activeTab, 'has-badge': (tab.badgeCount ?? 0) > 0 }"
          :disabled="tabsEnabled === false"
          @click="emit('select-tab', tab.key)"
        >
          {{ tab.label }}
          <span v-if="tab.badgeCount" class="tab-badge">{{ tab.badgeCount }}</span>
        </button>
      </nav>

      <!-- Right area: viewMode toggle + settings + status -->
      <div class="header-right">
        <div class="view-mode-toggle">
          <button
            class="vm-toggle-btn"
            :class="{ active: viewMode === 'workspace' }"
            @click="emit('update:viewMode', 'workspace')"
          >
            {{ t('nav.viewMode.workspace') }}
          </button>
          <button
            class="vm-toggle-btn"
            :class="{ active: viewMode === 'workcenter' }"
            @click="emit('update:viewMode', 'workcenter')"
          >
            {{ t('nav.viewMode.workcenter') }}
          </button>
        </div>

        <button
          v-if="isAdmin"
          class="icon-btn settings-btn"
          :title="t('nav.settings.tooltip')"
          @click="emit('open-settings')"
        >
          ⚙
        </button>
        <!-- 账户菜单(ADR-0023):受控 <details>,人形图标触发,展开显示登录名 + 登出。
             仅已认证(showLogout)时渲染——无认证 / none / 未配置 basic 时整体隐藏。 -->
        <details
          v-if="showLogout"
          ref="accountEl"
          class="account-menu"
          @toggle="syncOutsideListener"
        >
          <summary
            class="icon-btn account-trigger"
            :title="t('auth.account.tooltip')"
            :aria-label="t('auth.account.tooltip')"
          >
            <svg
              class="account-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              aria-hidden="true"
              focusable="false"
            >
              <path
                fill="currentColor"
                d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.42 0-8 2.69-8 6v2h16v-2c0-3.31-3.58-6-8-6Z"
              />
            </svg>
          </summary>
          <div class="account-dropdown">
            <div v-if="subject" class="account-name" :title="subject">{{ subject }}</div>
            <button class="account-logout-btn" @click="chooseLogout">
              {{ t('auth.logout.label') }}
            </button>
          </div>
        </details>
        <span class="status" :class="status === 'open' ? 'ok' : 'err'">
          {{ status }}
        </span>

        <!-- Product-license 状态控件(PL-R7),受控 <details> 下拉。位于连接状态右侧、
             顶栏最右:
             · 已激活(active/grace)→ ✓ 图标(按 state 着色),下拉显示许可密钥 + 有效期
             · 未激活/过期/停用 → 圆圈内红色感叹号图标,下拉内「激活许可」按钮触发激活流程 -->
        <details v-if="license" ref="licenseEl" class="license-menu" @toggle="syncOutsideListener">
          <summary
            class="license-trigger"
            :class="licenseEntitled ? 'entitled' : 'unentitled'"
            :aria-label="t(licenseBadgeKey(license.state))"
          >
            <span
              v-if="licenseEntitled"
              class="license-icon"
              :class="license.state"
              :title="t(licenseBadgeKey(license.state))"
              aria-hidden="true"
              >✓</span
            >
            <span
              v-else
              class="license-icon license-warn"
              :title="t(licenseBadgeKey(license.state))"
              aria-hidden="true"
              >!</span
            >
          </summary>
          <div class="license-dropdown">
            <template v-if="licenseEntitled">
              <!-- 已激活:展示有效期(.license-term)+ 右侧密钥按钮(跳转 c3 控制台查看/续期);
                   term 未知(termEnd=0)时回退为状态文案。 -->
              <div v-if="licenseTermText" class="license-info-row license-term">
                <span class="license-term-text">{{ licenseTermText }}</span>
                <button
                  type="button"
                  class="license-refresh-btn"
                  :disabled="refreshDisabled"
                  :title="t('license.refresh.label' as LocaleKey)"
                  :aria-label="t('license.refresh.label' as LocaleKey)"
                  @click="onRefreshLicense"
                >
                  <span class="license-refresh-icon" :class="{ spinning: licenseRefreshing }"
                    >⟳</span
                  >
                </button>
                <a
                  class="license-key-btn"
                  :href="LICENSE_CONSOLE_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  :title="t('license.badge.manageKey' as LocaleKey)"
                  :aria-label="t('license.badge.manageKey' as LocaleKey)"
                  @click="closeLicense"
                  >🔑</a
                >
              </div>
              <div v-else class="license-info-row">{{ t(licenseBadgeKey(license.state)) }}</div>
              <!-- 手动刷新失败(网络 / LS 5xx,heartbeat fail-soft 不抛)→ 按钮旁 inline 提示,
                   不改变已缓存有效期(PL-R7)。 -->
              <p
                v-if="licenseRefreshError"
                class="license-refresh-error"
                role="alert"
                :title="licenseRefreshError"
              >
                {{ licenseRefreshError }}
              </p>
            </template>
            <button v-else class="license-activate-btn" @click="chooseActivate">
              {{ t('license.activate.button') }}
            </button>
          </div>
        </details>
      </div>
    </div>

    <div class="mobile-header-row">
      <div class="mobile-workspace">
        <WorkspaceSwitcher
          :workspaces="workspaces"
          :current-workspace-id="currentWorkspace"
          @add-workspace="emit('add-workspace', $event)"
          @select-workspace="emit('select-workspace', $event)"
          @remove-workspace="emit('remove-workspace', $event)"
        />
      </div>

      <details ref="actionsEl" class="mobile-actions" @toggle="syncOutsideListener">
        <summary class="icon-btn mobile-actions-trigger" aria-label="Actions">⋯</summary>
        <div class="mobile-actions-menu">
          <button
            class="mobile-action-item"
            :disabled="!currentWorkspace"
            @click="chooseWorkspaceSetting"
          >
            {{ t('workspaceSetting.entry.tooltip') }}
          </button>
          <button v-if="isAdmin" class="mobile-action-item" @click="chooseSettings">
            {{ t('nav.settings.tooltip') }}
          </button>
          <!-- 账户区(ADR-0023):仅已认证时出现——展示登录名(静态)+ 登出项。 -->
          <span v-if="showLogout && subject" class="mobile-action-item account-name-static">
            {{ subject }}
          </span>
          <button v-if="showLogout" class="mobile-action-item" @click="chooseLogout">
            {{ t('auth.logout.label') }}
          </button>
          <!-- 许可状态(PL-R7):移动端并入操作菜单——已激活展示密钥/有效期(只读),
               未激活/过期/停用为红色「激活」项,点击触发激活流程并收起菜单。 -->
          <template v-if="license">
            <button
              v-if="!licenseEntitled"
              class="mobile-action-item license-needs"
              @click="chooseActivate"
            >
              {{ t(licenseBadgeKey(license.state)) }} · {{ t('license.activate.button') }}
            </button>
            <span v-else class="mobile-action-item license-info-static">
              ✓ {{ licenseTermText || t(licenseBadgeKey(license.state)) }}
            </span>
          </template>
          <span class="status mobile-status" :class="status === 'open' ? 'ok' : 'err'">
            {{ status }}
          </span>
        </div>
      </details>
    </div>

    <nav class="mobile-bottom-tabs" role="tablist" aria-label="Primary views">
      <button
        v-for="tab in [
          ...tabs,
          {
            key: 'workcenter',
            label: t('nav.tab.workcenter.label'),
            badgeCount: workcenterBadgeCount,
          },
        ]"
        :key="tab.key"
        class="mobile-bottom-tab"
        :class="{ active: isTabActive(tab), 'has-badge': (tab.badgeCount ?? 0) > 0 }"
        :disabled="isTabDisabled(tab)"
        role="tab"
        :aria-selected="isTabActive(tab)"
        @click="selectTab(tab)"
      >
        <span class="mobile-tab-label">{{ tab.label }}</span>
        <span v-if="tab.badgeCount" class="tab-badge">{{ tab.badgeCount }}</span>
      </button>
    </nav>
  </header>
</template>

<style scoped>
.desktop-header-row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: var(--sp-3);
}

.mobile-header-row,
.mobile-bottom-tabs {
  display: none;
}

.view-mode-toggle {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.vm-toggle-btn {
  background: transparent;
  border: none;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--c-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
  line-height: 1.6;
}
.vm-toggle-btn:not(:last-child) {
  border-right: 1px solid var(--c-border);
}
.vm-toggle-btn:hover {
  color: var(--c-text);
  background: var(--c-card);
}
.vm-toggle-btn.active {
  color: var(--c-text);
  background: var(--c-card);
}

/* Product-license 状态控件(PL-R7):受控 <details> 下拉 */
.license-menu {
  position: relative;
}
.license-trigger {
  list-style: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  user-select: none;
}
.license-trigger::-webkit-details-marker {
  display: none;
}
/* 未激活/过期/停用:红色带下划线文字 */
.license-trigger .license-needs {
  font-size: var(--fs-caption);
  color: var(--c-red);
  text-decoration: underline;
  text-underline-offset: 2px;
  white-space: nowrap;
}
/* 已激活:体现"已激活"概念的 ✓ 图标,按 state 着色 */
.license-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid currentColor;
  font-size: 11px;
  line-height: 1;
}
.license-icon.active {
  color: var(--c-green);
}
.license-icon.grace {
  color: var(--c-yellow);
}
/* 未激活/过期/停用:圆圈内红色感叹号 */
.license-icon.license-warn {
  color: var(--c-red);
  font-weight: 700;
}

.license-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + var(--sp-2));
  z-index: 120;
  min-width: 220px;
  max-width: 320px;
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-1);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}
.license-info-row {
  font-size: var(--fs-caption);
  color: var(--c-text);
}
.license-term {
  color: var(--c-text-muted);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.license-term-text {
  flex: 1 1 auto;
  min-width: 0;
}
.license-key-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: var(--fs-caption);
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}
.license-key-btn:hover {
  background: var(--c-card);
}
/* 手动刷新有效期按钮(PL-R7):与密钥按钮同尺寸,在途旋转、禁用降透明 */
.license-refresh-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: transparent;
  font-size: var(--fs-caption);
  line-height: 1;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}
.license-refresh-btn:hover:not(:disabled) {
  background: var(--c-card);
}
.license-refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.license-refresh-icon {
  display: inline-block;
}
.license-refresh-icon.spinning {
  animation: license-refresh-spin 0.8s linear infinite;
}
@keyframes license-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
.license-refresh-error {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-red);
}
.license-activate-btn {
  width: 100%;
  min-height: 32px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--c-red);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-red);
  font-size: var(--fs-caption);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}
.license-activate-btn:hover {
  background: var(--c-card);
}

/* 账户菜单(ADR-0023):受控 <details> 下拉,人形图标触发 */
.account-menu {
  position: relative;
}
.account-trigger {
  list-style: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}
.account-trigger::-webkit-details-marker {
  display: none;
}
.account-icon {
  display: block;
}
.account-dropdown {
  position: absolute;
  right: 0;
  top: calc(100% + var(--sp-2));
  z-index: 120;
  min-width: 180px;
  max-width: 280px;
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-1);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}
.account-name {
  padding: var(--sp-1) var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-logout-btn {
  width: 100%;
  min-height: 32px;
  padding: 0 var(--sp-3);
  text-align: left;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--c-text);
  font-size: var(--fs-caption);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-standard);
}
.account-logout-btn:hover {
  background: var(--c-card);
}

@media (max-width: 767px) {
  .app-header {
    height: auto;
    padding: 0;
    display: block;
    background: var(--c-panel);
    border-bottom: 0;
  }

  .desktop-header-row {
    display: none;
  }

  .mobile-header-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    height: 44px;
    padding: 0 var(--sp-3);
    border-bottom: 1px solid var(--c-border);
  }

  .mobile-workspace {
    min-width: 0;
    flex: 1;
  }

  .mobile-actions {
    position: relative;
    flex-shrink: 0;
  }

  .mobile-actions-trigger {
    list-style: none;
    font-size: 20px;
  }

  .mobile-actions-trigger::-webkit-details-marker {
    display: none;
  }

  .mobile-actions-menu {
    position: absolute;
    right: 0;
    top: calc(100% + var(--sp-2));
    z-index: 120;
    min-width: 190px;
    padding: var(--sp-2);
    display: grid;
    gap: var(--sp-1);
    background: var(--c-panel);
    border: 1px solid var(--c-border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
  }

  .mobile-action-item {
    min-height: 34px;
    padding: 0 var(--sp-3);
    text-align: left;
    color: var(--c-text);
    background: transparent;
    border: 0;
    border-radius: var(--radius-sm);
    font-size: var(--fs-caption);
  }

  .mobile-action-item:active:not(:disabled) {
    background: var(--c-card);
  }

  .mobile-action-item:disabled {
    opacity: 0.5;
  }

  .mobile-status {
    padding: var(--sp-1) var(--sp-3);
  }

  .mobile-bottom-tabs {
    position: fixed;
    left: var(--safe-area-left);
    right: var(--safe-area-right);
    bottom: 0;
    z-index: 90;
    height: calc(56px + var(--safe-area-bottom));
    padding: 0 var(--sp-1) var(--safe-area-bottom);
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    background: var(--c-panel);
    border-top: 1px solid var(--c-border);
  }

  .mobile-bottom-tab {
    position: relative;
    min-width: 0;
    min-height: 56px;
    padding: var(--sp-1);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--c-text-muted);
    background: transparent;
    border: 0;
    border-radius: 0;
    font-size: 11px;
    line-height: 1.15;
  }

  .mobile-bottom-tab.active {
    color: var(--c-text);
    background: var(--c-card);
  }

  .mobile-bottom-tab:disabled {
    opacity: 0.5;
  }

  .mobile-tab-label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mobile-bottom-tab .tab-badge {
    position: absolute;
    top: 7px;
    right: max(8px, calc(50% - 28px));
    margin-left: 0;
  }

  /* 移动操作菜单内的许可项(PL-R7) */
  .mobile-action-item.license-needs {
    color: var(--c-red);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .mobile-action-item.license-info-static {
    color: var(--c-text-muted);
    white-space: normal;
    word-break: break-all;
    cursor: default;
  }
  /* 移动操作菜单内的登录名(ADR-0023):静态只读,与登出项区分 */
  .mobile-action-item.account-name-static {
    color: var(--c-text-muted);
    white-space: normal;
    word-break: break-all;
    cursor: default;
  }
}
</style>
