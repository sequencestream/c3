<script setup lang="ts">
import type { WorkcenterPage } from '@/controls/state'
/*
 * AppHeader.vue — 工作区上下文顶部栏；移动端另含精简栏与底部子 tab。
 * 会话标题与权限模式已下移到聊天列顶部的 SessionTitleBar(WC-R9)。
 *
 * 桌面行只承载工作区内部子页面标签。工作台的用户通知、总览、聊天机器人，以及升级、
 * 设置、账户、连接状态均由左侧系统竖条承载；工作台视图不渲染顶部栏。
 * 移动端不渲染竖条,精简行因此保留同款 viewMode 切换器与工作区切换器,窄屏仍能切工作区、
 * 进工作台;两处共用同一份图标标记与状态。
 * 待处理事件角标(workcenterBadgeCount)挂在移动端「用户通知」入口上,与桌面竖条同源;
 * 0/缺省不渲染。
 * 移动端底部 tab 与桌面共用 tabs 数据。
 *
 * tab 角标:数值由上层(HEADER_TABS)给定,本组件只负责渲染 —— badgeCount 为 0/缺省时
 * 桌面与移动端均不渲染;角标不绑定任何事件,点击只沿用所在 tab 的导航行为。「会话」tab
 * 的数字是进行中会话数,「意图/讨论/自动化」是进行中条目数(按 owner 去重),两者口径不同,
 * 故无障碍文案取各 tab 自带的 badgeAriaLabel。
 */
import WorkspaceSwitcher from '../WorkspaceSwitcher/WorkspaceSwitcher.vue'
import AddWorkspaceDialog from '../AddWorkspaceDialog/AddWorkspaceDialog.vue'
import ConfirmDialog from '../ConfirmDialog/ConfirmDialog.vue'
import type { SelfUpdateState, UpdateStatus, WorkspaceInfo } from '@ccc/shared/protocol'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import { translateUiError } from '@/i18n/errors'
import { useAuth } from '@/composables/useAuth'
import { logsUrl } from '@/lib/logs-route'
import type { WorkspaceDirectoryPickerState } from '@/controls/state'
import { computed, onBeforeUnmount, ref } from 'vue'

const { t } = useTypedI18n()

// 外链兜底:仅当这台机器不能自更新(dev 运行 / 桌面壳托管 / 包管理器安装 / 目录不可写)
// 时出现,点击新标签页跳到发布页,由用户按自己的安装方式升级。
const RELEASES_URL = 'https://github.com/sequencestream/c3/releases/latest'
// 连接状态同时是运行日志的入口:普通链接 + target=_blank,新标签页里打开独立的日志
// 页面(自带 socket 与轮询),本页照常操作不受影响。
const logsHref = logsUrl(window.location)
// 仅管理员显示系统设置入口(ADR-0023 authz)。无认证 / 握手前 isAdmin 默认 true,
// 故无认证场景行为不变;服务端 save_settings 仍是真正的鉴权门(AUTH-R10)。
// 登录身份(basic 用户名),响应式来自每个 `ready`,供移动操作菜单展示。
const { isAdmin, subject } = useAuth()

// 移动端「⋯」菜单用受控 <details>:选项点击与外部点击都要主动收起。
const actionsEl = ref<HTMLDetailsElement | null>(null)

function closeActions(): void {
  if (actionsEl.value) actionsEl.value.open = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (actionsEl.value?.open && !actionsEl.value.contains(target)) closeActions()
}

function syncOutsideListener(): void {
  if (actionsEl.value?.open) {
    document.addEventListener('pointerdown', onDocumentPointerDown)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown)
  }
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown))

// 菜单项:先收起菜单再上抛动作,避免浮层悬停在随后打开的 sheet 之上。
function chooseSettings(): void {
  closeActions()
  emit('open-settings')
}
function choosePersonalizedSetting(): void {
  closeActions()
  emit('open-personalized-setting')
}
function chooseLogout(): void {
  closeActions()
  emit('logout')
}

interface HeaderTab {
  key: string
  label: string
  /** 进行中数量;0 / 缺省时不渲染角标。 */
  badgeCount?: number
  /** 该 tab 角标的无障碍文案(由上层按 tab 语义生成)。缺省时退回「会话」文案。 */
  badgeAriaLabel?: string
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
  workspaceSettingOpen?: boolean
  /** Current view mode: workspace or workcenter. */
  viewMode: 'workspace' | 'workcenter'
  /** Current workcenter page (drives the top-bar page entries' selected state). */
  workcenterPage?: WorkcenterPage
  /** Pending user-involve events shown on the「用户通知」workcenter page entry. */
  workcenterBadgeCount?: number
  /** Show the logout button. Only true once authenticated (ADR-0023); when auth
   *  is disabled this stays false so the no-auth UI is unchanged. */
  showLogout?: boolean
  /** Server-detected update-availability snapshot; drives the header upgrade hint. */
  updateStatus?: UpdateStatus | null
  /** Server-driven self-update pipeline; turns the hint into progress + a restart action. */
  selfUpdate?: SelfUpdateState | null
  /** 「新增工作区」弹框的受控开关(两处切换器共用一个实例):手动「+」与冷启动引导共写。 */
  addWorkspaceOpen?: boolean
  /** 新增工作区弹框里那次原生目录选择的状态,由控制器按 requestId 关联后给出。 */
  workspaceDirectoryPicker?: WorkspaceDirectoryPickerState
}>()

const emit = defineEmits<{
  'select-tab': [key: string]
  'open-settings': []
  'open-personalized-setting': []
  'open-workspace-setting': []
  'add-workspace': [payload: { workspaceName: string; path: string }]
  'select-workspace-directory': []
  'update:addWorkspaceOpen': [open: boolean]
  'select-workspace': [path: string]
  'remove-workspace': [path: string]
  'update:viewMode': [mode: 'workspace' | 'workcenter']
  'select-workcenter-page': [page: WorkcenterPage]
  'start-self-update': []
  'apply-self-update': []
  logout: []
}>()

// 新增工作区弹框由顶栏单实例持有:确认上抛既有 `add-workspace` 载荷(路径唯一的合法
// 入口)并关闭,取消只关闭;两处切换器的「+」与冷启动引导共用同一个开关。
function onAddWorkspaceConfirm(payload: { workspaceName: string; path: string }): void {
  emit('add-workspace', payload)
  emit('update:addWorkspaceOpen', false)
}

// 目录选择失败是服务端给的结构化原因,在这里译成本地文案 —— 弹框只收已本地化的字符串。
const workspaceDirectoryError = computed(() => {
  const error = props.workspaceDirectoryPicker?.error
  return error ? translateUiError(error) : null
})

// 新版本提示:仅当服务端判定"有更新"且已知最新版本号时为真;无更新 / 未知 / 检查失败
// 都表现为 false(available=false 或 latestVersion 为空)。
const showUpdate = computed<boolean>(
  () => props.updateStatus?.available === true && !!props.updateStatus.latestVersion,
)

// 下载进度百分比。服务端不给总字节数时按 0 处理 —— 宁可不显示进度,也不编一个数字。
const downloadPercent = computed<number>(() => {
  const su = props.selfUpdate
  if (!su || su.totalBytes <= 0) return 0
  return Math.min(100, Math.round((su.downloadedBytes / su.totalBytes) * 100))
})

/**
 * 顶栏更新胶囊的形态。一个控件按服务端状态换形:
 * - `link`   本机不能自更新(dev / 桌面壳托管 / 包管理器 / 目录不可写)→ 外链发布页
 * - `download` 有新版但还没开始下载 → 点击手动开始(常态下服务端已自动下载)
 * - `progress` 下载 / 校验中 → 不可点,显示百分比
 * - `restart`  已就绪且是管理员 → 点击二次确认后重启生效
 * - `pending`  已就绪但不是管理员 → 只告知,等管理员重启
 * - `applying` 正在重启 → 不可点;连接随即断开,由 WS 自动重连回到新版本
 * - `retry`    失败且是管理员 → 点击重试
 * 都不满足时不渲染。
 */
type UpdatePillKind =
  'link' | 'download' | 'progress' | 'restart' | 'pending' | 'applying' | 'retry'

const updatePill = computed<{ kind: UpdatePillKind; text: string } | null>(() => {
  const su = props.selfUpdate
  const latest = props.updateStatus?.latestVersion ?? null
  const target = su?.targetVersion ?? latest
  const phase = su?.phase ?? 'idle'

  if (phase === 'applying') return { kind: 'applying', text: t('nav.update.restarting') }
  if (phase === 'ready' && target) {
    return isAdmin.value
      ? { kind: 'restart', text: t('nav.update.restart', { version: target }) }
      : { kind: 'pending', text: t('nav.update.pendingAdmin', { version: target }) }
  }
  if ((phase === 'downloading' || phase === 'verifying') && target) {
    return {
      kind: 'progress',
      text: t('nav.update.downloading', { version: target, percent: downloadPercent.value }),
    }
  }
  if (!showUpdate.value || !latest) return null
  if (su?.capable && isAdmin.value) {
    return phase === 'failed'
      ? { kind: 'retry', text: t('nav.update.failed', { version: latest }) }
      : { kind: 'download', text: t('nav.update.download', { version: latest }) }
  }
  return { kind: 'link', text: t('nav.update.available', { version: latest }) }
})

// 重启会断开所有人的连接,所以走二次确认(项目约定:危险操作不用 window.confirm)。
const restartConfirmOpen = ref(false)

function onUpdatePillClick(): void {
  const kind = updatePill.value?.kind
  if (kind === 'restart') restartConfirmOpen.value = true
  else if (kind === 'download' || kind === 'retry') emit('start-self-update')
}

// 移动端:先收起「⋯」菜单,再走同一条动作分支(重启确认框在菜单之上照常可见)。
function onMobileUpdatePillClick(): void {
  closeActions()
  onUpdatePillClick()
}

function confirmRestart(): void {
  restartConfirmOpen.value = false
  emit('apply-self-update')
}

// 工作区/工作台两模式切换器仅供移动端使用。
// 当前生效模式图标蓝(--c-primary),另一个灰(--c-text-muted),点击 emit update:viewMode。
const VIEW_MODES: ReadonlyArray<{ key: 'workspace' | 'workcenter'; labelKey: LocaleKey }> = [
  { key: 'workspace', labelKey: 'nav.viewMode.workspace' as LocaleKey },
  { key: 'workcenter', labelKey: 'nav.viewMode.workcenter' as LocaleKey },
]

// 移动端工作台页面入口。「用户通知」携带待处理数角标,计数为 0 时不渲染。
const WORKCENTER_PAGES: ReadonlyArray<{
  key: WorkcenterPage
  labelKey: LocaleKey
  badge?: boolean
}> = [
  { key: 'notifications', labelKey: 'dashboard.nav.notifications' as LocaleKey, badge: true },
  { key: 'dashboard', labelKey: 'dashboard.nav.dashboard' as LocaleKey },
  // Robots are global rather than per-workspace, which is why they live in the
  // workcenter view alongside the cross-workspace pages.
  { key: 'robots', labelKey: 'dashboard.nav.robots' as LocaleKey },
]

// 底部 tab 仅承载工作区子视图(工作台入口已上移到顶部图标切换器);故无 workcenter 分支。
function isTabActive(tab: HeaderTab): boolean {
  return props.viewMode === 'workspace' && tab.key === props.activeTab
}

// 角标无障碍文案:优先用该 tab 自带的文案(意图/讨论/自动化各自的「进行中」语义),
// 上层未提供时退回「会话」文案,桌面与移动端共用同一取值。
function badgeAriaLabel(tab: HeaderTab): string {
  return tab.badgeAriaLabel ?? t('nav.tab.console.ariaLabel', { count: tab.badgeCount ?? 0 })
}

function selectTab(tab: HeaderTab): void {
  if (props.tabsEnabled === false) return
  if (props.viewMode !== 'workspace') emit('update:viewMode', 'workspace')
  emit('select-tab', tab.key)
}
</script>

<template>
  <header class="app-header" :class="{ 'workcenter-header': viewMode === 'workcenter' }">
    <div class="desktop-header-row">
      <!-- 工作区内部子页面仍是上下文标签；工作台页面改由系统竖条独立导航。 -->
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
          <span class="tab-label">
            {{ tab.label }}
            <span v-if="tab.badgeCount" class="tab-badge" :aria-label="badgeAriaLabel(tab)">{{
              tab.badgeCount
            }}</span>
          </span>
        </button>
        <button
          class="header-tab"
          :class="{ active: workspaceSettingOpen }"
          :disabled="tabsEnabled === false"
          data-testid="nav-workspace-setting"
          @click="emit('open-workspace-setting')"
        >
          <span class="tab-label">{{ t('nav.tab.settings.label') }}</span>
        </button>
      </nav>
    </div>

    <div class="mobile-header-row">
      <!-- viewMode 切换器:窄屏没有左侧竖条,这两图标是移动端进入工作台的唯一入口 -->
      <div class="view-mode-toggle">
        <button
          v-for="mode in VIEW_MODES"
          :key="mode.key"
          type="button"
          class="vm-toggle-btn"
          :class="{ active: viewMode === mode.key }"
          :title="t(mode.labelKey)"
          :aria-label="t(mode.labelKey)"
          @click="emit('update:viewMode', mode.key)"
        >
          <svg
            v-if="mode.key === 'workspace'"
            class="vm-icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="3" y="4" width="18" height="13" rx="1.5" />
            <path d="M9 20h6M12 17v3" />
            <path d="M7 8h7" />
            <path d="M7 11h10" />
            <path d="M7 14h5" />
          </svg>
          <svg
            v-else
            class="vm-icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="3" y="4" width="18" height="13" rx="1.5" />
            <path d="M9 20h6M12 17v3" />
            <path
              d="M7.5 7.5h9a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-4.5l-2.5 2v-2H7.5a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1Z"
            />
          </svg>
          <!-- 工作台图标待处理角标(移动端顶栏):与桌面同源、同条件,0/缺省不渲染 -->
          <span
            v-if="
              mode.key === 'workcenter' &&
              viewMode === 'workspace' &&
              (workcenterBadgeCount ?? 0) > 0
            "
            class="tab-badge"
            :aria-label="
              t('dashboard.nav.notificationsBadgeAriaLabel', { count: workcenterBadgeCount ?? 0 })
            "
            >{{ workcenterBadgeCount }}</span
          >
        </button>
      </div>

      <!-- 窄屏同样没有竖条,工作区切换器在此保留(移动端唯一的工作区入口) -->
      <div v-if="viewMode === 'workspace'" class="mobile-workspace">
        <WorkspaceSwitcher
          :workspaces="workspaces"
          :current-workspace-name="currentWorkspace"
          @request-add-workspace="emit('update:addWorkspaceOpen', true)"
          @select-workspace="emit('select-workspace', $event)"
          @remove-workspace="emit('remove-workspace', $event)"
        />
      </div>
      <nav
        v-else
        class="header-tabs wc-page-nav mobile-wc-page-nav"
        role="tablist"
        :aria-label="t('dashboard.nav.ariaLabel')"
      >
        <button
          v-for="page in WORKCENTER_PAGES"
          :key="page.key"
          type="button"
          role="tab"
          class="header-tab"
          :class="{
            active: workcenterPage === page.key,
            'has-badge': page.badge && (workcenterBadgeCount ?? 0) > 0,
          }"
          :aria-selected="workcenterPage === page.key"
          @click="emit('select-workcenter-page', page.key)"
        >
          <span class="tab-label">
            {{ t(page.labelKey) }}
            <span
              v-if="page.badge && (workcenterBadgeCount ?? 0) > 0"
              class="tab-badge"
              :aria-label="
                t('dashboard.nav.notificationsBadgeAriaLabel', { count: workcenterBadgeCount ?? 0 })
              "
              >{{ workcenterBadgeCount }}</span
            >
          </span>
        </button>
      </nav>

      <details ref="actionsEl" class="mobile-actions" @toggle="syncOutsideListener">
        <summary class="icon-btn mobile-actions-trigger" aria-label="Actions">⋯</summary>
        <div class="mobile-actions-menu">
          <!-- 更新胶囊(移动端):与桌面同一份状态,外链或动作二选一,点完收起菜单。 -->
          <a
            v-if="updatePill?.kind === 'link'"
            class="mobile-action-item update-hint-mobile"
            :href="RELEASES_URL"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="nav-update-link-mobile"
            @click="closeActions"
            >{{ updatePill.text }}</a
          >
          <button
            v-else-if="updatePill"
            class="mobile-action-item update-hint-mobile"
            :class="`update-hint-${updatePill.kind}`"
            :disabled="
              updatePill.kind === 'progress' ||
              updatePill.kind === 'pending' ||
              updatePill.kind === 'applying'
            "
            data-testid="nav-update-action-mobile"
            @click="onMobileUpdatePillClick"
          >
            {{ updatePill.text }}
          </button>
          <button
            class="mobile-action-item"
            data-testid="nav-personalized-setting-mobile"
            @click="choosePersonalizedSetting"
          >
            {{ t('nav.personalizedSetting.tooltip') }}
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
          <a
            class="status status-link mobile-status"
            :class="status === 'open' ? 'ok' : 'err'"
            :href="logsHref"
            target="_blank"
            rel="noopener noreferrer"
            :title="t('nav.logs.tooltip')"
            data-testid="nav-logs-link-mobile"
          >
            {{ status }}
          </a>
        </div>
      </details>
    </div>

    <nav class="mobile-bottom-tabs" role="tablist" aria-label="Primary views">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="mobile-bottom-tab"
        :class="{ active: isTabActive(tab), 'has-badge': (tab.badgeCount ?? 0) > 0 }"
        :disabled="tabsEnabled === false"
        role="tab"
        :aria-selected="isTabActive(tab)"
        @click="selectTab(tab)"
      >
        <span class="mobile-tab-content">
          <span class="mobile-tab-label">{{ tab.label }}</span>
          <span v-if="tab.badgeCount" class="tab-badge" :aria-label="badgeAriaLabel(tab)">{{
            tab.badgeCount
          }}</span>
        </span>
      </button>
      <button
        class="mobile-bottom-tab"
        :class="{ active: workspaceSettingOpen }"
        :disabled="tabsEnabled === false"
        role="tab"
        :aria-selected="workspaceSettingOpen === true"
        data-testid="nav-workspace-setting-mobile"
        @click="emit('open-workspace-setting')"
      >
        <span class="mobile-tab-content">
          <span class="mobile-tab-label">{{ t('nav.tab.settings.label') }}</span>
        </span>
      </button>
    </nav>

    <!-- 新增工作区弹框保持唯一受控实例,桌面列表、移动切换器与冷启动引导共用。 -->
    <AddWorkspaceDialog
      :open="addWorkspaceOpen === true"
      :picker-pending="workspaceDirectoryPicker?.pending === true"
      :picker-error="workspaceDirectoryError"
      :picker-selection="workspaceDirectoryPicker?.selection ?? null"
      @confirm="onAddWorkspaceConfirm"
      @cancel="emit('update:addWorkspaceOpen', false)"
      @select-directory="emit('select-workspace-directory')"
    />

    <!-- 重启生效的二次确认:重启会断开所有已连接会话,所以按危险操作处理。 -->
    <ConfirmDialog
      :open="restartConfirmOpen"
      :title="t('nav.update.confirmRestart.title')"
      :message="t('nav.update.confirmRestart.message')"
      :confirm-label="t('nav.update.confirmRestart.confirm')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmRestart"
      @cancel="restartConfirmOpen = false"
    />
  </header>
</template>

<style scoped>
@media (min-width: 768px) {
  .app-header.workcenter-header {
    display: none;
  }
}

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

/* viewMode 切换器:两个显示器图标按钮,生效模式蓝、另一个灰(随 viewMode 互换);
   图标用 currentColor 着色,故色彩由按钮 color 驱动。桌面与移动端共用同一份样式。 */
.view-mode-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  flex-shrink: 0;
}
.vm-toggle-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}
.vm-toggle-btn:hover {
  background: var(--c-card);
}
.vm-toggle-btn.active {
  color: var(--c-primary-text);
}
.vm-icon {
  display: block;
}

/* 工作台切换图标待处理角标:锚定图标按钮右上角(.vm-toggle-btn 自带 position:relative)。
   图标无 .tab-label 文本包装,不适用全局 .header-tab .tab-badge 定位,故此处自包含定位;
   红底白字/尺寸/圆角与顶栏其它 .tab-badge 视觉统一。 */
.vm-toggle-btn .tab-badge {
  position: absolute;
  top: 0;
  right: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  font-size: 8px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: var(--c-error-text);
  border-radius: 50%;
}

/* 移动端工作台页面入口复用 .header-tabs/.header-tab 视觉。 */
.mobile-wc-page-nav {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
}

/* 更新胶囊(独立控件):蓝底胶囊,外链与按钮共用同一视觉 */
.update-hint {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--c-primary);
  color: #fff;
  font-size: var(--fs-caption);
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  text-decoration: none;
  cursor: pointer;
  transition: opacity var(--dur-fast) var(--ease-standard);
}
.update-hint:hover {
  opacity: 0.85;
}
/* 按钮形态:去掉浏览器默认边框/字体,视觉与外链形态完全一致 */
.update-hint-btn {
  border: none;
  font-family: inherit;
}
/* 只告知、不可操作的形态(下载中 / 等管理员 / 正在重启):降饱和并禁用指针 */
.update-hint-btn:disabled {
  background: var(--c-text-muted);
  cursor: default;
  opacity: 1;
}
/* 失败态转危险色,和「有新版可装」明确区分 */
.update-hint-retry {
  background: var(--c-error-text);
}

/* 个人化设置入口图标:与账户人形图标同尺寸,currentColor 着色随按钮态 */
.personalized-icon {
  display: block;
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

  /* 移动端底部 tab 角标:锚定在标签文字右上角(与桌面一致),红底白字与顶栏
     .header-tab .tab-badge 视觉统一。.mobile-tab-label 自身 overflow:hidden 会裁掉上抬
     的角标,故角标放在不裁剪的 .mobile-tab-content 包裹层内、与 label 同级。 */
  .mobile-tab-content {
    position: relative;
    display: inline-flex;
    max-width: 100%;
    min-width: 0;
  }
  .mobile-bottom-tab .tab-badge {
    position: absolute;
    top: -5px;
    left: 100%;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 13px;
    height: 13px;
    padding: 0 3px;
    font-size: 8px;
    font-weight: 600;
    line-height: 1;
    color: #fff;
    background: var(--c-error-text);
    border-radius: 50%;
  }

  /* 移动操作菜单内的新版本提示项:蓝色强调,与其它项区分 */
  .mobile-action-item.update-hint-mobile {
    display: block;
    color: var(--c-primary-text);
    font-weight: 600;
    text-decoration: none;
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
