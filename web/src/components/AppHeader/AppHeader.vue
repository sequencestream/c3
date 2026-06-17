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
// 仅管理员显示系统设置入口(ADR-0023 authz)。无认证 / 握手前 isAdmin 默认 true,
// 故无认证场景行为不变;服务端 save_settings 仍是真正的鉴权门(AUTH-R10)。
const { isAdmin } = useAuth()

// 移动端「⋯」操作菜单:受控 <details>,选任一项或点页面其它位置即关闭。
// 原生 details 既不在选项点击后收起,也无外部点击关闭——会悬浮在打开的 sheet 之上。
const actionsEl = ref<HTMLDetailsElement | null>(null)

function closeActions(): void {
  if (actionsEl.value) actionsEl.value.open = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!actionsEl.value?.open) return
  if (!actionsEl.value.contains(event.target as Node)) closeActions()
}

function onActionsToggle(): void {
  if (actionsEl.value?.open) {
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
  emit('logout')
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
}>()

function licenseBadgeKey(state: string): LocaleKey {
  if (state === 'active') return 'license.badge.active' as LocaleKey
  if (state === 'grace') return 'license.badge.grace' as LocaleKey
  if (state === 'expired') return 'license.badge.expired' as LocaleKey
  if (state === 'unactivated') return 'license.badge.unactivated' as LocaleKey
  if (state === 'disabled') return 'license.badge.disabled' as LocaleKey
  return 'license.badge.unactivated' as LocaleKey
}

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

        <!-- Product-license badge (PL-R7): clickable to open LS sign-in if not entitled;
             unactivated 态改用右侧连接状态旁的红色小字,不渲染按钮。 -->
        <button
          v-if="license && license.state !== 'unactivated'"
          class="license-badge"
          :class="license.state"
          :title="t('license.activate.button')"
          @click="emit('activate-license')"
        >
          {{ t(licenseBadgeKey(license.state)) }}
        </button>

        <!-- 有效期/到期日(PL-R7):entitled 且 termEnd>0 时展示 -->
        <span v-if="licenseTermText" class="license-term">{{ licenseTermText }}</span>

        <button
          v-if="isAdmin"
          class="icon-btn settings-btn"
          :title="t('nav.settings.tooltip')"
          @click="emit('open-settings')"
        >
          ⚙
        </button>
        <button
          v-if="showLogout"
          class="icon-btn logout-btn"
          :title="t('auth.logout.tooltip')"
          @click="emit('logout')"
        >
          {{ t('auth.logout.label') }}
        </button>
        <span class="status" :class="status === 'open' ? 'ok' : 'err'">
          {{ status }}
        </span>
        <!-- unactivated 态红色小字,显示在连接状态右侧(PL-R7) -->
        <span v-if="license && license.state === 'unactivated'" class="license-unactivated">
          {{ t(licenseBadgeKey(license.state)) }}
        </span>
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

      <details ref="actionsEl" class="mobile-actions" @toggle="onActionsToggle">
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
          <button v-if="showLogout" class="mobile-action-item" @click="chooseLogout">
            {{ t('auth.logout.label') }}
          </button>
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

/* unactivated 红色小字(PL-R7):紧随连接状态,非按钮 */
.license-unactivated {
  font-size: var(--fs-caption);
  color: var(--c-red);
  white-space: nowrap;
}

/* license 有效期/到期日(PL-R7):紧随 badge 的弱化文案 */
.license-term {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  white-space: nowrap;
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

  .license-badge {
    font-size: var(--fs-caption);
    border: 1px solid var(--c-border);
    border-radius: var(--radius-sm);
    padding: var(--sp-1) var(--sp-2);
    background: transparent;
    cursor: pointer;
    white-space: nowrap;
  }
  .license-badge.active {
    color: var(--c-green);
    border-color: var(--c-green);
  }
  .license-badge.grace {
    color: var(--c-yellow);
    border-color: var(--c-yellow);
  }
  .license-badge.expired,
  .license-badge.disabled {
    color: var(--c-red);
    border-color: var(--c-red);
  }
  .license-badge.unactivated {
    color: var(--c-text-dim);
    border-color: var(--c-border);
  }
}
</style>
