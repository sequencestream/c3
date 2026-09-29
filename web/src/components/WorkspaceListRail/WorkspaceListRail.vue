<script setup lang="ts">
/*
 * WorkspaceListRail.vue — 紧邻左侧常驻系统竖条(LeftRail)右侧的工作区列表竖条。
 *
 * 位置与关系:它是 `.app-shell` 里 LeftRail 的**并列兄弟**,不是竖条的浮层 —— 展开时向
 * 右占据一列并横向挤压主列(`.app-main` 以 `min-width: 0` 消化),高度与竖条一致、
 * 纵向可滚动。因此它不吃竖条自身的两枚入口,也不覆盖主列内容。
 *
 * 两种形态(顶部一枚控件切换,默认展开,形态经 localStorage 记忆、仅本机生效):
 * - 展开态:每项一行 —— 字符色块 + 工作区名称(过长截断,`title` 兜底全名)+ 运行中角标。
 * - 收缩态:收到一枚竖条徽标的量级,每项只渲染名称首字符大写徽标。
 *
 * 排序:只按 `WorkspaceInfo.lastAccessed` 倒序(口径见 lib/workspace-list.ts)。不引入手动
 * 置顶、拖拽序或任何本地覆写顺序。
 *
 * 配色:由 `lib/workspace-color.ts` 的 `workspaceColor` / `workspaceInitial` 提供,与竖条
 * 入口徽标**同源同值**;模板只写 `data-ws-slot="N"`,底色与文字色查 `--c-ws-*` 主题令牌,
 * 组件内不出现任何硬编码色值。
 *
 * 切换工作区的副作用**不在这里**:列表只读既有状态,选中即上抛 `select-workspace`,由
 * App.vue 转交控制层既有的 `selectWorkspace`(落回意图 tab、清查看态、持久化)。同样地,
 * 「+ 新增」只上抛诉求 —— AddWorkspaceDialog 仍由 AppHeader 单实例持有,两处挂载会叠出
 * 两层遮罩。
 *
 * 窄屏(≤767px)不渲染:移动端沿用 AppHeader 精简行里的 WorkspaceSwitcher。桌面端默认
 * 展示且不提供隐藏动作,只允许在展开态与收缩态之间切换。
 */
import { computed, ref } from 'vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useAuth } from '@/composables/useAuth'
import { useIsMobile } from '@/composables/useBreakpoint'
import { sortWorkspacesByRecency } from '@/lib/workspace-list'
import { workspaceColor, workspaceInitial } from '@/lib/workspace-color'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'

const { t } = useTypedI18n()
// 移除工作区会拆掉一个信任根,服务端只允许管理员做(AUTH-R10)。非管理员连入口都不该
// 看见 —— 与 WorkspaceSwitcher 同一道门控,服务端仍是最终关口。
const { isAdmin } = useAuth()

const props = defineProps<{
  workspaces: WorkspaceInfo[]
  currentWorkspaceName: string | null
  /** 每个工作区的运行中会话数,缺项按 0 处理;与竖条入口角标同源,列表不新增计数来源。 */
  workspaceRunningSessionCounts?: Record<string, number>
  /** 展开态(true)/ 收缩态(false)。由 App.vue 持有形态记忆,本组件不直接读 localStorage。 */
  expanded: boolean
}>()

const emit = defineEmits<{
  'select-workspace': [name: string]
  'request-add-workspace': []
  'remove-workspace': [name: string]
  'toggle-expanded': []
}>()

// 窄屏没有这条竖条 —— 移动端仍用 AppHeader 精简行里的切换器。
const isMobile = useIsMobile()

// 服务端已按 lastAccessed 降序下发,这里再排一次是防御性的:别的调用路径喂进乱序时
// 列表依然呈现正确顺序。不引入手动置顶或本地覆写。
const ordered = computed(() => sortWorkspacesByRecency(props.workspaces))

// 缺项不是「未知」,是「没有在跑」:按 0 处理,不显示角标,也不额外去拉一次。
function runningCount(name: string): number {
  return props.workspaceRunningSessionCounts?.[name] ?? 0
}

function select(name: string): void {
  if (name !== props.currentWorkspaceName) emit('select-workspace', name)
}

// 行内移除按钮是这一行的后代节点,keydown 同样会冒泡到行级处理器。
// 只在事件真正来自行本身时响应,避免按 ✕ 的 Enter/Space 顺带切换工作区。
function onRowKeydown(event: KeyboardEvent, name: string): void {
  if (event.target !== event.currentTarget) return
  // key 名大小写在不同触发源下不统一(合成事件会给出 "enter"),统一折叠比较。
  const key = event.key.toLowerCase()
  if (key !== 'enter' && key !== ' ') return
  event.preventDefault()
  select(name)
}

// 移除工作区:点 ✕ 设定目标并打开 danger ConfirmDialog;确认后才 emit remove。
// 与 WorkspaceSwitcher 走同一条确认路径,文案也复用同一组 key。
const removeTarget = ref<WorkspaceInfo | null>(null)

function requestRemove(w: WorkspaceInfo): void {
  removeTarget.value = w
}

function onRemoveConfirm(): void {
  if (removeTarget.value) emit('remove-workspace', removeTarget.value.name)
  removeTarget.value = null
}
</script>

<template>
  <nav
    v-if="!isMobile"
    class="ws-list-rail"
    :class="expanded ? 'ws-list-rail-expanded' : 'ws-list-rail-collapsed'"
    :aria-label="t('nav.workspaceList.ariaLabel')"
  >
    <!-- 形态切换:展开 ⇄ 收缩。不改变竖条自身任何行为,也不改变列表内容与顺序。 -->
    <button
      type="button"
      class="ws-list-toggle"
      :title="
        expanded ? t('nav.workspaceList.toggle.collapse') : t('nav.workspaceList.toggle.expand')
      "
      :aria-label="
        expanded ? t('nav.workspaceList.toggle.collapse') : t('nav.workspaceList.toggle.expand')
      "
      :aria-expanded="expanded"
      data-testid="ws-list-toggle"
      @click="emit('toggle-expanded')"
    >
      <svg
        class="ws-list-toggle-icon"
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path v-if="expanded" d="M15 6l-6 6 6 6" />
        <path v-else d="M9 6l6 6-6 6" />
      </svg>
    </button>

    <ul class="ws-list-items">
      <li v-if="ordered.length === 0" class="ws-list-empty">{{ t('nav.workspaceList.empty') }}</li>
      <li
        v-for="w in ordered"
        :key="w.name"
        class="ws-list-item"
        :class="{ current: w.name === currentWorkspaceName }"
        :title="w.name"
        :aria-current="w.name === currentWorkspaceName ? 'true' : undefined"
        :aria-label="t('nav.workspaceList.item.label', { name: w.name })"
        role="button"
        tabindex="0"
        :data-testid="expanded ? 'ws-list-row' : 'ws-list-row-collapsed'"
        @click="select(w.name)"
        @keydown="onRowKeydown($event, w.name)"
      >
        <!-- 字符徽标:底色由名字派生的槽位号查 --c-ws-* 令牌得到,两种形态共用同一份色。 -->
        <span class="ws-list-chip" :data-ws-slot="workspaceColor(w.name)?.slot ?? undefined">
          <span v-if="workspaceInitial(w.name)" class="ws-list-initial">{{
            workspaceInitial(w.name)
          }}</span>
          <span v-else class="ws-list-initial empty">—</span>
        </span>
        <!-- 名称只在展开态出现;收缩态整行就只剩上面那枚徽标。 -->
        <span v-if="expanded" class="ws-list-name">{{ w.name }}</span>
        <span
          v-if="runningCount(w.name) > 0"
          class="ws-list-badge"
          :aria-label="t('nav.workspaceList.item.badgeAriaLabel', { count: runningCount(w.name) })"
          data-testid="ws-list-badge"
          >{{ runningCount(w.name) }}</span
        >
        <button
          v-if="isAdmin && expanded"
          type="button"
          class="ws-list-remove"
          :title="t('nav.workspace.remove.tooltip')"
          :aria-label="t('nav.workspace.remove.tooltip')"
          @click.stop="requestRemove(w)"
        >
          ✕
        </button>
      </li>
    </ul>

    <!-- 「+ 新增」只上抛诉求:路径与名称在 AppHeader 持有的弹框里收集,列表不另开弹框。
         与 WorkspaceSwitcher 一样收进列表末尾,只在管理员面前出现。 -->
    <button
      v-if="isAdmin"
      type="button"
      class="ws-list-add"
      :title="t('nav.workspace.add.tooltip')"
      :aria-label="t('nav.workspace.add.tooltip')"
      data-testid="ws-list-add"
      @click="emit('request-add-workspace')"
    >
      <span aria-hidden="true">+</span>
      <span v-if="expanded" class="ws-list-add-label">{{ t('nav.workspace.add.tooltip') }}</span>
    </button>

    <ConfirmDialog
      :open="removeTarget !== null"
      :title="t('nav.workspace.remove.title')"
      :message="removeTarget ? t('nav.workspace.remove.confirm', { path: removeTarget.name }) : ''"
      :confirm-label="t('nav.workspace.remove.confirmLabel')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="onRemoveConfirm"
      @cancel="removeTarget = null"
    />
  </nav>
</template>

<style scoped>
/* 列表竖条:与竖条并列的一列,不吃竖条自身的入口位。展开态吃掉一点横向空间换取
   「在哪个工作区」与全部工作区的常驻可见;收缩态是窄桌面拥挤时的出口。
   横向占位挤压主列,主列以 min-width: 0 消化,不通过隐藏顶栏功能腾空间。 */
.ws-list-rail {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
}
.ws-list-rail-expanded {
  width: 180px;
}
.ws-list-rail-collapsed {
  width: 56px;
  align-items: center;
}
.ws-list-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 100%;
  height: 32px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--c-text-muted);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-standard);
}
.ws-list-toggle:hover {
  color: var(--c-text);
}
.ws-list-toggle-icon {
  pointer-events: none;
}
.ws-list-items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: var(--sp-1) 0;
  list-style: none;
}
.ws-list-empty {
  padding: var(--sp-2) var(--sp-3);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  text-align: center;
}
.ws-list-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  cursor: pointer;
}
.ws-list-item:hover {
  background: var(--c-hover-strong);
}
/* 选中态:高亮底 + 主色左边条,两种形态都可见 —— 选中不依赖颜色单独承载语义。 */
.ws-list-item.current {
  background: var(--c-hover-strong);
  box-shadow: inset 2px 0 0 var(--c-primary-text);
}
.ws-list-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  background: var(--c-input);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  font-weight: 600;
  user-select: none;
}
/* 六个槽位各一组:底色与该底上的文字色都是主题令牌,与竖条入口徽标同一份取值。 */
.ws-list-chip[data-ws-slot='1'] {
  background: var(--c-ws-1);
  color: var(--c-ws-ink-1);
}
.ws-list-chip[data-ws-slot='2'] {
  background: var(--c-ws-2);
  color: var(--c-ws-ink-2);
}
.ws-list-chip[data-ws-slot='3'] {
  background: var(--c-ws-3);
  color: var(--c-ws-ink-3);
}
.ws-list-chip[data-ws-slot='4'] {
  background: var(--c-ws-4);
  color: var(--c-ws-ink-4);
}
.ws-list-chip[data-ws-slot='5'] {
  background: var(--c-ws-5);
  color: var(--c-ws-ink-5);
}
.ws-list-chip[data-ws-slot='6'] {
  background: var(--c-ws-6);
  color: var(--c-ws-ink-6);
}
.ws-list-initial.empty {
  color: var(--c-text-disabled);
}
.ws-list-name {
  min-width: 0;
  flex: 1;
  color: var(--c-text);
  font-size: var(--fs-body);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ws-list-item.current .ws-list-name {
  color: var(--c-primary-text);
}
/* 运行中角标:与竖条入口同一形态,0 / 缺项不渲染。 */
.ws-list-badge {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  color: var(--c-badge-ink);
  background: var(--c-error-text);
  border-radius: 999px;
}
.ws-list-remove {
  flex-shrink: 0;
  padding: 0 2px;
  background: transparent;
  border: none;
  color: var(--c-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-standard);
}
.ws-list-item:hover .ws-list-remove,
.ws-list-remove:focus-visible {
  opacity: 1;
}
.ws-list-add {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-shrink: 0;
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  background: transparent;
  border: none;
  border-top: 1px solid var(--c-border);
  color: var(--c-primary-text);
  font-size: var(--fs-body);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.ws-list-add:hover {
  background: var(--c-hover-strong);
}
.ws-list-rail-collapsed .ws-list-add {
  justify-content: center;
  padding: var(--sp-2) 0;
}
</style>
