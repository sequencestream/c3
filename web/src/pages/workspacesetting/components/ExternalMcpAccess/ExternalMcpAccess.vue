<script setup lang="ts">
/*
 * ExternalMcpAccess.vue — 工作区设置 · 「外部 MCP 接入」只读区。
 *
 * 纯展示:把系统级 `baseUrl`、固定路由 `/mcp/v1` 与当前工作区路径拼成可复制的接入
 * URL 与一行式命令。这里不产生、不保存、也不回显任何配置 —— 长期 key 属于系统设置,
 * 不进入工作区配置,所以本区块永远不会脏、不会出现在保存载荷里。
 *
 * 明文 key 的处理是本组件唯一的敏感点:常态下 URL 里是 `<KEY>` 占位符。用户可以临时
 * 粘贴自己保管的明文,只为把它拼进可直接复制的值 —— 该输入只存在于本组件的内存中,
 * 组件卸载即消失,既不上传也不写入浏览器存储。
 */
import { computed, ref } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { McpApiKeyMeta } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

/** 外部 MCP 的固定挂载路径。与服务端 `EXTERNAL_MCP_PATH` 对应。 */
const EXTERNAL_MCP_PATH = '/mcp/v1'

/** 未粘贴明文时 URL 中显示的占位符。 */
const KEY_PLACEHOLDER = '<KEY>'

const props = defineProps<{
  /** 系统设置里的公开访问地址;未配置时为空。 */
  baseUrl?: string | null
  /** 当前工作区的绝对路径(展示用,由父组件解析)。 */
  workspacePath?: string | null
  /** 当前工作区的 id —— 用来筛出授权到本工作区的 key。 */
  workspaceId?: string | null
  /** 全部 key 元数据(非管理员下为空);本区块只读不改。 */
  mcpApiKeys?: McpApiKeyMeta[]
}>()

const emit = defineEmits<{
  /** 请求跳转到系统设置(去配置 baseUrl 或生成 key)。 */
  gotoSystemSettings: []
}>()

/** 用户临时粘贴的明文 key。只存在于本组件内存,刷新/关闭即消失。 */
const pastedKey = ref('')

const copied = ref<'url' | 'command' | null>(null)

const baseUrlConfigured = computed(() => (props.baseUrl ?? '').trim().length > 0)

/** 授权到当前工作区的 key —— 让用户认出该用哪一把。 */
const grantedKeys = computed(() =>
  props.workspaceId
    ? (props.mcpApiKeys ?? []).filter((k) => k.workspaceIds.includes(props.workspaceId!))
    : [],
)

const accessUrl = computed(() => {
  if (!baseUrlConfigured.value || !props.workspacePath) return ''
  const base = (props.baseUrl ?? '').trim().replace(/\/+$/, '')
  const token = pastedKey.value.trim() || KEY_PLACEHOLDER
  // 占位符不编码,否则复制出来的模板里会是 %3CKEY%3E,用户还得手工还原。
  const tokenPart = pastedKey.value.trim() ? encodeURIComponent(token) : token
  return `${base}${EXTERNAL_MCP_PATH}?token=${tokenPart}&workspace=${encodeURIComponent(props.workspacePath)}`
})

const accessCommand = computed(() =>
  accessUrl.value ? `claude mcp add --transport http c3 "${accessUrl.value}"` : '',
)

function copy(kind: 'url' | 'command'): void {
  const text = kind === 'url' ? accessUrl.value : accessCommand.value
  if (!text) return
  // 无 clipboard API 时静默降级:文本本身仍可选中复制。
  void navigator.clipboard?.writeText(text)
  copied.value = kind
}
</script>

<template>
  <section class="project-config-section" data-testid="workspace-external-mcp">
    <p class="project-config-section-title">
      {{ t('workspaceSetting.externalMcp.title.label') }}
    </p>
    <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.hint') }}</p>

    <!-- baseUrl 没配就没有可复制的地址:说清楚,不猜浏览器 Host。 -->
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

    <template v-else>
      <!-- 已授权本工作区的 key;一把都没有时给出生成入口。 -->
      <p
        v-if="grantedKeys.length === 0"
        class="project-config-hint"
        data-testid="workspace-external-mcp-no-key"
      >
        {{ t('workspaceSetting.externalMcp.noKey') }}
      </p>
      <p v-else class="project-config-hint" data-testid="workspace-external-mcp-granted-keys">
        {{
          t('workspaceSetting.externalMcp.grantedKeys', {
            keys: grantedKeys.map((k) => k.name).join('、'),
          })
        }}
      </p>
      <button
        v-if="grantedKeys.length === 0"
        class="ghost"
        data-testid="workspace-external-mcp-goto"
        @click="emit('gotoSystemSettings')"
      >
        {{ t('workspaceSetting.externalMcp.goto.label') }}
      </button>

      <!-- 临时明文:仅用于把占位符换成可直接复制的值。 -->
      <label class="external-mcp-key-field">
        <span class="project-config-hint">{{ t('workspaceSetting.externalMcp.paste.label') }}</span>
        <input
          v-model="pastedKey"
          class="agent-field"
          type="password"
          autocomplete="off"
          :placeholder="t('workspaceSetting.externalMcp.paste.placeholder')"
          data-testid="workspace-external-mcp-key-input"
        />
      </label>
      <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.paste.hint') }}</p>

      <div class="external-mcp-value">
        <span class="project-config-hint">{{ t('workspaceSetting.externalMcp.url.label') }}</span>
        <code class="external-mcp-code" data-testid="workspace-external-mcp-url">{{
          accessUrl
        }}</code>
        <button data-testid="workspace-external-mcp-copy-url" @click="copy('url')">
          {{ copied === 'url' ? t('common.action.copied.label') : t('common.action.copy.label') }}
        </button>
      </div>

      <div class="external-mcp-value">
        <span class="project-config-hint">{{
          t('workspaceSetting.externalMcp.command.label')
        }}</span>
        <code class="external-mcp-code" data-testid="workspace-external-mcp-command">{{
          accessCommand
        }}</code>
        <button data-testid="workspace-external-mcp-copy-command" @click="copy('command')">
          {{
            copied === 'command' ? t('common.action.copied.label') : t('common.action.copy.label')
          }}
        </button>
      </div>

      <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.tools.hint') }}</p>
      <p class="project-config-hint">{{ t('workspaceSetting.externalMcp.security.hint') }}</p>
    </template>
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

.external-mcp-key-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 0 0;
}

.external-mcp-value {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 10px 0 0;
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
</style>
