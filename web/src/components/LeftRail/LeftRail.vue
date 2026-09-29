<script setup lang="ts">
/*
 * LeftRail.vue — 应用最左侧的常驻竖条(登录门内,AppHeader 的兄弟节点)。
 *
 * 只承载两个入口,各带一个数字角标:
 * - 工作区入口(上):当前工作区名首字符 + 由名字派生的稳定配色;角标是该工作区**运行中
 *   会话数**(服务端按 session_counts / session_status 实时下发)。点击**开合竖条左侧的
 *   工作区列表竖条**(WorkspaceListRail):那里直接列出全部工作区、按最近访问排序,选中即
 *   上抛切换。切换的副作用(落回意图 tab、清查看态、持久化)全在控制层的 selectWorkspace
 *   里,竖条不重写,列表竖条也不重写。
 * - 用户消息入口(下):铃铛,角标与工作台「用户通知」入口同源;点击进工作台并定位到用户
 *   通知页。
 *
 * 工作区入口此前是一个浮层下拉(WorkspaceSwitcher 的 rail 形态)。列表竖条接替了它的
 * 列表职责后,那层 popover 与它的 rail 形态一并移除:竖条自身不再持有任何列表,只留
 * 「开合列表竖条」这一个动作。移动端精简行用的 WorkspaceSwitcher(bar 形态)不受影响。
 *
 * 工作台视图下竖条不消失:此时工作区入口从「开合列表竖条」换成「回到工作区」——工作区
 * 徽标直接上抛进入工作区视图,与用户消息入口构成一对可来回切的入口。桌面顶栏已移除旧
 * 切换按钮,若不在此提供回落,进工作台后就再无路可退。列表竖条在工作台视图下一并隐藏,
 * 不与这条回退路径争抢点击。
 *
 * 两个角标都只读既有状态,竖条自身不持有计数、不新增轮询或订阅;0 / 缺省一律不渲染。
 * 窄屏(≤767px)不渲染竖条 —— 移动端顶栏精简行仍保留等价的工作区与工作台入口。
 */
import { computed } from 'vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import { useIsMobile } from '@/composables/useBreakpoint'
import { workspaceColor, workspaceInitial } from '@/lib/workspace-color'

const { t } = useTypedI18n()

const props = defineProps<{
  workspaces: WorkspaceInfo[]
  currentWorkspaceName: string | null
  /** 每个工作区的运行中会话数,缺项按 0 处理。 */
  workspaceRunningSessionCounts?: Record<string, number>
  /** 工作台待处理通知数,与「用户通知」入口同源。 */
  workcenterPendingCount?: number
  /** 当前视图模式:工作台视图下工作区入口承担「回到工作区」。 */
  viewMode?: 'workspace' | 'workcenter'
  /** 列表竖条是否已展开 —— 供无障碍状态播报,显隐本身由 App.vue 持有。 */
  workspaceListOpen?: boolean
}>()

const emit = defineEmits<{
  'toggle-workspace-list': []
  'open-notifications': []
  'enter-workspace': []
}>()

// 窄屏没有竖条 —— 移动端沿用 AppHeader 精简行里的工作区/工作台入口。
const isMobile = useIsMobile()

const initial = computed(() => workspaceInitial(props.currentWorkspaceName))
// 配色只落成一个槽位号:底色/文字色由样式表按槽位查 --c-ws-* 令牌,模板里不出现颜色。
const chipSlot = computed(() => workspaceColor(props.currentWorkspaceName)?.slot ?? null)

// 缺项不是「未知」,是「没有在跑」:按 0 处理,不显示角标,也不额外去拉一次。
const runningCount = computed(() =>
  props.currentWorkspaceName
    ? (props.workspaceRunningSessionCounts?.[props.currentWorkspaceName] ?? 0)
    : 0,
)
const pendingCount = computed(() => props.workcenterPendingCount ?? 0)

// 工作台视图下,工作区入口的职责从「开合列表竖条」变为「回到工作区」。
const inWorkcenter = computed(() => props.viewMode === 'workcenter')
const workspaceEntryLabel = computed(() =>
  inWorkcenter.value
    ? t('nav.viewMode.workspace')
    : props.currentWorkspaceName || t('nav.workspace.trigger.empty.tooltip'),
)
</script>

<template>
  <nav v-if="!isMobile" class="left-rail" :aria-label="t('nav.rail.ariaLabel')">
    <!-- 工作区入口 —— 工作区视图:字符徽标 + 运行中会话数角标,点开/收起左侧的
         工作区列表竖条(全部工作区在那里,按最近访问排序)。 -->
    <div v-if="!inWorkcenter" class="rail-slot">
      <button
        type="button"
        class="rail-btn rail-workspace-open"
        :title="workspaceEntryLabel"
        :aria-label="workspaceEntryLabel"
        :aria-expanded="workspaceListOpen"
        aria-controls="ws-list-rail"
        data-testid="rail-workspace-open"
        @click="emit('toggle-workspace-list')"
      >
        <span class="rail-workspace-chip" :data-ws-slot="chipSlot ?? undefined">
          <span v-if="initial" class="rail-workspace-initial">{{ initial }}</span>
          <span v-else class="rail-workspace-initial empty">—</span>
          <span
            v-if="runningCount > 0"
            class="rail-badge"
            :aria-label="t('nav.rail.workspace.badgeAriaLabel', { count: runningCount })"
            data-testid="rail-workspace-badge"
            >{{ runningCount }}</span
          >
        </span>
      </button>
    </div>

    <!-- 工作区入口 —— 工作台视图:同一枚徽标变成「回到工作区」。桌面顶栏的旧切换按钮
         已移除,这是工作台视图唯一的回退路径,不能省。 -->
    <div v-else class="rail-slot">
      <button
        type="button"
        class="rail-btn rail-workspace-back"
        :title="workspaceEntryLabel"
        :aria-label="workspaceEntryLabel"
        data-testid="rail-workspace-back"
        @click="emit('enter-workspace')"
      >
        <span class="rail-workspace-chip" :data-ws-slot="chipSlot ?? undefined">
          <span v-if="initial" class="rail-workspace-initial">{{ initial }}</span>
          <span v-else class="rail-workspace-initial empty">—</span>
        </span>
      </button>
    </div>

    <!-- 用户消息入口:铃铛 + 待处理角标,点开进工作台的用户通知页。 -->
    <button
      type="button"
      class="rail-slot rail-btn"
      :title="t('nav.rail.messages.tooltip')"
      :aria-label="t('nav.rail.messages.ariaLabel')"
      data-testid="rail-messages"
      @click="emit('open-notifications')"
    >
      <svg
        class="rail-icon"
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
        <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7Z" />
        <path d="M13.7 19a2 2 0 0 1-3.4 0" />
      </svg>
      <span
        v-if="pendingCount > 0"
        class="rail-badge"
        :aria-label="t('nav.rail.messages.badgeAriaLabel', { count: pendingCount })"
        data-testid="rail-messages-badge"
        >{{ pendingCount }}</span
      >
    </button>
  </nav>
</template>

<style scoped>
/* 常驻竖条:宽度吃掉一点横向空间,换取「在哪个工作区 / 有没有待处理消息」的常驻可见。
   与顶栏、内容区并列而非覆盖,高度贯通。 */
.left-rail {
  width: 56px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
  background: var(--c-panel);
  border-right: 1px solid var(--c-border);
}
.rail-slot {
  position: relative;
  display: flex;
}
.rail-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}
.rail-btn:hover {
  background: var(--c-card);
  color: var(--c-text);
}
.rail-icon {
  pointer-events: none;
}
/* 工作区字符徽标:底色由名字派生的槽位号查 --c-ws-* 令牌得到,主题一换自动跟随。 */
.rail-workspace-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: var(--c-input);
  color: var(--c-text-muted);
  font-size: var(--fs-body);
  font-weight: 600;
  user-select: none;
}
/* 六个槽位各一组:底色与该底上的文字色都是主题令牌,同一份取值服务全部三套主题。 */
.rail-workspace-chip[data-ws-slot='1'] {
  background: var(--c-ws-1);
  color: var(--c-ws-ink-1);
}
.rail-workspace-chip[data-ws-slot='2'] {
  background: var(--c-ws-2);
  color: var(--c-ws-ink-2);
}
.rail-workspace-chip[data-ws-slot='3'] {
  background: var(--c-ws-3);
  color: var(--c-ws-ink-3);
}
.rail-workspace-chip[data-ws-slot='4'] {
  background: var(--c-ws-4);
  color: var(--c-ws-ink-4);
}
.rail-workspace-chip[data-ws-slot='5'] {
  background: var(--c-ws-5);
  color: var(--c-ws-ink-5);
}
.rail-workspace-chip[data-ws-slot='6'] {
  background: var(--c-ws-6);
  color: var(--c-ws-ink-6);
}
.rail-workspace-initial.empty {
  color: var(--c-text-disabled);
}
/* 角标:与顶栏 tab 角标同一形态(右上角实心圆),0 / 缺省不渲染。 */
.rail-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  color: var(--c-badge-ink);
  background: var(--c-error-text);
  border-radius: 999px;
  border: 1px solid var(--c-panel);
}
</style>
