<script setup lang="ts">
/*
 * ModelProviders.vue — 系统设置 ·「模型提供方」页签。
 *
 * 一个 provider 就是一条具名上游(Base URL + Key),多个 agent 共用它。把连接从 agent 里
 * 提出来之后,轮换 key 或迁移端点只改这一处,而不是逐个 agent 改到漏。
 *
 * 本组件直接改 props.providers 里的对象(与 agent 列表同一种写法):它们是父级草稿的一部分,
 * 保存与脏检测都由父面板统一负责,这里不发任何消息、也不落库。只有两类动作是例外——迁移与
 * 连通性探测,它们不是「编辑一份配置」,而是要服务端算或替我们去拨号,所以上抛给父级发消息。
 *
 * 删除被引用的 provider 默认阻断:确认框先说明有几个 agent 会退回 CLI 登录态,用户仍可强制
 * 删除(逃生口)。悬挂引用在服务端是 fail-soft 的,所以这里挡的是「误删」,不是「不一致」。
 */
import { computed, ref } from 'vue'
import type {
  AgentConfig,
  ModelProvider,
  ProviderMigrationPlan,
  VendorId,
} from '@ccc/shared/protocol'
import { effectiveApiKey } from '@ccc/shared/protocol'
import { PROVIDER_TEMPLATES, VENDOR_IDS, checkProviderBaseUrl } from '@ccc/shared'
import type { BaseUrlIssue } from '@ccc/shared'
import { useTypedI18n } from '@/i18n'
import { VENDOR_LABEL } from '@/lib/vendor'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import type { ProviderProbeState } from '@/lib/model-provider'
import { providerProbeKey } from '@/lib/model-provider'

const { t } = useTypedI18n()

const props = withDefaults(
  defineProps<{
    /** 草稿里的 provider 列表(引用,可就地编辑)。 */
    providers?: ModelProvider[]
    /** 草稿里的 agent 列表,只用来算「谁在用它」。 */
    agents?: AgentConfig[]
    /** 迁移报告;null = 还没取到。 */
    plan?: ProviderMigrationPlan | null
    /** 探测状态,键为 `${providerId}:${vendor}`。 */
    probes?: Record<string, ProviderProbeState>
    isAdmin?: boolean
  }>(),
  { providers: () => [], agents: () => [], plan: null, probes: () => ({}), isAdmin: true },
)

const emit = defineEmits<{
  /** 列表整体替换(新增/删除);单字段编辑就地改,不走这里。 */
  change: [providers: ModelProvider[]]
  /**
   * 连通性探测。带上草稿里的 baseUrl / 有效 key,这样未保存的编辑(或尚未落库的新建)
   * 探到的是表单上正在改的值,而不是上次保存的旧记录;providerId 仍带回包匹配用。
   */
  probe: [payload: { providerId: string; vendor: VendorId; baseUrl: string; apiKey: string }]
  migrate: [
    payload: { action: 'apply' | 'revert' | 'clear'; providerIds?: string[]; agentIds?: string[] },
  ]
}>()

// cursor 只认自己的 CLI 登录,既不能引用 provider 也无处注入连接,所以连接编辑器里不出现它。
const CONNECTABLE_VENDORS = computed(() => VENDOR_IDS.filter((v) => v !== 'cursor'))

// ---- 新建 ----

/** provider id 与 agent id 同一种铸造方式:毫秒时间戳 + 同毫秒内自增,永不重写。 */
let mintCounter = 0
function mintId(): string {
  return `${Date.now()}-${mintCounter++}`
}

/** 名称在列表内唯一——重名的 provider 在 agent 下拉里无法区分。 */
function uniqueName(base: string): string {
  const taken = new Set(props.providers.map((p) => p.displayName))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`
}

function addProvider(templateId: string): void {
  const template = PROVIDER_TEMPLATES.find((x) => x.id === templateId)
  const connections: ModelProvider['connections'] = {}
  for (const [vendor, conn] of Object.entries(template?.connections ?? {})) {
    connections[vendor as VendorId] = {
      baseUrl: conn.baseUrl,
      ...(conn.wireApi ? { wireApi: conn.wireApi } : {}),
    }
  }
  const created: ModelProvider = {
    id: mintId(),
    displayName: uniqueName(template?.displayName ?? t('settings.providers.name.placeholder')),
    ...(template ? { template: template.id } : {}),
    apiKey: '',
    connections,
  }
  emit('change', [...props.providers, created])
  expanded.value = created.id
}

const newTemplate = ref('')
function onCreate(): void {
  addProvider(newTemplate.value)
  newTemplate.value = ''
}

// ---- 展开/折叠 ----
// 一次只展开一个:provider 的编辑面板很高,全部展开会把列表本身挤没。
const expanded = ref<string | null>(null)
function toggle(id: string): void {
  expanded.value = expanded.value === id ? null : id
}

// ---- 连接编辑 ----

function connectionOf(p: ModelProvider, vendor: VendorId) {
  return p.connections[vendor]
}

/** 勾选=为该 vendor 建一条空连接;取消=删除该条(连同它的 key 覆盖)。 */
function setConnected(p: ModelProvider, vendor: VendorId, on: boolean): void {
  if (on) {
    if (!p.connections[vendor]) {
      p.connections[vendor] = {
        baseUrl: '',
        ...(vendor === 'codex' ? { wireApi: 'chat' as const } : {}),
      }
    }
  } else {
    delete p.connections[vendor]
  }
  touch(p)
}

/**
 * 用户一旦手改过迁移生成的 provider,它就不再是「可一键撤销的中间产物」——撤销会删掉用户的
 * 编辑。清掉标记,让它变成普通 provider。
 */
function touch(p: ModelProvider): void {
  if (p.synthesized) delete p.synthesized
}

function baseUrlIssue(baseUrl: string): { text: string; severity: 'error' | 'warning' } | null {
  const check = checkProviderBaseUrl(baseUrl)
  if (!check.issue || !check.severity) return null
  return { text: issueText(check.issue), severity: check.severity }
}

function issueText(issue: BaseUrlIssue | string): string {
  switch (issue) {
    case 'empty':
      return t('settings.providers.issue.empty')
    case 'bad-scheme':
      return t('settings.providers.issue.badScheme')
    case 'has-query':
      return t('settings.providers.issue.hasQuery')
    case 'insecure':
      return t('settings.providers.issue.insecure')
    default:
      return t('settings.providers.issue.notAUrl')
  }
}

// ---- 模型目录 ----

function addModel(p: ModelProvider): void {
  p.models = [...(p.models ?? []), { id: '' }]
  touch(p)
}
function removeModel(p: ModelProvider, index: number): void {
  p.models = (p.models ?? []).filter((_, i) => i !== index)
  touch(p)
}

// ---- 引用关系 ----

function usedBy(id: string): AgentConfig[] {
  return props.agents.filter((a) => a.providerId === id)
}

// ---- 探测 ----

function probeState(providerId: string, vendor: VendorId): ProviderProbeState | undefined {
  return props.probes[providerProbeKey(providerId, vendor)]
}
/** 探测结论的一行说明。401/403 也算「可达」——URL 是对的,只是 key 没过。 */
function probeText(state: ProviderProbeState): string {
  if (state.pending) return t('settings.providers.probe.running')
  if (state.reachable) {
    return state.status === 401 || state.status === 403
      ? t('settings.providers.probe.auth', { status: state.status })
      : t('settings.providers.probe.ok', { ms: state.latencyMs ?? 0 })
  }
  return t('settings.providers.probe.fail', {
    reason: state.error ?? (state.issue ? issueText(state.issue) : ''),
  })
}

/** 上抛当前草稿连接,让服务端按表单内容探测(未保存编辑 / 新建未落库都走这条)。 */
function requestProbe(p: ModelProvider, vendor: VendorId): void {
  const conn = p.connections[vendor]
  if (!conn) return
  emit('probe', {
    providerId: p.id,
    vendor,
    baseUrl: conn.baseUrl,
    apiKey: effectiveApiKey(conn.apiKey, p.apiKey),
  })
}

// ---- 删除 ----

const removeTarget = ref<ModelProvider | null>(null)
const removeInUse = computed(() => (removeTarget.value ? usedBy(removeTarget.value.id).length : 0))

function confirmRemove(): void {
  const target = removeTarget.value
  if (!target) return
  emit(
    'change',
    props.providers.filter((p) => p.id !== target.id),
  )
  // 引用留给服务端 fail-soft(悬挂 ⇒ 回落 + 告警);这里不去改 agent,免得一次删除
  // 顺手改了另一个页签的草稿。
  removeTarget.value = null
}

// ---- 迁移 ----

const pendingGroups = computed(() => props.plan?.groups ?? [])
const pendingAgentCount = computed(() =>
  pendingGroups.value.reduce((sum, g) => sum + g.agentIds.length, 0),
)
const clearableCount = computed(() => props.plan?.clearableAgentIds.length ?? 0)
const showClearConfirm = ref(false)

function applyMigration(): void {
  emit('migrate', { action: 'apply' })
}
function revertMigration(): void {
  emit('migrate', { action: 'revert' })
}
function confirmClear(): void {
  showClearConfirm.value = false
  emit('migrate', { action: 'clear' })
}

/** 至少有一个迁移生成的 provider 时才给「撤销迁移」——否则这个按钮什么也不会做。 */
const hasSynthesized = computed(() => props.providers.some((p) => p.synthesized))
</script>

<template>
  <div class="providers-tab">
    <p class="settings-hint">{{ t('settings.providers.hint.text') }}</p>

    <!-- 迁移横幅:只在真有旧内联配置或可清理的残留时出现。 -->
    <section
      v-if="pendingGroups.length > 0 || clearableCount > 0 || hasSynthesized"
      class="provider-migration"
      data-testid="provider-migration"
    >
      <strong>{{ t('settings.providers.migration.title') }}</strong>
      <p v-if="pendingGroups.length > 0" class="settings-hint">
        {{
          t('settings.providers.migration.body', {
            agents: pendingAgentCount,
            groups: pendingGroups.length,
          })
        }}
      </p>
      <p v-else class="settings-hint">{{ t('settings.providers.migration.none') }}</p>
      <div class="provider-migration-actions">
        <button
          v-if="pendingGroups.length > 0"
          class="agent-add"
          :disabled="!isAdmin"
          data-testid="provider-migration-apply"
          @click="applyMigration"
        >
          {{ t('settings.providers.migration.apply') }}
        </button>
        <button
          v-if="hasSynthesized"
          class="ghost"
          :disabled="!isAdmin"
          data-testid="provider-migration-revert"
          @click="revertMigration"
        >
          {{ t('settings.providers.migration.revert') }}
        </button>
        <button
          v-if="clearableCount > 0"
          class="ghost"
          :disabled="!isAdmin"
          data-testid="provider-migration-clear"
          @click="showClearConfirm = true"
        >
          {{ t('settings.providers.migration.clear') }}
        </button>
      </div>
    </section>

    <p v-if="providers.length === 0" class="settings-hint" data-testid="provider-empty">
      {{ t('settings.providers.empty.text') }}
    </p>

    <!-- Provider 列表 -->
    <section
      v-for="p in providers"
      :key="p.id"
      class="provider-card"
      :data-provider-id="p.id"
      data-testid="provider-row"
    >
      <div class="provider-head">
        <button class="icon-btn" @click="toggle(p.id)">{{ expanded === p.id ? '▾' : '▸' }}</button>
        <input
          v-model="p.displayName"
          class="agent-field provider-name"
          :placeholder="t('settings.providers.name.placeholder')"
          :disabled="!isAdmin"
          data-testid="provider-name"
          @input="touch(p)"
        />
        <span v-if="p.template" class="provider-badge">{{
          t('settings.providers.template.label', { name: p.template })
        }}</span>
        <span
          v-if="p.synthesized"
          class="provider-badge"
          :title="t('settings.providers.synthesized.tooltip')"
          >{{ t('settings.providers.synthesized.label') }}</span
        >
        <span class="provider-usage">{{
          usedBy(p.id).length > 0
            ? t('settings.providers.usedBy.label', { count: usedBy(p.id).length })
            : t('settings.providers.usedBy.none')
        }}</span>
        <label class="provider-pause" :title="t('settings.providers.paused.tooltip')">
          <input
            type="checkbox"
            :checked="!!p.paused"
            :disabled="!isAdmin"
            data-testid="provider-paused"
            @change="
              ;((p.paused = ($event.target as HTMLInputElement).checked || undefined), touch(p))
            "
          />
          <span>{{ t('settings.providers.paused.label') }}</span>
        </label>
        <button
          class="icon-btn"
          :title="t('settings.providers.remove.tooltip')"
          :disabled="!isAdmin"
          data-testid="provider-remove"
          @click="removeTarget = p"
        >
          🗑
        </button>
      </div>

      <div v-if="expanded === p.id" class="provider-body">
        <label class="provider-field">
          <span class="provider-label">{{ t('settings.providers.apiKey.label') }}</span>
          <input
            v-model="p.apiKey"
            class="agent-field"
            type="password"
            autocomplete="off"
            :placeholder="t('settings.providers.apiKey.placeholder')"
            :disabled="!isAdmin"
            data-testid="provider-account-key"
            @input="touch(p)"
          />
        </label>
        <p class="settings-hint">{{ t('settings.providers.apiKey.hint') }}</p>

        <h4 class="provider-section">{{ t('settings.providers.connection.title') }}</h4>
        <div v-for="v in CONNECTABLE_VENDORS" :key="v" class="provider-conn">
          <label class="provider-conn-toggle">
            <input
              type="checkbox"
              :checked="!!connectionOf(p, v)"
              :disabled="!isAdmin"
              :data-testid="`provider-conn-${v}`"
              @change="setConnected(p, v, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ VENDOR_LABEL[v] }}</span>
          </label>
          <template v-if="connectionOf(p, v)">
            <input
              v-model="p.connections[v]!.baseUrl"
              class="agent-field provider-url"
              :placeholder="t('settings.providers.connection.baseUrl.placeholder')"
              :disabled="!isAdmin"
              :data-testid="`provider-baseurl-${v}`"
              @input="touch(p)"
            />
            <input
              v-model="p.connections[v]!.apiKey"
              class="agent-field provider-key"
              type="password"
              autocomplete="off"
              :placeholder="t('settings.providers.connection.apiKey.placeholder')"
              :disabled="!isAdmin"
              @input="touch(p)"
            />
            <select
              v-if="v === 'codex'"
              v-model="p.connections[v]!.wireApi"
              class="agent-field provider-wireapi"
              :title="t('settings.providers.connection.wireApi.label')"
              :disabled="!isAdmin"
              @change="touch(p)"
            >
              <option value="chat">{{ t('settings.agents.wireApi.chat.label') }}</option>
              <option value="responses">{{ t('settings.agents.wireApi.responses.label') }}</option>
            </select>
            <button
              class="ghost provider-probe"
              :disabled="!isAdmin"
              :data-testid="`provider-probe-${v}`"
              @click="requestProbe(p, v)"
            >
              {{ t('settings.providers.probe.label') }}
            </button>
            <span
              v-if="baseUrlIssue(p.connections[v]!.baseUrl)"
              class="provider-issue"
              :class="baseUrlIssue(p.connections[v]!.baseUrl)!.severity"
              >{{ baseUrlIssue(p.connections[v]!.baseUrl)!.text }}</span
            >
            <span v-if="probeState(p.id, v)" class="provider-probe-result">{{
              probeText(probeState(p.id, v)!)
            }}</span>
          </template>
        </div>

        <h4 class="provider-section">{{ t('settings.providers.models.title') }}</h4>
        <p class="settings-hint">{{ t('settings.providers.models.hint') }}</p>
        <div v-for="(m, i) in p.models ?? []" :key="i" class="provider-model">
          <input
            v-model="m.id"
            class="agent-field"
            :placeholder="t('settings.providers.models.id.placeholder')"
            :disabled="!isAdmin"
            @input="touch(p)"
          />
          <input
            v-model.number="m.contextWindow"
            class="agent-field provider-num"
            type="number"
            min="1"
            :placeholder="t('settings.providers.models.contextWindow.placeholder')"
            :disabled="!isAdmin"
            @input="touch(p)"
          />
          <input
            v-model.number="m.maxOutputTokens"
            class="agent-field provider-num"
            type="number"
            min="1"
            :placeholder="t('settings.providers.models.maxOutput.placeholder')"
            :disabled="!isAdmin"
            @input="touch(p)"
          />
          <button
            class="icon-btn"
            :title="t('settings.providers.models.remove.tooltip')"
            :disabled="!isAdmin"
            @click="removeModel(p, i)"
          >
            🗑
          </button>
        </div>
        <button class="ghost" :disabled="!isAdmin" @click="addModel(p)">
          {{ t('settings.providers.models.add.label') }}
        </button>
      </div>
    </section>

    <div class="provider-list-actions">
      <select
        v-model="newTemplate"
        class="agent-field"
        :disabled="!isAdmin"
        data-testid="provider-template"
      >
        <option value="">{{ t('settings.providers.template.blank.label') }}</option>
        <option v-for="tpl in PROVIDER_TEMPLATES" :key="tpl.id" :value="tpl.id">
          {{ tpl.displayName }}
        </option>
      </select>
      <button class="agent-add" :disabled="!isAdmin" data-testid="provider-add" @click="onCreate">
        {{ t('settings.providers.add.label') }}
      </button>
    </div>

    <ConfirmDialog
      :open="removeTarget !== null"
      :title="t('settings.providers.remove.confirm.title')"
      :message="
        t('settings.providers.remove.confirm.body', { name: removeTarget?.displayName ?? '' }) +
        (removeInUse > 0
          ? ' ' + t('settings.providers.remove.confirm.inUse', { count: removeInUse })
          : '')
      "
      :confirm-label="
        removeInUse > 0
          ? t('settings.providers.remove.confirm.force')
          : t('settings.providers.remove.confirm.confirm')
      "
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmRemove"
      @cancel="removeTarget = null"
    />

    <ConfirmDialog
      :open="showClearConfirm"
      :title="t('settings.providers.migration.clearConfirm.title')"
      :message="t('settings.providers.migration.clearConfirm.body', { count: clearableCount })"
      :confirm-label="t('settings.providers.migration.clearConfirm.confirm')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="confirmClear"
      @cancel="showClearConfirm = false"
    />
  </div>
</template>

<style scoped>
.providers-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.provider-migration {
  border: 1px solid var(--c-warning);
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.provider-migration-actions {
  display: flex;
  gap: 8px;
}
.provider-card {
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 8px 10px;
}
.provider-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.provider-name {
  flex: 0 0 200px;
}
.provider-badge {
  font-size: 11px;
  opacity: 0.75;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
}
.provider-usage {
  font-size: 12px;
  opacity: 0.7;
  margin-left: auto;
}
.provider-pause {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.provider-body {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.provider-field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.provider-label {
  flex: 0 0 110px;
  font-size: 12px;
}
.provider-section {
  margin: 6px 0 0;
  font-size: 13px;
}
.provider-conn,
.provider-model {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.provider-conn-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 120px;
  font-size: 12px;
}
.provider-url {
  flex: 1 1 240px;
}
.provider-key {
  flex: 0 0 160px;
}
.provider-num {
  flex: 0 0 130px;
}
.provider-issue {
  font-size: 12px;
}
.provider-issue.error {
  color: var(--c-danger-text);
}
.provider-issue.warning {
  color: var(--c-warning-text);
}
.provider-probe-result {
  font-size: 12px;
  opacity: 0.8;
}
.provider-list-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
