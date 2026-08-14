<script setup lang="ts">
/*
 * McpApiKeys.vue — 个人化设置 ·「外部 MCP key」区块。
 *
 * 这里管理的是「我自己的」长期 API key,按设备/客户端各建一把:新建、重置密钥、吊销。
 * 与本页其它区块一样,每个操作都是即时生效的服务端指令,没有草稿、没有 Save。
 *
 * key 不是工作区授权。它借的是「我」的权限:能够到哪些工作区,由管理员在系统设置里维护
 * 的账号范围决定,每次请求现算。所以本区块不显示、也不编辑工作区与工具范围 —— 那两样都
 * 不归 key 的持有者决定。
 *
 * 明文只在「新建成功」和「重置成功」的那一次回包里出现:它只活在当前组件树的内存中,关闭
 * 揭示框、离开本页、切换身份或断线重连后即不可恢复,任何人(含管理员)都无法二次查看。
 * 组件绝不写入 localStorage,也不在别处回显;一行式命令因此用环境变量间接引用 key,而不是
 * 把它拼进一条会进 shell 历史的命令。
 */
import { computed, ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type { McpApiKeyMeta } from '@ccc/shared/protocol'

const { t, d } = useTypedI18n()

/** 外部 MCP 的公开端点路径。与服务端 `EXTERNAL_MCP_PATH` 对应。 */
const EXTERNAL_MCP_PATH = '/mcp'

/** 一行式命令里引用明文 key 的环境变量名。 */
const KEY_ENV_VAR = 'C3_MCP_KEY'

const props = withDefaults(
  defineProps<{
    /** 系统设置里的公开访问地址;未配置时为空。 */
    baseUrl?: string | null
    /** 我名下的 key 名册(仅元数据,永不含明文)。 */
    mcpApiKeys?: McpApiKeyMeta[]
    /** 新建/重置成功回包里唯一一次出现的明文;未发生/已关闭为 null。 */
    created?: { meta: McpApiKeyMeta; key: string } | null
  }>(),
  { baseUrl: null, mcpApiKeys: () => [], created: null },
)

const emit = defineEmits<{
  create: [payload: { name: string }]
  reset: [id: string]
  revoke: [id: string]
  dismissReveal: []
  /** 请求跳转到系统设置(去配置 baseUrl)。 */
  gotoSystemSettings: []
}>()

const keys = computed(() => props.mcpApiKeys ?? [])
const baseUrlConfigured = computed(() => (props.baseUrl ?? '').trim().length > 0)

/** 公开端点。同一个地址服务每一把 key 和每一个工作区,所以它不含任何凭据。 */
const createdUrl = computed(() => {
  const base = (props.baseUrl ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}${EXTERNAL_MCP_PATH}` : ''
})

/**
 * 一行式接入命令。key 以环境变量间接引用:明文就在上一行等着复制,把它再拼进命令只会多
 * 一份 shell 历史里的副本。工作区名留成占位符 —— key 本身不绑工作区,填哪个由使用者按
 * 自己被授予的范围决定。
 */
const createdCommand = computed(() => {
  const url = createdUrl.value
  if (!url) return ''
  return (
    `claude mcp add --transport http c3 "${url}"` +
    ` --header "Authorization: Bearer $${KEY_ENV_VAR}"` +
    ` --header "X-C3-Workspace: ${t('personalizedSetting.mcpKeys.command.workspacePlaceholder')}"`
  )
})

// ---- 新建 ----
const creating = ref(false)
const newName = ref('')

function startCreate(): void {
  creating.value = true
  newName.value = ''
}

const canSubmitCreate = computed(() => newName.value.trim().length > 0)

function submitCreate(): void {
  if (!canSubmitCreate.value) return
  emit('create', { name: newName.value.trim() })
  creating.value = false
}

// ---- 重置 / 吊销确认 ----
// 两者都不可撤销:重置立刻作废旧密钥并切断已建立的会话,吊销则连 key 本身一起删掉。
const resettingId = ref<string | null>(null)
const revokingId = ref<string | null>(null)

const resettingName = computed(() => keys.value.find((k) => k.id === resettingId.value)?.name ?? '')

function confirmReset(): void {
  if (!resettingId.value) return
  emit('reset', resettingId.value)
  resettingId.value = null
}

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
  return ms ? d(new Date(ms), 'full') : t('personalizedSetting.mcpKeys.lastUsed.never')
}
</script>

<template>
  <section class="settings-section" data-testid="personal-mcp-keys">
    <p class="settings-section-title">{{ t('personalizedSetting.mcpKeys.title.label') }}</p>
    <p class="settings-hint">{{ t('personalizedSetting.mcpKeys.hint') }}</p>
    <p class="settings-hint">{{ t('personalizedSetting.mcpKeys.scope.hint') }}</p>

    <!-- baseUrl 没配就拼不出可复制的地址:说清楚,不猜浏览器 Host。key 仍可生成。 -->
    <div
      v-if="!baseUrlConfigured"
      class="mcp-key-guide"
      data-testid="personal-mcp-keys-no-base-url"
    >
      <p class="settings-hint">{{ t('personalizedSetting.mcpKeys.noBaseUrl') }}</p>
      <button class="ghost" @click="emit('gotoSystemSettings')">
        {{ t('personalizedSetting.mcpKeys.goto.label') }}
      </button>
    </div>

    <!-- 一次性明文揭示:只在刚新建/重置时出现,关闭后不可恢复。 -->
    <div v-if="created" class="mcp-key-reveal" data-testid="personal-mcp-keys-reveal">
      <p class="mcp-key-reveal-title">
        {{ t('personalizedSetting.mcpKeys.reveal.title', { name: created.meta.name }) }}
      </p>
      <p class="settings-hint">{{ t('personalizedSetting.mcpKeys.reveal.onceOnly') }}</p>

      <div class="mcp-key-value">
        <span class="settings-hint">{{ t('personalizedSetting.mcpKeys.key.label') }}</span>
        <code class="mcp-key-code" data-testid="personal-mcp-keys-plaintext">{{
          created.key
        }}</code>
        <button data-testid="personal-mcp-keys-copy-key" @click="copy('key', created.key)">
          {{ copied === 'key' ? t('common.action.copied.label') : t('common.action.copy.label') }}
        </button>
      </div>

      <template v-if="baseUrlConfigured">
        <div class="mcp-key-value">
          <span class="settings-hint">{{ t('personalizedSetting.mcpKeys.url.label') }}</span>
          <code class="mcp-key-code" data-testid="personal-mcp-keys-url">{{ createdUrl }}</code>
          <button data-testid="personal-mcp-keys-copy-url" @click="copy('url', createdUrl)">
            {{ copied === 'url' ? t('common.action.copied.label') : t('common.action.copy.label') }}
          </button>
        </div>

        <div class="mcp-key-value">
          <span class="settings-hint">{{ t('personalizedSetting.mcpKeys.command.label') }}</span>
          <code class="mcp-key-code" data-testid="personal-mcp-keys-command">{{
            createdCommand
          }}</code>
          <button
            data-testid="personal-mcp-keys-copy-command"
            @click="copy('command', createdCommand)"
          >
            {{
              copied === 'command' ? t('common.action.copied.label') : t('common.action.copy.label')
            }}
          </button>
        </div>
      </template>

      <div class="mcp-key-reveal-actions">
        <button
          class="ghost"
          data-testid="personal-mcp-keys-dismiss"
          @click="emit('dismissReveal')"
        >
          {{ t('personalizedSetting.mcpKeys.reveal.dismiss.label') }}
        </button>
      </div>
    </div>

    <p v-if="keys.length === 0" class="settings-hint" data-testid="personal-mcp-keys-empty">
      {{ t('personalizedSetting.mcpKeys.empty') }}
    </p>

    <div
      v-for="key in keys"
      :key="key.id"
      class="mcp-key-row"
      data-testid="personal-mcp-keys-key-row"
    >
      <div class="mcp-key-head">
        <span class="mcp-key-name">{{ key.name }}</span>
        <code class="mcp-key-prefix" data-testid="personal-mcp-keys-key-prefix"
          >{{ key.displayPrefix }}…</code
        >
        <div class="mcp-key-actions">
          <button
            class="icon-btn"
            data-testid="personal-mcp-keys-reset"
            @click="resettingId = key.id"
          >
            {{ t('personalizedSetting.mcpKeys.reset.label') }}
          </button>
          <button
            class="icon-btn"
            data-testid="personal-mcp-keys-revoke"
            @click="revokingId = key.id"
          >
            {{ t('personalizedSetting.mcpKeys.revoke.label') }}
          </button>
        </div>
      </div>

      <!-- 我的账号已不再被这台 c3 承认(账号被移除,或本机模式下配了登录):key 够不到
           任何东西,只留吊销。 -->
      <p
        v-if="key.unavailable"
        class="settings-hint mcp-key-unavailable"
        data-testid="personal-mcp-keys-unavailable"
      >
        {{ t('personalizedSetting.mcpKeys.unavailable') }}
      </p>

      <p class="settings-hint">
        {{
          t('personalizedSetting.mcpKeys.meta', {
            created: when(key.createdAt),
            lastUsed: when(key.lastUsedAt),
          })
        }}
      </p>
    </div>

    <!-- 新建:只填一个用途名(哪台设备/哪个客户端)。工作区与工具范围都不在这里决定。 -->
    <div v-if="creating" class="mcp-key-create" data-testid="personal-mcp-keys-create-form">
      <input
        v-model="newName"
        class="agent-field"
        :placeholder="t('personalizedSetting.mcpKeys.create.name.placeholder')"
        data-testid="personal-mcp-keys-new-name"
      />
      <p class="settings-hint">{{ t('personalizedSetting.mcpKeys.create.defaultScope') }}</p>
      <div class="mcp-key-create-actions">
        <button
          :disabled="!canSubmitCreate"
          data-testid="personal-mcp-keys-create-submit"
          @click="submitCreate"
        >
          {{ t('personalizedSetting.mcpKeys.create.submit.label') }}
        </button>
        <button class="ghost" @click="creating = false">
          {{ t('common.action.cancel.label') }}
        </button>
      </div>
    </div>
    <div v-else class="mcp-key-add-bar">
      <button class="agent-add" data-testid="personal-mcp-keys-create-open" @click="startCreate">
        {{ t('personalizedSetting.mcpKeys.create.open.label') }}
      </button>
    </div>

    <!-- 重置:立刻作废旧密钥并切断已建立的会话,没有宽限期。 -->
    <ConfirmDialog
      :open="resettingId !== null"
      :title="t('personalizedSetting.mcpKeys.reset.confirm.title')"
      :message="t('personalizedSetting.mcpKeys.reset.confirm.body', { name: resettingName })"
      :confirm-label="t('personalizedSetting.mcpKeys.reset.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmReset"
      @cancel="resettingId = null"
    />

    <!-- 吊销确认:不可撤销,且会同时切断已建立的会话。 -->
    <ConfirmDialog
      :open="revokingId !== null"
      :title="t('personalizedSetting.mcpKeys.revoke.confirm.title')"
      :message="t('personalizedSetting.mcpKeys.revoke.confirm.body')"
      :confirm-label="t('personalizedSetting.mcpKeys.revoke.confirm.confirm.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmRevoke"
      @cancel="revokingId = null"
    />
  </section>
</template>

<style scoped>
.mcp-key-guide {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
}

.mcp-key-reveal {
  border: 1px solid var(--c-primary);
  border-radius: var(--radius-md, 6px);
  padding: var(--sp-3) var(--sp-4);
  margin: var(--sp-3) 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.mcp-key-reveal-title {
  font-weight: 600;
}

.mcp-key-value {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-1);
  padding: var(--sp-2) 0 0;
}

.mcp-key-code {
  display: block;
  width: 100%;
  overflow-wrap: anywhere;
  background: var(--c-bg);
  border-radius: var(--radius-sm, 4px);
  padding: var(--sp-2);
  font-family: var(--font-mono, monospace);
}

.mcp-key-reveal-actions,
.mcp-key-create-actions {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}

.mcp-key-row {
  border-top: 1px solid var(--c-border);
  padding: var(--sp-3) 0;
}

.mcp-key-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
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
  gap: var(--sp-2);
}

.mcp-key-unavailable {
  color: var(--c-warning-text);
}

.mcp-key-create {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
}

.mcp-key-add-bar {
  padding-top: var(--sp-3);
}
</style>
