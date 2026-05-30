<script setup lang="ts">
/*
 * RequirementList.vue — 需求视图左栏:需求列表 + 状态过滤 + 行内动作。
 *
 * 数据由 App 提供;过滤器是本组件的 UI 状态,切换时上抛 `filter` 事件让 App 拉取。
 * 动作(完善/启动开发/开发详情/标记状态)经事件上抛,由 App 统一发往服务端。
 */
import { computed, ref } from 'vue'
import type { Requirement, RequirementStatus } from '@ccc/shared/protocol'

const props = defineProps<{
  project: string
  requirements: Requirement[]
}>()

const emit = defineEmits<{
  filter: [status: RequirementStatus | null]
  refine: [requirementId: string]
  'start-dev': [requirementId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [requirementId: string, status: RequirementStatus]
}>()

// Status filter. `null` = 全部. Local UI state; changing it asks App to refetch.
const STATUS_LABELS: Record<RequirementStatus, string> = {
  draft: '草稿',
  todo: '未开始',
  in_progress: '开发中',
  done: '已完成',
  cancelled: '已取消',
}
const FILTERS: { value: RequirementStatus | null; label: string }[] = [
  { value: null, label: '全部' },
  { value: 'todo', label: '未开始' },
  { value: 'in_progress', label: '开发中' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'draft', label: '草稿' },
]
const filter = ref<RequirementStatus | null>(null)

function setFilter(value: RequirementStatus | null) {
  filter.value = value
  emit('filter', value)
}

// Title lookup so a dependency id can show its requirement's title in a hint.
const titleById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const r of props.requirements) out[r.id] = r.title
  return out
})

// Requirements this one depends on that aren't `done` yet (the unfinished set).
function unfinishedDeps(r: Requirement): Requirement[] {
  const byId = new Map(props.requirements.map((x) => [x.id, x]))
  return r.dependsOn
    .map((id) => byId.get(id))
    .filter((x): x is Requirement => !!x && x.status !== 'done')
}

function startDev(r: Requirement) {
  emit('start-dev', r.id, unfinishedDeps(r).length > 0)
}

function statusLabel(s: RequirementStatus): string {
  return STATUS_LABELS[s] ?? s
}
</script>

<template>
  <section class="req-list">
    <div class="req-list-head">
      <span class="req-list-title">需求列表</span>
      <select
        class="req-filter"
        :value="filter ?? ''"
        @change="
          setFilter((($event.target as HTMLSelectElement).value as RequirementStatus) || null)
        "
      >
        <option v-for="f in FILTERS" :key="f.label" :value="f.value ?? ''">{{ f.label }}</option>
      </select>
    </div>
    <div class="req-items">
      <p v-if="requirements.length === 0" class="req-empty">暂无需求。在右侧与助手沟通后保存。</p>
      <div v-for="r in requirements" :key="r.id" class="req-item" :class="r.status">
        <div class="req-item-head">
          <span class="req-priority" :class="r.priority">{{ r.priority }}</span>
          <span class="req-title" :title="r.content">{{ r.title }}</span>
          <span class="req-status">{{ statusLabel(r.status) }}</span>
        </div>
        <div v-if="unfinishedDeps(r).length" class="req-deps" title="存在未完成依赖">
          ⚠ 依赖未完成:{{
            unfinishedDeps(r)
              .map((d) => titleById[d.id] ?? d.id)
              .join('、')
          }}
        </div>
        <div class="req-actions">
          <button v-if="r.status === 'todo'" class="req-btn" @click="emit('refine', r.id)">
            完善
          </button>
          <button v-if="r.status === 'todo'" class="req-btn primary" @click="startDev(r)">
            启动开发
          </button>
          <button
            v-if="r.lastDevSessionId"
            class="req-btn"
            @click="emit('open-dev', r.lastDevSessionId as string)"
          >
            开发详情
          </button>
          <button
            v-if="r.status !== 'done' && r.status !== 'cancelled'"
            class="req-btn"
            @click="emit('set-status', r.id, 'done')"
          >
            标记完成
          </button>
          <button
            v-if="r.status !== 'done' && r.status !== 'cancelled'"
            class="req-btn"
            @click="emit('set-status', r.id, 'cancelled')"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
