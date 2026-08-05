<script setup lang="ts">
/*
 * McpApiKeys.vue — 系统设置 · Security Tab 的「外部 MCP API Key」管理区。
 *
 * 与本页其它区块的关键差别:这里的每个操作都是即时生效的服务端指令(生成/改授权/
 * 吊销),不进入 Tab 草稿、也不参与「未保存」脏检查 —— 与基础账号列表同一形态。
 * 组件自身不持有权威状态:每次操作后服务端回推整份名册,父组件替换 `keys`。
 *
 * 明文 key 只在生成成功的那一次回包里出现。它经 `created` 传进来、只存在于当前
 * 组件树的内存里,用户关闭揭示框(或关闭面板)后即不可恢复 —— 这是服务端的承诺,
 * 组件绝不写入 localStorage,也不在别处回显。
 */
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type { McpApiKeyMeta, WorkspaceInfo } from '@ccc/shared/protocol'

const { t, d } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    /** 名册(仅元数据,永不含明文)。 */
    keys: McpApiKeyMeta[]
    /** 生成成功回包里唯一一次出现的明文;未生成/已关闭为 null。 */
    created: { meta: McpApiKeyMeta; key: string } | null
    /** 可授权的工作区 —— 只能引用 c3 已注册的工作区。 */
    workspaces: WorkspaceInfo[]
    /** 非管理员整区只读:按钮禁用,不隐藏,以免看起来「功能不存在」。 */
    isAdmin?: boolean
  }>(),
  { isAdmin: true },
)

const emit = defineEmits<{
  create: [payload: { name: string; workspaceIds: string[] }]
  update: [payload: { id: string; name?: string; workspaceIds?: string[] }]
  revoke: [id: string]
  dismissReveal: []
}>()

// ---- 新建表单 ----
const creating = ref(false)
const newName = ref('')
const newWorkspaceIds = ref<string[]>([])

function startCreate(): void {
  creating.value = true
  newName.value = ''
  newWorkspaceIds.value = []
}

function cancelCreate(): void {
  creating.value = false
}

/** 至少一个工作区才可提交:没有工作区的 key 什么也够不到,服务端也会拒绝。 */
const canSubmitCreate = computed(
  () => props.isAdmin && newName.value.trim().length > 0 && newWorkspaceIds.value.length > 0,
)

function submitCreate(): void {
  if (!canSubmitCreate.value) return
  emit('create', { name: newName.value.trim(), workspaceIds: [...newWorkspaceIds.value] })
  creating.value = false
}

// ---- 授权集合编辑 ----
// 编辑态只保留「当前正在编辑哪一条 + 勾选了哪些工作区」,不镜像整份名册,
// 这样服务端回推的新名册永远直接可用,无需和本地副本对账。
const editingId = ref<string | null>(null)
const editingWorkspaceIds = ref<string[]>([])

function startEdit(key: McpApiKeyMeta): void {
  editingId.value = key.id
  editingWorkspaceIds.value = [...key.workspaceIds]
}

function cancelEdit(): void {
  editingId.value = null
}

function submitEdit(): void {
  if (!editingId.value || !props.isAdmin) return
  emit('update', { id: editingId.value, workspaceIds: [...editingWorkspaceIds.value] })
  editingId.value = null
}

// 名册一变就退出编辑态:此时服务端已确认,继续停留在旧勾选上只会误导。
watch(
  () => props.keys,
  () => {
    editingId.value = null
  },
)

// ---- 吊销确认 ----
const revokingId = ref<string | null>(null)

function confirmRevoke(): void {
  if (!revokingId.value) return
  emit('revoke', revokingId.value)
  revokingId.value = null
}

// ---- 明文复制 ----
const copied = ref(false)

function copyCreatedKey(): void {
  if (!props.created) return
  // 无 clipboard API 时静默降级(沿用本项目既有写法),文本本身仍可手动选中复制。
  void navigator.clipboard?.writeText(props.created.key)
  copied.value = true
}

watch(
  () => props.created,
  () => {
    copied.value = false
  },
)

// ---- 展示 ----
function workspaceName(id: string): string {
  return props.workspaces.find((w) => w.id === id)?.name ?? id
}

function grantSummary(key: McpApiKeyMeta): string {
  const named = key.workspaceIds.map(workspaceName)
  if (named.length === 0) return t('settings.mcpApiKey.grant.none')
  return named.join('、')
}

function when(ms: number | null): string {
  return ms ? d(new Date(ms), 'full') : t('settings.mcpApiKey.lastUsed.never')
}
</script>

<template>
  <section class="settings-section" data-testid="settings-mcp-api-keys">
    <p class="settings-section-title">{{ t('settings.mcpApiKey.title.label') }}</p>
    <p class="settings-hint">{{ t('settings.mcpApiKey.hint') }}</p>
    <p class="settings-hint">{{ t('settings.mcpApiKey.security.hint') }}</p>

    <!-- 一次性明文揭示:只在刚生成时出现,关闭后不可恢复。 -->
    <div v-if="created" class="mcp-key-reveal" data-testid="settings-mcp-key-reveal">
      <p class="mcp-key-reveal-title">
        {{ t('settings.mcpApiKey.reveal.title', { name: created.meta.name }) }}
      </p>
      <p class="settings-hint">{{ t('settings.mcpApiKey.reveal.onceOnly') }}</p>
      <code class="mcp-key-plaintext" data-testid="settings-mcp-key-plaintext">{{
        created.key
      }}</code>
      <div class="mcp-key-reveal-actions">
        <button data-testid="settings-mcp-key-copy" @click="copyCreatedKey">
          {{ copied ? t('common.action.copied.label') : t('common.action.copy.label') }}
        </button>
        <button class="ghost" data-testid="settings-mcp-key-dismiss" @click="emit('dismissReveal')">
          {{ t('settings.mcpApiKey.reveal.dismiss.label') }}
        </button>
      </div>
    </div>

    <p v-if="keys.length === 0" class="settings-hint" data-testid="settings-mcp-key-empty">
      {{ t('settings.mcpApiKey.empty') }}
    </p>

    <div v-for="key in keys" :key="key.id" class="mcp-key-row" data-testid="settings-mcp-key-row">
      <div class="mcp-key-head">
        <span class="mcp-key-name">{{ key.name }}</span>
        <code class="mcp-key-prefix" data-testid="settings-mcp-key-prefix"
          >{{ key.displayPrefix }}…</code
        >
        <div class="mcp-key-actions">
          <button
            class="icon-btn"
            :disabled="!isAdmin"
            data-testid="settings-mcp-key-edit"
            @click="startEdit(key)"
          >
            {{ t('settings.mcpApiKey.grant.edit.label') }}
          </button>
          <button
            class="icon-btn"
            :disabled="!isAdmin"
            data-testid="settings-mcp-key-revoke"
            @click="revokingId = key.id"
          >
            {{ t('settings.mcpApiKey.revoke.label') }}
          </button>
        </div>
      </div>

      <p class="settings-hint" data-testid="settings-mcp-key-grant">
        {{ t('settings.mcpApiKey.grant.label', { workspaces: grantSummary(key) }) }}
      </p>
      <!-- 失效授权单独提示:它不可达,但留着让管理员看得见并清理。 -->
      <p
        v-if="key.staleWorkspaces.length > 0"
        class="settings-hint mcp-key-stale"
        data-testid="settings-mcp-key-stale"
      >
        {{ t('settings.mcpApiKey.grant.stale', { paths: key.staleWorkspaces.join('、') }) }}
      </p>
      <p class="settings-hint">
        {{
          t('settings.mcpApiKey.meta', {
            created: when(key.createdAt),
            lastUsed: when(key.lastUsedAt),
          })
        }}
      </p>

      <!-- 授权集合编辑:空集合是合法的「谁也够不到」,不是通配。 -->
      <div
        v-if="editingId === key.id"
        class="mcp-key-edit"
        data-testid="settings-mcp-key-edit-form"
      >
        <label v-for="ws in workspaces" :key="ws.id" class="mcp-key-ws-pick">
          <input
            v-model="editingWorkspaceIds"
            type="checkbox"
            :value="ws.id"
            :disabled="!isAdmin"
          />
          <span>{{ ws.name }}</span>
        </label>
        <p v-if="editingWorkspaceIds.length === 0" class="settings-hint">
          {{ t('settings.mcpApiKey.grant.emptyWarning') }}
        </p>
        <div class="mcp-key-edit-actions">
          <button :disabled="!isAdmin" data-testid="settings-mcp-key-edit-save" @click="submitEdit">
            {{ t('common.action.save.label') }}
          </button>
          <button class="ghost" @click="cancelEdit">
            {{ t('common.action.cancel.label') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 新建 -->
    <div v-if="creating" class="mcp-key-create" data-testid="settings-mcp-key-create-form">
      <input
        v-model="newName"
        class="agent-field"
        :disabled="!isAdmin"
        :placeholder="t('settings.mcpApiKey.create.name.placeholder')"
        data-testid="settings-mcp-key-new-name"
      />
      <p class="settings-hint">{{ t('settings.mcpApiKey.create.workspaces.label') }}</p>
      <p
        v-if="workspaces.length === 0"
        class="settings-hint"
        data-testid="settings-mcp-key-no-workspaces"
      >
        {{ t('settings.mcpApiKey.create.noWorkspaces') }}
      </p>
      <label v-for="ws in workspaces" :key="ws.id" class="mcp-key-ws-pick">
        <input v-model="newWorkspaceIds" type="checkbox" :value="ws.id" :disabled="!isAdmin" />
        <span>{{ ws.name }}</span>
      </label>
      <div class="mcp-key-create-actions">
        <button
          :disabled="!canSubmitCreate"
          data-testid="settings-mcp-key-create-submit"
          @click="submitCreate"
        >
          {{ t('settings.mcpApiKey.create.submit.label') }}
        </button>
        <button class="ghost" @click="cancelCreate">
          {{ t('common.action.cancel.label') }}
        </button>
      </div>
    </div>
    <div v-else class="mcp-key-add-bar">
      <button
        class="agent-add"
        :disabled="!isAdmin"
        data-testid="settings-mcp-key-create-open"
        @click="startCreate"
      >
        {{ t('settings.mcpApiKey.create.open.label') }}
      </button>
    </div>

    <!-- 吊销确认:不可撤销,且会同时切断已建立的会话 —— 走统一的危险确认弹窗。 -->
    <ConfirmDialog
      :open="revokingId !== null"
      :title="t('settings.mcpApiKey.revoke.confirm.title')"
      :message="t('settings.mcpApiKey.revoke.confirm.body')"
      :confirm-label="t('settings.mcpApiKey.revoke.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmRevoke"
      @cancel="revokingId = null"
    />
  </section>
</template>

<style scoped>
.mcp-key-reveal {
  border: 1px solid var(--c-primary);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 10px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcp-key-reveal-title {
  font-weight: 600;
}

.mcp-key-plaintext {
  display: block;
  overflow-wrap: anywhere;
  background: var(--c-bg);
  border-radius: 4px;
  padding: 8px;
  font-family: var(--font-mono, monospace);
}

.mcp-key-reveal-actions,
.mcp-key-edit-actions,
.mcp-key-create-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.mcp-key-row {
  border-top: 1px solid var(--c-border);
  padding: 10px 0;
}

.mcp-key-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mcp-key-name {
  font-weight: 600;
}

.mcp-key-prefix {
  color: var(--c-text-muted);
  font-family: var(--font-mono, monospace);
}

.mcp-key-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.mcp-key-stale {
  color: var(--c-warning-text);
}

.mcp-key-edit,
.mcp-key-create {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
}

.mcp-key-ws-pick {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mcp-key-add-bar {
  padding-top: 10px;
}
</style>
