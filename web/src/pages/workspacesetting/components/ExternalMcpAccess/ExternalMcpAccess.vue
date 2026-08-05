<script setup lang="ts">
/*
 * ExternalMcpAccess.vue — 工作区设置 ·「外部 MCP 接入」页签。
 *
 * 本区块管理的是「当前工作区的」长期 API key:生成、列出、改工具范围、吊销。
 * 与本页其它页签的关键差别:这里每个操作都是即时生效的服务端指令,不进入 Tab 草稿、
 * 不参与「未保存」脏检查、也不会出现在任何 save 载荷里 —— 所以本页签永远不会脏。
 *
 * key 绑定单一工作区,地址即 `<baseUrl>/mcp/<明文 key>`。明文只在生成成功的那一次回包里
 * 出现:它经 `created` 传进来、只活在当前组件树的内存中,用户关闭揭示框或离开页面后即不可
 * 恢复 —— 这是服务端的承诺,组件绝不写入 localStorage,也不在别处回显。
 *
 * 工具范围来自服务端目录(`catalog`),前端不另存工具清单:服务端新增可授权工具即可直接
 * 勾选。写工具会真实改动 c3 状态,保存含写工具的范围前必须过一次风险确认。
 */
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type { ExternalMcpToolDescriptor, McpApiKeyMeta } from '@ccc/shared/protocol'

const { t, d } = useTypedI18n()

/** 外部 MCP 的挂载前缀。与服务端 `EXTERNAL_MCP_PATH_PREFIX` 对应。 */
const EXTERNAL_MCP_PATH_PREFIX = '/mcp'

const props = withDefaults(
  defineProps<{
    /** 系统设置里的公开访问地址;未配置时为空。 */
    baseUrl?: string | null
    /** 当前工作区的 id —— key 绑定它,也是所有指令的作用域。 */
    workspaceId?: string | null
    /** 本工作区的 key 名册(仅元数据,永不含明文)。 */
    mcpApiKeys?: McpApiKeyMeta[]
    /** 生成成功回包里唯一一次出现的明文;未生成/已关闭为 null。 */
    created?: { meta: McpApiKeyMeta; key: string } | null
    /** 服务端可外部授权工具目录(名称 + 读写分级)。 */
    catalog?: ExternalMcpToolDescriptor[]
    /** 非管理员整区只读:按钮禁用,不隐藏,以免看起来「功能不存在」。 */
    isAdmin?: boolean
  }>(),
  {
    isAdmin: true,
    baseUrl: null,
    workspaceId: null,
    mcpApiKeys: () => [],
    created: null,
    catalog: () => [],
  },
)

const emit = defineEmits<{
  create: [payload: { name: string }]
  updateTools: [payload: { id: string; tools: string[] }]
  revoke: [id: string]
  dismissReveal: []
  /** 请求跳转到系统设置(去配置 baseUrl)。 */
  gotoSystemSettings: []
}>()

const keys = computed(() => props.mcpApiKeys ?? [])
const readTools = computed(() => (props.catalog ?? []).filter((tool) => tool.access === 'read'))
const writeTools = computed(() => (props.catalog ?? []).filter((tool) => tool.access === 'write'))

const baseUrlConfigured = computed(() => (props.baseUrl ?? '').trim().length > 0)

/**
 * 一把 key 的完整对外地址。只有刚生成的那一次才拿得到明文,所以这是唯一能拼出可直接
 * 使用地址的时刻 —— 名册里的条目永远只能显示前缀。
 */
function accessUrl(plaintextKey: string): string {
  const base = (props.baseUrl ?? '').trim().replace(/\/+$/, '')
  return `${base}${EXTERNAL_MCP_PATH_PREFIX}/${encodeURIComponent(plaintextKey)}`
}

const createdUrl = computed(() => (props.created ? accessUrl(props.created.key) : ''))
const createdCommand = computed(() =>
  createdUrl.value ? `claude mcp add --transport http c3 "${createdUrl.value}"` : '',
)

// ---- 新建 ----
const creating = ref(false)
const newName = ref('')

function startCreate(): void {
  creating.value = true
  newName.value = ''
}

const canSubmitCreate = computed(
  () => props.isAdmin && !!props.workspaceId && newName.value.trim().length > 0,
)

function submitCreate(): void {
  if (!canSubmitCreate.value) return
  emit('create', { name: newName.value.trim() })
  creating.value = false
}

// ---- 工具范围编辑 ----
// 编辑态只记「当前编辑哪一条 + 勾了哪些工具」,不镜像整份名册,这样服务端回推的新名册
// 永远直接可用,无需和本地副本对账。
const editingId = ref<string | null>(null)
const editingTools = ref<string[]>([])
/** 待确认的写权限保存;非空即弹风险确认。 */
const pendingWriteGrant = ref<{ id: string; tools: string[] } | null>(null)

function startEdit(key: McpApiKeyMeta): void {
  editingId.value = key.id
  editingTools.value = [...key.tools]
}

function cancelEdit(): void {
  editingId.value = null
  pendingWriteGrant.value = null
}

const editingWriteNames = computed(() =>
  writeTools.value
    .filter((tool) => editingTools.value.includes(tool.name))
    .map((tool) => tool.name),
)

function submitEdit(): void {
  if (!editingId.value || !props.isAdmin) return
  const payload = { id: editingId.value, tools: [...editingTools.value] }
  // 写工具能真实改动 c3 状态(落库意图、提交审核结论、拉起会话),保存前必须让管理员
  // 看到自己正在授予什么;只读范围不打断。
  if (editingWriteNames.value.length > 0) {
    pendingWriteGrant.value = payload
    return
  }
  emit('updateTools', payload)
  editingId.value = null
}

function confirmWriteGrant(): void {
  if (!pendingWriteGrant.value) return
  emit('updateTools', pendingWriteGrant.value)
  pendingWriteGrant.value = null
  editingId.value = null
}

// 名册一变就退出编辑态:此时服务端已确认,继续停留在旧勾选上只会误导。
watch(
  () => props.mcpApiKeys,
  () => {
    editingId.value = null
    pendingWriteGrant.value = null
  },
)

// ---- 吊销确认 ----
const revokingId = ref<string | null>(null)

function confirmRevoke(): void {
  if (!revokingId.value) return
  emit('revoke', revokingId.value)
  revokingId.value = null
}

// ---- 复制 ----
const copied = ref<string | null>(null)

function copy(kind: string, text: string): void {
  if (!text) return
  // 无 clipboard API 时静默降级(沿用本项目既有写法),文本本身仍可手动选中复制。
  void navigator.clipboard?.writeText(text)
  copied.value = kind
}

watch(
  () => props.created,
  () => {
    copied.value = null
  },
)

// ---- 展示 ----
function when(ms: number | null): string {
  return ms ? d(new Date(ms), 'full') : t('workspaceSetting.externalMcp.lastUsed.never')
}

function toolSummary(key: McpApiKeyMeta): string {
  if (key.tools.length === 0) return t('workspaceSetting.externalMcp.tools.none')
  const writes = writeTools.value.filter((tool) => key.tools.includes(tool.name)).length
  return t('workspaceSetting.externalMcp.tools.summary', {
    total: key.tools.length,
    writes,
  })
}
</script>

<template>
  <section class="project-config-section" data-testid="workspace-external-mcp">
    <p class="project-config-section-title">
      {{ t('workspaceSetting.externalMcp.title.label') }}
    </p>
    <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.hint') }}</p>
    <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.security.hint') }}</p>

    <!-- baseUrl 没配就拼不出可复制的地址:说清楚,不猜浏览器 Host。key 仍可生成。 -->
    <div
      v-if="!baseUrlConfigured"
      class="external-mcp-guide"
      data-testid="workspace-external-mcp-no-base-url"
    >
      <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.noBaseUrl') }}</p>
      <button class="ghost" @click="emit('gotoSystemSettings')">
        {{ t('workspaceSetting.externalMcp.goto.label') }}
      </button>
    </div>

    <!-- 一次性明文揭示:只在刚生成时出现,关闭后不可恢复。 -->
    <div v-if="created" class="external-mcp-reveal" data-testid="workspace-external-mcp-reveal">
      <p class="external-mcp-reveal-title">
        {{ t('workspaceSetting.externalMcp.reveal.title', { name: created.meta.name }) }}
      </p>
      <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.reveal.onceOnly') }}</p>

      <div class="external-mcp-value">
        <span class="project-config-hint">{{ t('workspaceSetting.externalMcp.key.label') }}</span>
        <code class="external-mcp-code" data-testid="workspace-external-mcp-plaintext">{{
          created.key
        }}</code>
        <button data-testid="workspace-external-mcp-copy-key" @click="copy('key', created.key)">
          {{ copied === 'key' ? t('common.action.copied.label') : t('common.action.copy.label') }}
        </button>
      </div>

      <template v-if="baseUrlConfigured">
        <div class="external-mcp-value">
          <span class="project-config-hint">{{ t('workspaceSetting.externalMcp.url.label') }}</span>
          <code class="external-mcp-code" data-testid="workspace-external-mcp-url">{{
            createdUrl
          }}</code>
          <button data-testid="workspace-external-mcp-copy-url" @click="copy('url', createdUrl)">
            {{ copied === 'url' ? t('common.action.copied.label') : t('common.action.copy.label') }}
          </button>
        </div>

        <div class="external-mcp-value">
          <span class="project-config-hint">{{
            t('workspaceSetting.externalMcp.command.label')
          }}</span>
          <code class="external-mcp-code" data-testid="workspace-external-mcp-command">{{
            createdCommand
          }}</code>
          <button
            data-testid="workspace-external-mcp-copy-command"
            @click="copy('command', createdCommand)"
          >
            {{
              copied === 'command' ? t('common.action.copied.label') : t('common.action.copy.label')
            }}
          </button>
        </div>
      </template>

      <div class="external-mcp-reveal-actions">
        <button
          class="ghost"
          data-testid="workspace-external-mcp-dismiss"
          @click="emit('dismissReveal')"
        >
          {{ t('workspaceSetting.externalMcp.reveal.dismiss.label') }}
        </button>
      </div>
    </div>

    <p
      v-if="keys.length === 0"
      class="project-config-hint"
      data-testid="workspace-external-mcp-empty"
    >
      {{ t('workspaceSetting.externalMcp.empty') }}
    </p>

    <div
      v-for="key in keys"
      :key="key.id"
      class="external-mcp-row"
      data-testid="workspace-external-mcp-key-row"
    >
      <div class="external-mcp-key-head">
        <span class="external-mcp-key-name">{{ key.name }}</span>
        <code class="external-mcp-key-prefix" data-testid="workspace-external-mcp-key-prefix"
          >{{ key.displayPrefix }}…</code
        >
        <div class="external-mcp-key-actions">
          <button
            class="icon-btn"
            :disabled="!isAdmin || key.unavailable"
            data-testid="workspace-external-mcp-edit"
            @click="startEdit(key)"
          >
            {{ t('workspaceSetting.externalMcp.tools.edit.label') }}
          </button>
          <button
            class="icon-btn"
            :disabled="!isAdmin"
            data-testid="workspace-external-mcp-revoke"
            @click="revokingId = key.id"
          >
            {{ t('workspaceSetting.externalMcp.revoke.label') }}
          </button>
        </div>
      </div>

      <!-- 绑定工作区已不可用:key 够不到任何东西,只留吊销。 -->
      <p
        v-if="key.unavailable"
        class="project-config-hint external-mcp-unavailable"
        data-testid="workspace-external-mcp-unavailable"
      >
        {{ t('workspaceSetting.externalMcp.unavailable') }}
      </p>

      <p class="project-config-hint" data-testid="workspace-external-mcp-key-tools">
        {{ toolSummary(key) }}
      </p>
      <p class="project-config-hint">
        {{
          t('workspaceSetting.externalMcp.meta', {
            created: when(key.createdAt),
            lastUsed: when(key.lastUsedAt),
          })
        }}
      </p>

      <!-- 工具范围编辑:空集合是合法的「什么都不能调」,不是通配。 -->
      <div
        v-if="editingId === key.id"
        class="external-mcp-edit"
        data-testid="workspace-external-mcp-edit-form"
      >
        <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.tools.read.label') }}</p>
        <label v-for="tool in readTools" :key="tool.name" class="external-mcp-tool-pick">
          <input v-model="editingTools" type="checkbox" :value="tool.name" :disabled="!isAdmin" />
          <code>{{ tool.name }}</code>
        </label>

        <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.tools.write.label') }}</p>
        <p class="project-config-hint external-mcp-warning">
          {{ t('workspaceSetting.externalMcp.tools.write.risk') }}
        </p>
        <label v-for="tool in writeTools" :key="tool.name" class="external-mcp-tool-pick">
          <input v-model="editingTools" type="checkbox" :value="tool.name" :disabled="!isAdmin" />
          <code>{{ tool.name }}</code>
        </label>

        <div class="external-mcp-edit-actions">
          <button
            :disabled="!isAdmin"
            data-testid="workspace-external-mcp-edit-save"
            @click="submitEdit"
          >
            {{ t('common.action.save.label') }}
          </button>
          <button class="ghost" @click="cancelEdit">
            {{ t('common.action.cancel.label') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 新建:工作区由当前页面决定,不给选;初始范围由服务端定为全部只读工具。 -->
    <div
      v-if="creating"
      class="external-mcp-create"
      data-testid="workspace-external-mcp-create-form"
    >
      <input
        v-model="newName"
        class="agent-field"
        :disabled="!isAdmin"
        :placeholder="t('workspaceSetting.externalMcp.create.name.placeholder')"
        data-testid="workspace-external-mcp-new-name"
      />
      <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.create.defaultScope') }}</p>
      <div class="external-mcp-create-actions">
        <button
          :disabled="!canSubmitCreate"
          data-testid="workspace-external-mcp-create-submit"
          @click="submitCreate"
        >
          {{ t('workspaceSetting.externalMcp.create.submit.label') }}
        </button>
        <button class="ghost" @click="creating = false">
          {{ t('common.action.cancel.label') }}
        </button>
      </div>
    </div>
    <div v-else class="external-mcp-add-bar">
      <button
        class="agent-add"
        :disabled="!isAdmin || !workspaceId"
        data-testid="workspace-external-mcp-create-open"
        @click="startCreate"
      >
        {{ t('workspaceSetting.externalMcp.create.open.label') }}
      </button>
    </div>

    <!-- 授予写权限:不可逆地扩大该 key 的爆炸半径 —— 走统一的危险确认弹窗。 -->
    <ConfirmDialog
      :open="pendingWriteGrant !== null"
      :title="t('workspaceSetting.externalMcp.tools.write.confirm.title')"
      :message="
        t('workspaceSetting.externalMcp.tools.write.confirm.body', {
          tools: editingWriteNames.join('、'),
        })
      "
      :confirm-label="t('workspaceSetting.externalMcp.tools.write.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmWriteGrant"
      @cancel="pendingWriteGrant = null"
    />

    <!-- 吊销确认:不可撤销,且会同时切断已建立的会话。 -->
    <ConfirmDialog
      :open="revokingId !== null"
      :title="t('workspaceSetting.externalMcp.revoke.confirm.title')"
      :message="t('workspaceSetting.externalMcp.revoke.confirm.body')"
      :confirm-label="t('workspaceSetting.externalMcp.revoke.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmRevoke"
      @cancel="revokingId = null"
    />
  </section>
</template>

<style scoped>
.external-mcp-guide {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
}

.external-mcp-reveal {
  border: 1px solid var(--c-primary);
  border-radius: 6px;
  padding: 10px 12px;
  margin: 10px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.external-mcp-reveal-title {
  font-weight: 600;
}

.external-mcp-value {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 0 0;
}

.external-mcp-code {
  display: block;
  width: 100%;
  overflow-wrap: anywhere;
  background: var(--c-bg);
  border-radius: 4px;
  padding: 8px;
  font-family: var(--font-mono, monospace);
}

.external-mcp-reveal-actions,
.external-mcp-edit-actions,
.external-mcp-create-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.external-mcp-row {
  border-top: 1px solid var(--c-border);
  padding: 10px 0;
}

.external-mcp-key-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.external-mcp-key-name {
  font-weight: 600;
}

.external-mcp-key-prefix {
  color: var(--c-text-muted);
  font-family: var(--font-mono, monospace);
}

.external-mcp-key-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}

.external-mcp-unavailable,
.external-mcp-warning {
  color: var(--c-warning-text);
}

.external-mcp-edit,
.external-mcp-create {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
}

.external-mcp-tool-pick {
  display: flex;
  align-items: center;
  gap: 6px;
}

.external-mcp-add-bar {
  padding-top: 10px;
}
</style>
