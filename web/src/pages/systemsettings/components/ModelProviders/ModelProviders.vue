<script setup lang="ts">
/*
 * ModelProviders.vue — 系统设置 ·「模型提供方」页签。
 *
 * 一个 provider 就是一条具名上游(按 protocolType 填 OpenAI / Anthropic URL + 一把账户
 * Key),多个 agent 共用它。Agent 绑定时按自己 vendor 的协议支持列表取第一个有 URL 的槽,
 * 从而得到 baseUrl。把连接从 agent 里提出来之后,轮换 key 或迁移端点只改这一处。
 *
 * Model Vendor(上游厂商)是这条 provider 的身份声明,与 template(创建来源、之后再不读)
 * 是两件事:它被持续读取,决定这条 provider 给出哪些随版本内置的模型建议,并且可以单独改——
 * 自建端点也能认领一个已知厂商,而不必被重置连接字段。内置模型只读,与用户自己的模型条目分区
 * 展示;两者合并后才是 agent 表单看到的候选,而候选永远只是建议,不校验、不兜底、不做白名单。
 *
 * 本组件直接改 props.providers 里的对象(与 agent 列表同一种写法):它们是父级草稿的一部分,
 * 保存与脏检测都由父面板统一负责,这里不发任何消息、也不落库。连通性探测是例外——不是
 * 「编辑一份配置」,而是要服务端替我们去拨号,所以上抛给父级发消息。
 *
 * 删除被引用的 provider 默认阻断:确认框先说明有几个 agent 会退回 CLI 登录态,用户仍可强制
 * 删除(逃生口)。悬挂引用在服务端是 fail-soft 的,所以这里挡的是「误删」,不是「不一致」。
 */
import { computed, ref } from 'vue'
import type {
  AgentConfig,
  ModelProvider,
  ModelProviderModel,
  ProtocolType,
} from '@ccc/shared/protocol'
import { PROTOCOL_TYPES } from '@ccc/shared/protocol'
import {
  MODEL_VENDORS,
  PROVIDER_TEMPLATES,
  checkProviderBaseUrl,
  modelVendorLabel,
  modelVendorModels,
  normalizeModelVendor,
} from '@ccc/shared'
import type { ModelVendorGroup } from '@ccc/shared'
import type { BaseUrlIssue } from '@ccc/shared'
import { useTypedI18n } from '@/i18n'
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
    /** 探测状态,键为 `${providerId}:${protocolType}`。 */
    probes?: Record<string, ProviderProbeState>
    isAdmin?: boolean
  }>(),
  { providers: () => [], agents: () => [], probes: () => ({}), isAdmin: true },
)

const emit = defineEmits<{
  /** 列表整体替换(新增/删除);单字段编辑就地改,不走这里。 */
  change: [providers: ModelProvider[]]
  /**
   * 连通性探测。带上草稿里的 baseUrl / 账户 key,这样未保存的编辑(或尚未落库的新建)
   * 探到的是表单上正在改的值,而不是上次保存的旧记录;providerId 仍带回包匹配用。
   */
  probe: [
    payload: { providerId: string; protocolType: ProtocolType; baseUrl: string; apiKey: string },
  ]
}>()

const PROTOCOL_LABEL: Record<ProtocolType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
}

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
  const urls: ModelProvider['urls'] = { ...(template?.urls ?? {}) }
  const created: ModelProvider = {
    id: mintId(),
    displayName: uniqueName(template?.displayName ?? t('settings.providers.name.placeholder')),
    ...(template ? { template: template.id } : {}),
    vendor: template?.vendor ?? 'custom',
    apiKey: '',
    urls,
    ...(template?.wireApi ? { wireApi: template.wireApi } : {}),
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

// ---- 协议 URL 编辑 ----

function urlOf(p: ModelProvider, protocol: ProtocolType): string {
  return p.urls[protocol] ?? ''
}

/** 已勾选的协议槽,顺序与 PROTOCOL_TYPES 一致;收缩标题行用它标出这条 provider 讲哪些协议。 */
function enabledProtocols(p: ModelProvider): ProtocolType[] {
  return PROTOCOL_TYPES.filter((protocol) => p.urls[protocol] !== undefined)
}

/** 勾选=为该协议建一条空 URL;取消=删除该槽。 */
function setProtocolEnabled(p: ModelProvider, protocol: ProtocolType, on: boolean): void {
  if (on) {
    if (!p.urls[protocol]) p.urls[protocol] = ''
    if (protocol === 'openai' && p.wireApi === undefined) p.wireApi = 'chat'
  } else {
    delete p.urls[protocol]
    if (protocol === 'openai') delete p.wireApi
  }
}

function setUrl(p: ModelProvider, protocol: ProtocolType, value: string): void {
  p.urls[protocol] = value
}

/** 滑动开关开=启用(清 paused),关=运维暂停。不写 `paused: false`,缺省就是启用。 */
function setEnabled(p: ModelProvider, on: boolean): void {
  if (on) delete p.paused
  else p.paused = true
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

// ---- Model Vendor ----

/** 落库值可能缺失或来自更新版本的 c3;一律归一化后再显示,未知即 `custom`。 */
function vendorOf(p: ModelProvider): string {
  return normalizeModelVendor(p.vendor)
}

/** 展示名。厂商名是品牌、不翻译;只有兜底的 `custom` 是一句普通措辞,走 i18n。 */
function vendorText(vendor: unknown): string {
  const id = normalizeModelVendor(vendor)
  return id === 'custom' ? t('settings.providers.modelVendor.custom.label') : modelVendorLabel(id)
}

/**
 * 下拉按分组呈现。目录有五十来家,平铺一列谁也找不到自己要的那个;分组名走 i18n,
 * 因为它们是普通措辞而不是品牌。
 */
const VENDOR_GROUPS: readonly ModelVendorGroup[] = ['model', 'cloud', 'gateway', 'local', 'custom']

function vendorsOf(group: ModelVendorGroup) {
  return MODEL_VENDORS.filter((v) => v.group === group)
}

function groupLabel(group: ModelVendorGroup): string {
  switch (group) {
    case 'model':
      return t('settings.providers.modelVendor.group.model')
    case 'cloud':
      return t('settings.providers.modelVendor.group.cloud')
    case 'gateway':
      return t('settings.providers.modelVendor.group.gateway')
    case 'local':
      return t('settings.providers.modelVendor.group.local')
    default:
      return t('settings.providers.modelVendor.group.custom')
  }
}

/** 只改身份。连接字段、账户 key、暂停位、用户自己的模型条目一概不动。 */
function setVendor(p: ModelProvider, value: string): void {
  p.vendor = normalizeModelVendor(value)
}

// ---- 模型目录 ----

/** 该厂商随版本内置的模型:只读,用户改不了,也删不掉。 */
function shippedModels(p: ModelProvider): readonly ModelProviderModel[] {
  return modelVendorModels(p.vendor)
}

function addModel(p: ModelProvider): void {
  p.models = [...(p.models ?? []), { id: '' }]
}
function removeModel(p: ModelProvider, index: number): void {
  p.models = (p.models ?? []).filter((_, i) => i !== index)
}

// ---- 引用关系 ----

function usedBy(id: string): AgentConfig[] {
  return props.agents.filter((a) => a.providerId === id)
}

// ---- 探测 ----

function probeState(providerId: string, protocol: ProtocolType): ProviderProbeState | undefined {
  return props.probes[providerProbeKey(providerId, protocol)]
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

/** 上抛当前草稿 URL,让服务端按表单内容探测(未保存编辑 / 新建未落库都走这条)。 */
function requestProbe(p: ModelProvider, protocol: ProtocolType): void {
  const baseUrl = p.urls[protocol]
  if (baseUrl === undefined) return
  emit('probe', {
    providerId: p.id,
    protocolType: protocol,
    baseUrl,
    apiKey: p.apiKey,
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
</script>

<template>
  <div class="providers-tab">
    <p class="settings-hint">{{ t('settings.providers.hint.text') }}</p>

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
        />
        <span
          v-if="expanded !== p.id && enabledProtocols(p).length > 0"
          class="provider-protocols"
          data-testid="provider-protocols"
        >
          <span
            v-for="protocol in enabledProtocols(p)"
            :key="protocol"
            class="provider-badge"
            :title="urlOf(p, protocol) || PROTOCOL_LABEL[protocol]"
            :data-testid="`provider-protocol-${protocol}`"
            >{{ PROTOCOL_LABEL[protocol] }}</span
          >
        </span>
        <span class="provider-badge" data-testid="provider-vendor-badge">{{
          vendorText(p.vendor)
        }}</span>
        <span v-if="p.template" class="provider-badge">{{
          t('settings.providers.template.label', { name: p.template })
        }}</span>
        <span class="provider-usage">{{
          usedBy(p.id).length > 0
            ? t('settings.providers.usedBy.label', { count: usedBy(p.id).length })
            : t('settings.providers.usedBy.none')
        }}</span>
        <label class="provider-pause" :title="t('settings.providers.paused.tooltip')">
          <input
            class="agent-enabled-switch"
            type="checkbox"
            role="switch"
            :checked="!p.paused"
            :aria-checked="!p.paused"
            :disabled="!isAdmin"
            data-testid="provider-enabled-switch"
            @change="setEnabled(p, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{
            p.paused ? t('settings.providers.paused.label') : t('settings.providers.enabled.label')
          }}</span>
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
          <span class="provider-label">{{ t('settings.providers.modelVendor.label') }}</span>
          <select
            class="agent-field"
            :value="vendorOf(p)"
            :disabled="!isAdmin"
            data-testid="provider-vendor"
            @change="setVendor(p, ($event.target as HTMLSelectElement).value)"
          >
            <optgroup v-for="g in VENDOR_GROUPS" :key="g" :label="groupLabel(g)">
              <option v-for="v in vendorsOf(g)" :key="v.id" :value="v.id">
                {{ vendorText(v.id) }}
              </option>
            </optgroup>
          </select>
        </label>
        <p class="settings-hint">{{ t('settings.providers.modelVendor.hint') }}</p>

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
          />
        </label>
        <p class="settings-hint">{{ t('settings.providers.apiKey.hint') }}</p>

        <h4 class="provider-section">{{ t('settings.providers.connection.title') }}</h4>
        <div
          v-for="protocol in PROTOCOL_TYPES"
          :key="protocol"
          class="provider-conn-row"
          :data-testid="`provider-conn-row-${protocol}`"
        >
          <label class="provider-conn-toggle">
            <input
              type="checkbox"
              :checked="p.urls[protocol] !== undefined"
              :disabled="!isAdmin"
              :data-testid="`provider-conn-${protocol}`"
              @change="setProtocolEnabled(p, protocol, ($event.target as HTMLInputElement).checked)"
            />
            <span>{{ PROTOCOL_LABEL[protocol] }}</span>
          </label>
          <template v-if="p.urls[protocol] !== undefined">
            <input
              class="agent-field provider-url"
              :value="urlOf(p, protocol)"
              :placeholder="t('settings.providers.connection.baseUrl.placeholder')"
              :disabled="!isAdmin"
              :data-testid="`provider-baseurl-${protocol}`"
              @input="setUrl(p, protocol, ($event.target as HTMLInputElement).value)"
            />
            <select
              v-if="protocol === 'openai'"
              v-model="p.wireApi"
              class="agent-field provider-wireapi"
              :title="t('settings.providers.connection.wireApi.label')"
              :disabled="!isAdmin"
              data-testid="provider-wireapi"
            >
              <option value="chat">{{ t('settings.agents.wireApi.chat.label') }}</option>
              <option value="responses">{{ t('settings.agents.wireApi.responses.label') }}</option>
            </select>
            <button
              class="ghost provider-probe"
              :disabled="!isAdmin"
              :data-testid="`provider-probe-${protocol}`"
              @click="requestProbe(p, protocol)"
            >
              {{ t('settings.providers.probe.label') }}
            </button>
            <span
              v-if="baseUrlIssue(urlOf(p, protocol))"
              class="provider-issue"
              :class="baseUrlIssue(urlOf(p, protocol))!.severity"
              :title="baseUrlIssue(urlOf(p, protocol))!.text"
              >{{ baseUrlIssue(urlOf(p, protocol))!.text }}</span
            >
            <span
              v-if="probeState(p.id, protocol)"
              class="provider-probe-result"
              :title="probeText(probeState(p.id, protocol)!)"
              >{{ probeText(probeState(p.id, protocol)!) }}</span
            >
          </template>
        </div>

        <h4 class="provider-section">{{ t('settings.providers.models.title') }}</h4>
        <p class="settings-hint">{{ t('settings.providers.models.hint') }}</p>

        <h5 class="provider-subsection">{{ t('settings.providers.models.shipped.title') }}</h5>
        <p
          v-if="shippedModels(p).length === 0"
          class="settings-hint"
          data-testid="provider-shipped-empty"
        >
          {{ t('settings.providers.models.shipped.empty') }}
        </p>
        <div v-else class="provider-shipped">
          <span
            v-for="m in shippedModels(p)"
            :key="m.id"
            class="provider-badge"
            data-testid="provider-shipped-model"
            >{{ m.id }}</span
          >
        </div>

        <h5 class="provider-subsection">{{ t('settings.providers.models.custom.title') }}</h5>
        <div
          v-for="(m, i) in p.models ?? []"
          :key="i"
          class="provider-model"
          data-testid="provider-model-row"
        >
          <input
            v-model="m.id"
            class="agent-field"
            :placeholder="t('settings.providers.models.name.placeholder')"
            :disabled="!isAdmin"
            data-testid="provider-model-name"
          />
          <button
            class="icon-btn"
            :title="t('settings.providers.models.remove.tooltip')"
            :disabled="!isAdmin"
            data-testid="provider-model-remove"
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
  </div>
</template>

<style scoped>
.providers-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.provider-card {
  border: 1px solid var(--c-border);
  border-radius: 6px;
  padding: 8px 10px;
}
.provider-head {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
}
.provider-name {
  flex: 0 0 200px;
}
.provider-protocols {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}
.provider-badge {
  font-size: 11px;
  opacity: 0.75;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
  white-space: nowrap;
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
  white-space: nowrap;
  cursor: pointer;
}
.provider-pause .agent-enabled-switch:disabled {
  cursor: default;
  opacity: 0.4;
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
.provider-subsection {
  margin: 4px 0 0;
  font-size: var(--fs-caption);
  opacity: 0.8;
}
/* 内置模型是只读徽标而不是输入行 —— 形状上就与下面可编辑的自定义条目区分开。 */
.provider-shipped {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.provider-model {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--sp-2);
}
.provider-model > .agent-field {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
}
/* protocol type + URL + wireApi + 测试(及结论) 同一行,不换行;窄时横向滚动。
 * `.agent-field` 默认 width:100% 会把 URL / select 各自撑成整行,这里压回按列宽。 */
.provider-conn-row {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--sp-2);
  overflow-x: auto;
}
.provider-conn-row > .agent-field {
  width: auto;
}
.provider-conn-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: var(--fs-caption);
}
.provider-url {
  flex: 1 1 240px;
  min-width: 160px;
}
.provider-wireapi {
  flex: 0 0 148px;
  width: 148px;
}
.provider-probe {
  flex: 0 0 auto;
  height: 34px;
  padding: 0 var(--sp-3);
  white-space: nowrap;
  background: transparent;
  color: var(--c-text);
  border: 1px solid var(--c-border);
  font-size: var(--fs-code);
  font-weight: 500;
}
.provider-issue,
.provider-probe-result {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-caption);
}
.provider-issue.error {
  color: var(--c-danger-text);
}
.provider-issue.warning {
  color: var(--c-warning-text);
}
.provider-probe-result {
  opacity: 0.8;
}
.provider-list-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
