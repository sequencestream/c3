<script setup lang="ts">
/*
 * ExternalMcpAccess.vue — 工作区设置 ·「谁能访问本工作区」页签。
 *
 * 纯只读:没有新建、没有重置、没有吊销、没有工具范围、没有 Save,也不进 Tab 草稿或
 * 「未保存」脏检查 —— 所以本页签永远不会脏。它回答的是一个观察性的问题(现在谁够得到这个
 * 工作区),不是一个可以在这里改的设置。
 *
 * 名单由服务端派生,和外部 MCP 调用闸门读的是同一套解析规则,因此不会与真实授权漂移。
 * 两处修改入口都在别的页面,本页只指路:
 *  - 账号能到哪些工作区 —— 系统设置 ·「用户与访问」(管理员);
 *  - 我自己的 key —— 个人化设置 ·「外部 MCP key」(每个人管自己的)。
 *
 * 名单只描述「工作区可见性」:它不说谁正连着、哪把 key 有哪些工具、历史上谁来过。
 */
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    /** 当前工作区的 id。 */
    workspaceName?: string | null
    /** 当前有效访问者;`null` = 尚未取到(与「没有人」区分开)。 */
    accessors?: string[] | null
    /** 是否管理员 —— 只决定要不要提示「去哪里改」,不影响名单本身。 */
    isAdmin?: boolean
  }>(),
  { workspaceName: null, accessors: null, isAdmin: false },
)

const emit = defineEmits<{
  /** 请求刷新名单。 */
  reload: []
  /** 请求跳转到系统设置(去「用户与访问」改账号范围)。 */
  gotoSystemSettings: []
}>()

const loaded = computed(() => props.accessors !== null)
const subjects = computed(() => props.accessors ?? [])
</script>

<template>
  <section class="project-config-section" data-testid="workspace-external-mcp">
    <p class="project-config-section-title">
      {{ t('workspaceSetting.externalMcp.title.label') }}
    </p>
    <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.hint') }}</p>

    <p v-if="!loaded" class="project-config-hint" data-testid="workspace-external-mcp-loading">
      {{ t('workspaceSetting.externalMcp.loading') }}
    </p>
    <p
      v-else-if="subjects.length === 0"
      class="project-config-hint"
      data-testid="workspace-external-mcp-empty"
    >
      {{ t('workspaceSetting.externalMcp.empty') }}
    </p>
    <ul v-else class="external-mcp-accessors" data-testid="workspace-external-mcp-accessors">
      <li
        v-for="subject in subjects"
        :key="subject"
        class="external-mcp-accessor"
        data-testid="workspace-external-mcp-accessor"
      >
        {{ subject }}
      </li>
    </ul>

    <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.manage.hint') }}</p>

    <div class="external-mcp-actions">
      <button class="ghost" data-testid="workspace-external-mcp-reload" @click="emit('reload')">
        {{ t('common.action.refresh.label') }}
      </button>
      <button
        v-if="isAdmin"
        class="ghost"
        data-testid="workspace-external-mcp-goto"
        @click="emit('gotoSystemSettings')"
      >
        {{ t('workspaceSetting.externalMcp.goto.label') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.external-mcp-accessors {
  list-style: none;
  margin: var(--sp-2) 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.external-mcp-accessor {
  border-top: 1px solid var(--c-border);
  padding: var(--sp-2) 0;
  font-family: var(--font-mono, monospace);
}

.external-mcp-actions {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
  padding-top: var(--sp-2);
}
</style>
