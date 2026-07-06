<script setup lang="ts">
/**
 * AutomationForm.vue — modal for creating and editing a automation.
 *
 * One component serves both flows: `automation === null` is a create, otherwise an
 * edit (type is immutable on edit, per the protocol). The cron expression is
 * built with an Advanced segmented builder (frequency / interval / time / days)
 * that feeds a single `cronExpression`, with a live "next run" preview computed
 * by the same `computeNextRunAt` the server uses.
 *
 * The automation's display name is auto-generated server-side from the task
 * content on create — the create flow does not collect a name. On EDIT the form
 * exposes a Title input prefilled with the current name: saving a non-empty
 * value sets a sticky manual title; clearing it reverts to auto-naming.
 *
 * Cron fields are interpreted in the system `timezone` (the `timezone` prop,
 * sourced from the server settings); the preview passes it to `computeNextRunAt`
 * so the previewed instant matches the one the server will automation.
 */
import { ref, computed, watch } from 'vue'
import {
  isValidAutomationMaxWallClockMs,
  MAX_AUTOMATION_MAX_WALL_CLOCK_MS,
  MIN_AUTOMATION_MAX_WALL_CLOCK_MS,
} from '@ccc/shared/protocol'
import type {
  CodexApprovalPolicy,
  CodexPolicy,
  CodexSandboxMode,
  AgentConfig,
  CreateAutomationInput,
  EventMetadataFilter,
  IntentLifecyclePhase,
  ModeToken,
  PrOperation,
  PrOperationResult,
  RunEndReason,
  Automation,
  ScheduleEventTopic,
  ScheduleTriggerType,
  AutomationType,
  SessionKind,
  ToolManifestEntry,
  UpdateAutomationInput,
  VendorHostStatus,
  VendorId,
} from '@ccc/shared/protocol'
import { SESSION_KINDS } from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron, describeCron } from '@ccc/shared/cron'
import { VENDOR_LABEL } from '@/lib/vendor'
import { useTypedI18n } from '@/i18n'
import AutomationCronEditor from '../AutomationDetail/AutomationCronEditor.vue'
import { resolveAutomationDefaultAgent } from './resolveAutomationDefaultAgent'

// `d` 别名为 `fmtDateTime`:模板里 `v-for="d in WEEKDAYS"` 已占用 `d`,避免 shadow。
const { t, d: fmtDateTime } = useTypedI18n()

const props = defineProps<{
  open: boolean
  /** Non-null = edit an existing automation; null = create a new one. */
  automation: Automation | null
  /** Owning workspace for new automations. */
  workspacePath: string
  /** System IANA time zone the cron next-run preview is computed in. */
  timezone: string
  /** Tool manifest per vendor (cached by App.vue). */
  toolManifest: Record<string, ToolManifestEntry[] | null>
  toolManifestLoading: boolean
  toolManifestError: string | null
  /** Per-vendor host-CLI presence for greying absent vendors. */
  hostStatus: VendorHostStatus[]
  /** Enabled execution profiles; filtered by the selected vendor. */
  agents?: AgentConfig[]
  /**
   * System-configured default agent for the new-automation form (AC-R25). Empty
   * ⇒ follow `defaultAgentId`. Only seeds the create form's initial vendor+agent;
   * editing an existing automation is unaffected.
   */
  automationAgentId?: string
  /** System default agent, the follow-chain fallback for `automationAgentId`. */
  defaultAgentId?: string
}>()

const emit = defineEmits<{
  close: []
  create: [input: CreateAutomationInput]
  update: [id: string, input: UpdateAutomationInput]
  'load-tool-manifest': [vendor: string]
}>()

const isEdit = computed(() => props.automation !== null)

const WEEKDAYS = computed<{ num: number; label: string }[]>(() => [
  { num: 0, label: t('automation.form.weekday.sun') },
  { num: 1, label: t('automation.form.weekday.mon') },
  { num: 2, label: t('automation.form.weekday.tue') },
  { num: 3, label: t('automation.form.weekday.wed') },
  { num: 4, label: t('automation.form.weekday.thu') },
  { num: 5, label: t('automation.form.weekday.fri') },
  { num: 6, label: t('automation.form.weekday.sat') },
])

const TRIGGER_TYPES = computed<{ value: ScheduleTriggerType; label: string }[]>(() => [
  { value: 'cron', label: t('automation.form.trigger.cron.label') },
  { value: 'event', label: t('automation.form.trigger.event.label') },
])

// Event trigger is chosen in two tiers: a level-1 category (run lifecycle / PR /
// intent) and, only for run lifecycle, a level-2 stage (started / finished).
// Both are views over the single `eventTopic` protocol field — the category is a
// display grouping that never enters the payload.
type EventCategory = 'run-lifecycle' | 'pr-operation' | 'intent-lifecycle'
type RunStage = 'started' | 'settled'

const EVENT_CATEGORIES = computed<{ value: EventCategory; label: string }[]>(() => [
  { value: 'run-lifecycle', label: t('automation.form.event.category.runLifecycle.label') },
  { value: 'pr-operation', label: t('automation.form.event.topic.prOperation.label') },
  { value: 'intent-lifecycle', label: t('automation.form.event.topic.intentLifecycle.label') },
])

const EVENT_REASONS = computed<{ value: RunEndReason; label: string }[]>(() => [
  { value: 'complete', label: t('automation.form.event.reason.complete.label') },
  { value: 'error', label: t('automation.form.event.reason.error.label') },
  { value: 'aborted', label: t('automation.form.event.reason.aborted.label') },
])

// PR operation event filter options (the `pr:operation` topic; 2026-06-20).
// Literal i18n keys (the typed `t` rejects dynamic template keys).
const PR_OPERATION_OPTIONS = computed<{ value: PrOperation; label: string }[]>(() => [
  { value: 'create', label: t('automation.form.event.pr.op.create.label') },
  { value: 'review', label: t('automation.form.event.pr.op.review.label') },
  { value: 'merge', label: t('automation.form.event.pr.op.merge.label') },
  { value: 'close', label: t('automation.form.event.pr.op.close.label') },
  { value: 'comment', label: t('automation.form.event.pr.op.comment.label') },
])
const PR_RESULT_OPTIONS = computed<{ value: PrOperationResult; label: string }[]>(() => [
  { value: 'success', label: t('automation.form.event.pr.result.success.label') },
  { value: 'failure', label: t('automation.form.event.pr.result.failure.label') },
  { value: 'error', label: t('automation.form.event.pr.result.error.label') },
])

// ---- Vendor ----------------------------------------------------------------
const VENDOR_ORDER: VendorId[] = ['claude', 'codex']

const presentByVendor = computed(() => {
  const m = new Map<VendorId, boolean>()
  for (const h of props.hostStatus) m.set(h.vendor, h.present)
  return m
})

function vendorPresent(v: VendorId): boolean {
  return presentByVendor.value.get(v) !== false
}

const vendor = ref<VendorId>('claude')
const agentId = ref('')
// Tracks whether the user has manually changed vendor (to avoid re-triggering the
// manifest load during the initial re-seed from automation props).
const vendorInitialised = ref(false)

// ---- Form draft ----------------------------------------------------------
const type = ref<AutomationType>('command')
// Manual display title — edit-only. Prefilled from the current name; an empty
// value on save tells the server to revert to auto-naming.
const title = ref('')
// Vendor-specific permission mode refs; serialized on save.
const claudeMode = ref<string>('default')
const codexSandboxMode = ref<CodexSandboxMode>('workspace-write')
const codexApprovalPolicy = ref<CodexApprovalPolicy>('on-request')
const command = ref('')
const prompt = ref('')
const maxWallClockMs = ref<number | null>(null)
const cronExpression = ref('*/30 * * * *')
const cronEditorOpen = ref(false)
const triggerType = ref<ScheduleTriggerType>('cron')
const eventTopic = ref<ScheduleEventTopic>('run:settled')
const eventReasonFilter = ref<RunEndReason[]>([])
// PR operation event filter (the `pr:operation` topic). Empty list = any.
const prOperations = ref<PrOperation[]>([])
const prResults = ref<PrOperationResult[]>([])
const intentPhases = ref<IntentLifecyclePhase[]>([])
// Run-lifecycle sessionKind filter (required, no default selection) + free-form
// metadata annotations + metadata condition builder.
const eventSessionKinds = ref<SessionKind[]>([])
const metadataRows = ref<{ key: string; value: string }[]>([])
const metadataConditions = ref<{ key: string; value: string }[]>([])
const metadataCombinator = ref<'AND' | 'OR'>('AND')
// Literal i18n keys per SessionKind (the typed `t` rejects dynamic template keys).
const SESSION_KIND_LABEL = computed<Record<SessionKind, string>>(() => ({
  work: t('automation.form.event.sessionKind.work.label'),
  intent: t('automation.form.event.sessionKind.intent.label'),
  discussion: t('automation.form.event.sessionKind.discussion.label'),
  automation: t('automation.form.event.sessionKind.automation.label'),
  consensus: t('automation.form.event.sessionKind.consensus.label'),
  tool: t('automation.form.event.sessionKind.tool.label'),
  spec: t('automation.form.event.sessionKind.spec.label'),
}))
const SESSION_KIND_OPTIONS = computed<{ value: SessionKind; label: string }[]>(() =>
  SESSION_KINDS.map((value) => ({ value, label: SESSION_KIND_LABEL.value[value] })),
)
const INTENT_PHASE_OPTIONS = computed<{ value: IntentLifecyclePhase; label: string }[]>(() => [
  { value: 'created', label: t('automation.form.event.intent.created.label') },
  { value: 'dev_started', label: t('automation.form.event.intent.devStarted.label') },
  { value: 'done', label: t('automation.form.event.intent.done.label') },
  { value: 'failed', label: t('automation.form.event.intent.failed.label') },
  { value: 'cancelled', label: t('automation.form.event.intent.cancelled.label') },
])

const toolAllowlist = ref<string[]>([])

const vendorAgents = computed(() =>
  (props.agents ?? []).filter((agent) => agent.vendor === vendor.value && agent.enabled !== false),
)

// The reason filter only applies to run:settled (run:started has no outcome).
const showReasonFilter = computed(
  () => triggerType.value === 'event' && eventTopic.value === 'run:settled',
)
// The PR filter panel only applies to the pr:operation topic (2026-06-20).
const showPrFilter = computed(
  () => triggerType.value === 'event' && eventTopic.value === 'pr:operation',
)
const showIntentFilter = computed(
  () => triggerType.value === 'event' && eventTopic.value === 'intent:lifecycle',
)
// sessionKind + metadata filters apply only to run-lifecycle event triggers.
const showRunLifecycleFilters = computed(
  () =>
    triggerType.value === 'event' &&
    (eventTopic.value === 'run:started' || eventTopic.value === 'run:settled'),
)

// Level-1 event category derived from the underlying topic. Purely a view model.
const eventCategory = computed<EventCategory>(() => {
  if (eventTopic.value === 'pr:operation') return 'pr-operation'
  if (eventTopic.value === 'intent:lifecycle') return 'intent-lifecycle'
  return 'run-lifecycle'
})
// Level-2 run stage; only meaningful while the category is run-lifecycle.
const runStage = computed<RunStage>(() =>
  eventTopic.value === 'run:started' ? 'started' : 'settled',
)

// Selecting a category writes back to `eventTopic` so all existing show/hide and
// save logic keeps keying off the single protocol field. Switching to run
// lifecycle keeps the current run stage, else defaults to run:settled (matching
// the create default).
function selectEventCategory(cat: EventCategory): void {
  if (cat === 'pr-operation') {
    eventTopic.value = 'pr:operation'
  } else if (cat === 'intent-lifecycle') {
    eventTopic.value = 'intent:lifecycle'
  } else if (eventTopic.value !== 'run:started' && eventTopic.value !== 'run:settled') {
    eventTopic.value = 'run:settled'
  }
}

function selectRunStage(stage: RunStage): void {
  eventTopic.value = stage === 'started' ? 'run:started' : 'run:settled'
}

// Advanced segmented builder.
type Frequency = 'minutely' | 'hourly' | 'daily' | 'weekly'
const advFreq = ref<Frequency>('daily')
const advInterval = ref(30) // every N minutes / hours
const advHour = ref(8)
const advMinute = ref(0)
const advDays = ref<number[]>([1, 2, 3, 4, 5])

function readConfigField(cfg: unknown, key: string): string {
  if (cfg && typeof cfg === 'object' && key in cfg) {
    const v = (cfg as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : ''
  }
  return ''
}

// Re-seed the draft whenever the modal opens (or the target automation changes).
watch(
  () => [props.open, props.automation] as const,
  ([open, sched]) => {
    if (!open) return
    if (sched) {
      type.value = sched.type
      title.value = readConfigField(sched.config, 'name')
      // Restore permission mode per vendor (handle legacy McpMode strings too).
      if (sched.vendor === 'codex') {
        if (typeof sched.mode === 'object' && sched.mode !== null) {
          codexSandboxMode.value = sched.mode.sandboxMode
          codexApprovalPolicy.value = sched.mode.approvalPolicy
        } else {
          const legacy = sched.mode as string
          codexSandboxMode.value = legacy === 'read-only' ? 'read-only' : 'workspace-write'
          codexApprovalPolicy.value =
            legacy === 'read-only' || legacy === 'full-access' ? 'never' : 'on-request'
        }
      } else {
        // claude
        const m = typeof sched.mode === 'string' ? sched.mode : 'default'
        claudeMode.value =
          m === 'read-only'
            ? 'plan'
            : m === 'sandboxed'
              ? 'auto'
              : m === 'full-access'
                ? 'bypassPermissions'
                : m
      }
      cronExpression.value = sched.cronExpression || '*/30 * * * *'
      command.value = readConfigField(sched.config, 'command')
      prompt.value = readConfigField(sched.config, 'prompt')
      maxWallClockMs.value = sched.maxWallClockMs
      triggerType.value = sched.triggerType
      eventTopic.value = sched.eventTopic ?? 'run:settled'
      eventReasonFilter.value = sched.eventReasonFilter ? [...sched.eventReasonFilter] : []
      prOperations.value = sched.eventPrFilter?.operations
        ? [...sched.eventPrFilter.operations]
        : []
      prResults.value = sched.eventPrFilter?.results ? [...sched.eventPrFilter.results] : []
      intentPhases.value = sched.eventIntentFilter?.phases
        ? [...sched.eventIntentFilter.phases]
        : []
      eventSessionKinds.value = sched.eventSessionKindFilter
        ? [...sched.eventSessionKindFilter]
        : []
      metadataRows.value = Object.entries(sched.metadata ?? {}).map(([key, value]) => ({
        key,
        value,
      }))
      metadataConditions.value = sched.eventMetadataFilter?.conditions
        ? sched.eventMetadataFilter.conditions.map((c) => ({ key: c.key, value: c.value }))
        : []
      metadataCombinator.value = sched.eventMetadataFilter?.combinator ?? 'AND'
      // Vendor: restore from automation, then trigger manifest load.
      vendor.value = sched.vendor
      agentId.value = sched.agentId ?? ''
      vendorInitialised.value = true
      // Restore tool allowlist from the automation; empty means "all tools" (unrestricted).
      toolAllowlist.value = sched.toolAllowlist ? [...sched.toolAllowlist] : []
    } else {
      type.value = 'command'
      title.value = ''
      claudeMode.value = 'default'
      codexSandboxMode.value = 'workspace-write'
      codexApprovalPolicy.value = 'on-request'
      cronExpression.value = '*/30 * * * *'
      command.value = ''
      prompt.value = ''
      maxWallClockMs.value = null
      triggerType.value = 'cron'
      eventTopic.value = 'run:settled'
      eventReasonFilter.value = []
      prOperations.value = []
      prResults.value = []
      intentPhases.value = []
      // No default sessionKind selection: a run-lifecycle event trigger must be
      // explicitly scoped before it can be saved.
      eventSessionKinds.value = []
      metadataRows.value = []
      metadataConditions.value = []
      metadataCombinator.value = 'AND'
      // Seed the create form's default vendor+agent from the system-configured
      // `automationAgentId` (AC-R25): resolve the concrete agent via the follow
      // chain `automationAgentId → defaultAgentId → first enabled agent`. No enabled
      // agent ⇒ system fallback (vendor `claude`, empty agent). The user can still
      // change vendor/agent afterwards.
      const seed = resolveAutomationDefaultAgent(
        props.agents ?? [],
        props.automationAgentId ?? '',
        props.defaultAgentId ?? '',
      )
      vendor.value = seed?.vendor ?? 'claude'
      agentId.value = seed?.id ?? ''
      vendorInitialised.value = true
      toolAllowlist.value = []
    }
    // Initial vendor's tool manifest must always be loaded — the vendor watcher
    // won't fire if the seed value matches the default ('claude'), leaving the
    // tool panel permanently blank.
    emit('load-tool-manifest', vendor.value)
  },
  { immediate: true },
)

// Trigger tool manifest fetch on vendor change (only after initial seed).
watch(vendor, (v) => {
  // Re-seeding an existing automation changes the ref from the default before its
  // bound agent is restored. That is not a user vendor change and must preserve
  // the persisted agent binding; every real vendor change clears it.
  const isInitialExistingVendor = props.automation !== null && v === props.automation.vendor
  if (vendorInitialised.value && !isInitialExistingVendor) {
    agentId.value = ''
    toolAllowlist.value = []
    emit('load-tool-manifest', v)
  }
})

// ---- Advanced mode -------------------------------------------------------
function renderDow(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 5 && sorted.join(',') === '1,2,3,4,5') return '1-5'
  if (sorted.length === 0) return '*'
  return sorted.join(',')
}

const advancedCron = computed(() => {
  const m = Math.min(59, Math.max(0, advMinute.value || 0))
  const h = Math.min(23, Math.max(0, advHour.value || 0))
  const n = Math.max(1, advInterval.value || 1)
  switch (advFreq.value) {
    case 'minutely':
      return `*/${Math.min(59, n)} * * * *`
    case 'hourly':
      return `${m} */${Math.min(23, n)} * * *`
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly':
      return `${m} ${h} * * ${renderDow(advDays.value)}`
  }
  return '*/30 * * * *'
})
watch(advancedCron, (cron) => {
  cronExpression.value = cron
})

function toggleDay(num: number): void {
  const i = advDays.value.indexOf(num)
  if (i >= 0) advDays.value.splice(i, 1)
  else advDays.value.push(num)
}

function updateCronDraft(value: string): void {
  cronExpression.value = value
  cronEditorOpen.value = false
}

// ---- Live preview --------------------------------------------------------
const cronValid = computed(() => isValidCron(cronExpression.value))
const cronSummary = computed(() => (cronValid.value ? describeCron(cronExpression.value) : ''))
const nextRunPreview = computed(() => {
  if (!cronValid.value) return null
  try {
    return fmtDateTime(computeNextRunAt(cronExpression.value, Date.now(), props.timezone), {
      key: 'datetime',
      timeZone: props.timezone,
    })
  } catch {
    return null
  }
})

// ---- Save ----------------------------------------------------------------
const taskFilled = computed(() =>
  type.value === 'command' ? command.value.trim().length > 0 : prompt.value.trim().length > 0,
)
// Cron triggers need a valid expression; event triggers need a topic to subscribe to.
const triggerValid = computed(() =>
  triggerType.value === 'cron' ? cronValid.value : !!eventTopic.value,
)
const maxWallClockMsValid = computed(() => isValidAutomationMaxWallClockMs(maxWallClockMs.value))
const canSave = computed(
  () =>
    taskFilled.value &&
    triggerValid.value &&
    sessionKindValid.value &&
    maxWallClockMsValid.value &&
    (type.value === 'command' || agentId.value.length > 0),
)

function setMaxWallClockMs(event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  maxWallClockMs.value = raw === '' ? null : Number(raw)
}

function toggleReason(r: RunEndReason): void {
  const i = eventReasonFilter.value.indexOf(r)
  if (i >= 0) eventReasonFilter.value.splice(i, 1)
  else eventReasonFilter.value.push(r)
}

function togglePrOperation(op: PrOperation): void {
  const i = prOperations.value.indexOf(op)
  if (i >= 0) prOperations.value.splice(i, 1)
  else prOperations.value.push(op)
}

function togglePrResult(r: PrOperationResult): void {
  const i = prResults.value.indexOf(r)
  if (i >= 0) prResults.value.splice(i, 1)
  else prResults.value.push(r)
}

function toggleIntentPhase(phase: IntentLifecyclePhase): void {
  const i = intentPhases.value.indexOf(phase)
  if (i >= 0) intentPhases.value.splice(i, 1)
  else intentPhases.value.push(phase)
}

function toggleSessionKind(kind: SessionKind): void {
  const i = eventSessionKinds.value.indexOf(kind)
  if (i >= 0) eventSessionKinds.value.splice(i, 1)
  else eventSessionKinds.value.push(kind)
}

function addMetadataRow(): void {
  metadataRows.value.push({ key: '', value: '' })
}
function removeMetadataRow(index: number): void {
  metadataRows.value.splice(index, 1)
}

function addMetadataCondition(): void {
  metadataConditions.value.push({ key: '', value: '' })
}
function removeMetadataCondition(index: number): void {
  metadataConditions.value.splice(index, 1)
}

/** Collapse the metadata rows into a clean object (trimmed, non-empty, last-wins). */
function buildMetadata(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of metadataRows.value) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (key && value) out[key] = value
  }
  return out
}

/** Collapse the metadata condition rows into an {@link EventMetadataFilter} or null. */
function buildMetadataFilter(): EventMetadataFilter | null {
  const conditions = metadataConditions.value
    .map((c) => ({ key: c.key.trim(), value: c.value.trim() }))
    .filter((c) => c.key && c.value)
  return conditions.length ? { conditions, combinator: metadataCombinator.value } : null
}

// A run-lifecycle event trigger must pick at least one sessionKind before saving.
const sessionKindValid = computed(
  () => !showRunLifecycleFilters.value || eventSessionKinds.value.length > 0,
)

// ---- Tool manifest helpers -------------------------------------------------
const currentTools = computed<ToolManifestEntry[]>(() => props.toolManifest[vendor.value] ?? [])

const readTools = computed<ToolManifestEntry[]>(() => currentTools.value.filter((t) => !t.isWrite))

const writeTools = computed<ToolManifestEntry[]>(() => currentTools.value.filter((t) => t.isWrite))

function toggleTool(name: string): void {
  const i = toolAllowlist.value.indexOf(name)
  if (i >= 0) toolAllowlist.value.splice(i, 1)
  else toolAllowlist.value.push(name)
}

function toolChecked(name: string): boolean {
  return toolAllowlist.value.includes(name)
}

function selectAll(): void {
  toolAllowlist.value = currentTools.value.map((t) => t.name)
}

function clearAll(): void {
  toolAllowlist.value = []
}

// Derive default selections when a fresh manifest arrives and there's no saved
// allowlist yet. Read tools checked by default, write tools unchecked.
watch(
  () => props.toolManifest[vendor.value],
  (manifest) => {
    if (!manifest) return
    // Only seed defaults when toolAllowlist is empty (either user cleared it, or
    // this is a fresh vendor with no saved selection). For edit, allowlist was
    // already seeded from automation.toolAllowlist in the form-reset watch, so skip.
    if (toolAllowlist.value.length === 0) {
      toolAllowlist.value = manifest.filter((t) => !t.isWrite).map((t) => t.name)
    }
  },
  { immediate: true },
)

function buildConfig(): Record<string, unknown> {
  // Name is auto-generated server-side; the form supplies only the task body.
  const base: Record<string, unknown> = {}
  if (type.value === 'command') base.command = command.value.trim()
  else base.prompt = prompt.value
  return base
}

function serializeMode(): ModeToken | CodexPolicy {
  if (vendor.value === 'codex') {
    return {
      sandboxMode: codexSandboxMode.value,
      approvalPolicy: codexApprovalPolicy.value,
    }
  }
  return claudeMode.value
}

function save(): void {
  if (!canSave.value) return
  const config = buildConfig()
  const isEvent = triggerType.value === 'event'
  // Reason filter only carries for run:settled; an empty list means "any outcome".
  const reasonFilter: RunEndReason[] | null =
    isEvent && eventTopic.value === 'run:settled' && eventReasonFilter.value.length
      ? [...eventReasonFilter.value]
      : null
  // PR filter only carries for pr:operation; empty dimensions mean "any".
  const prFilter =
    isEvent &&
    eventTopic.value === 'pr:operation' &&
    (prOperations.value.length || prResults.value.length)
      ? {
          ...(prOperations.value.length ? { operations: [...prOperations.value] } : {}),
          ...(prResults.value.length ? { results: [...prResults.value] } : {}),
        }
      : null
  const intentFilter =
    isEvent && eventTopic.value === 'intent:lifecycle' && intentPhases.value.length
      ? { phases: [...intentPhases.value] }
      : null
  // sessionKind + metadata filters only carry for run-lifecycle event triggers.
  const isRunLifecycle =
    isEvent && (eventTopic.value === 'run:started' || eventTopic.value === 'run:settled')
  const sessionKindFilter: SessionKind[] | null = isRunLifecycle
    ? [...eventSessionKinds.value]
    : null
  const metadataFilter = isRunLifecycle ? buildMetadataFilter() : null
  const metadata = buildMetadata()
  if (isEdit.value && props.automation) {
    // Carry the manual title: a non-empty value is stored sticky server-side; an
    // empty value reverts to auto-naming. Create never sends a name (auto only).
    config.name = title.value.trim()
    const input: UpdateAutomationInput = {
      config,
      maxWallClockMs: maxWallClockMs.value,
      mode: serializeMode(),
      triggerType: triggerType.value,
      vendor: vendor.value,
      agentId: type.value === 'llm' ? agentId.value : null,
      toolAllowlist: [...toolAllowlist.value],
      metadata,
    }
    // The store clears the other trigger's fields on a triggerType switch, so we
    // only send the fields matching the chosen type (avoids a double column set).
    if (isEvent) {
      input.eventTopic = eventTopic.value
      input.eventReasonFilter = reasonFilter
      input.eventPrFilter = prFilter
      input.eventIntentFilter = intentFilter
      input.eventSessionKindFilter = sessionKindFilter
      input.eventMetadataFilter = metadataFilter
    } else {
      input.cronExpression = cronExpression.value
    }
    emit('update', props.automation.id, input)
  } else {
    emit('create', {
      type: type.value,
      config,
      maxWallClockMs: maxWallClockMs.value,
      workspaceId: props.workspacePath,
      mode: serializeMode(),
      vendor: vendor.value,
      agentId: type.value === 'llm' ? agentId.value : null,
      triggerType: triggerType.value,
      cronExpression: isEvent ? '' : cronExpression.value,
      eventTopic: isEvent ? eventTopic.value : null,
      eventReasonFilter: reasonFilter,
      eventPrFilter: prFilter,
      eventIntentFilter: intentFilter,
      eventSessionKindFilter: sessionKindFilter,
      eventMetadataFilter: metadataFilter,
      metadata,
      toolAllowlist: [...toolAllowlist.value],
    })
  }
  emit('close')
}
</script>

<template>
  <div v-if="open" class="sf-overlay" @click.self="emit('close')">
    <div class="sf-modal" role="dialog" aria-modal="true">
      <div class="sf-head">
        <h2>{{ isEdit ? t('automation.form.editTitle') : t('automation.form.newTitle') }}</h2>
        <button
          class="sf-icon-btn"
          :title="t('common.action.close.tooltip')"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="sf-body">
        <!-- Section: basic info -->
        <div class="sf-section" data-testid="section-basic">
          <span class="sf-section-title">{{ t('automation.form.section.basic') }}</span>
          <div class="sf-section-body">
            <!-- Title (edit only): auto-named on create, manually editable here. -->
            <label v-if="isEdit" class="sf-field">
              <span class="sf-label">{{ t('automation.form.title.label') }}</span>
              <input
                v-model="title"
                class="sf-input"
                :placeholder="t('automation.form.title.placeholder')"
              />
              <span class="sf-hint">{{ t('automation.form.title.hint') }}</span>
            </label>

            <div class="sf-field">
              <span class="sf-label">{{ t('automation.form.taskType.label') }}</span>
              <div class="sf-segmented">
                <button
                  type="button"
                  class="sf-seg"
                  :class="{ active: type === 'command' }"
                  :disabled="isEdit"
                  @click="type = 'command'"
                >
                  {{ t('automation.form.type.command.label') }}
                </button>
                <button
                  type="button"
                  class="sf-seg"
                  :class="{ active: type === 'llm' }"
                  :disabled="isEdit"
                  @click="type = 'llm'"
                >
                  {{ t('automation.form.type.llm.label') }}
                </button>
              </div>
              <span v-if="isEdit" class="sf-hint">{{ t('automation.form.taskType.locked') }}</span>
            </div>

            <!-- Command body -->
            <label v-if="type === 'command'" class="sf-field sf-field--stacked">
              <span class="sf-label">{{ t('automation.form.command.label') }}</span>
              <textarea
                v-model="command"
                class="sf-textarea sf-mono"
                rows="2"
                :placeholder="t('automation.form.command.placeholder')"
              />
            </label>

            <!-- LLM prompt -->
            <label v-else class="sf-field sf-field--stacked">
              <span class="sf-label">{{ t('automation.form.prompt.label') }}</span>
              <textarea
                v-model="prompt"
                class="sf-textarea"
                rows="6"
                :placeholder="t('automation.form.prompt.placeholder')"
              />
            </label>

            <label class="sf-field sf-field--stacked">
              <span class="sf-label">{{ t('automation.form.maxWallClockMs.label') }}</span>
              <input
                class="sf-input sf-timeout-input"
                type="number"
                :min="MIN_AUTOMATION_MAX_WALL_CLOCK_MS"
                :max="MAX_AUTOMATION_MAX_WALL_CLOCK_MS"
                :step="1000"
                :value="maxWallClockMs ?? ''"
                :placeholder="t('automation.form.maxWallClockMs.placeholder')"
                @input="setMaxWallClockMs"
              />
              <span class="sf-hint">{{ t('automation.form.maxWallClockMs.hint') }}</span>
              <span v-if="!maxWallClockMsValid" class="sf-warn">{{
                t('automation.form.maxWallClockMs.invalid')
              }}</span>
            </label>
          </div>
        </div>

        <!-- Section: trigger -->
        <div class="sf-section" data-testid="section-trigger">
          <span class="sf-section-title">{{ t('automation.form.section.trigger') }}</span>
          <div class="sf-section-body">
            <!-- Trigger type: a cron automation vs a run lifecycle event -->
            <div class="sf-field">
              <span class="sf-label">{{ t('automation.form.trigger.label') }}</span>
              <div class="sf-segmented">
                <button
                  v-for="tt in TRIGGER_TYPES"
                  :key="tt.value"
                  type="button"
                  class="sf-seg"
                  :class="{ active: triggerType === tt.value }"
                  @click="triggerType = tt.value"
                >
                  {{ tt.label }}
                </button>
              </div>
            </div>

            <!-- Automation (cron) builder -->
            <div v-if="triggerType === 'cron'" class="sf-field sf-field--stacked">
              <span class="sf-label">{{ t('automation.form.automation.label') }}</span>

              <!-- 编辑态收起为当前 cron 摘要；频率和时间在专用弹框中修改。 -->
              <div v-if="isEdit" class="sf-cron-inline">
                <span>{{ t('automation.form.automation.label') }}:</span>
                <code class="sf-cron">{{ cronExpression }}</code>
                <span v-if="cronValid" class="sf-cron-desc">{{ cronSummary }}</span>
                <button
                  type="button"
                  class="sf-cron-edit"
                  :title="t('automation.list.edit.tooltip')"
                  :aria-label="t('automation.list.edit.tooltip')"
                  @click="cronEditorOpen = true"
                >
                  ✎
                </button>
              </div>

              <!-- 新建态保留高级构造器。 -->
              <div v-else class="sf-tabpane sf-advanced">
                <label class="sf-adv-row">
                  <span class="sf-adv-label">{{ t('automation.form.frequency.label') }}</span>
                  <select v-model="advFreq" class="sf-input sf-adv-control">
                    <option value="minutely">{{ t('automation.form.freq.minutely.label') }}</option>
                    <option value="hourly">{{ t('automation.form.freq.hourly.label') }}</option>
                    <option value="daily">{{ t('automation.form.freq.daily.label') }}</option>
                    <option value="weekly">{{ t('automation.form.freq.weekly.label') }}</option>
                  </select>
                </label>

                <label v-if="advFreq === 'minutely' || advFreq === 'hourly'" class="sf-adv-row">
                  <span class="sf-adv-label">{{ t('automation.form.interval.label') }}</span>
                  <input
                    v-model.number="advInterval"
                    type="number"
                    min="1"
                    :max="advFreq === 'minutely' ? 59 : 23"
                    class="sf-input sf-adv-control"
                  />
                  <span class="sf-hint">{{
                    advFreq === 'minutely'
                      ? t('automation.form.interval.minutes')
                      : t('automation.form.interval.hours')
                  }}</span>
                </label>

                <div
                  v-if="advFreq === 'hourly' || advFreq === 'daily' || advFreq === 'weekly'"
                  class="sf-adv-row"
                >
                  <span class="sf-adv-label">{{ t('automation.form.time.label') }}</span>
                  <template v-if="advFreq !== 'hourly'">
                    <input
                      v-model.number="advHour"
                      type="number"
                      min="0"
                      max="23"
                      class="sf-input sf-adv-time"
                    />
                    <span class="sf-colon">:</span>
                  </template>
                  <input
                    v-model.number="advMinute"
                    type="number"
                    min="0"
                    max="59"
                    class="sf-input sf-adv-time"
                  />
                  <span class="sf-hint">{{
                    advFreq === 'hourly'
                      ? t('automation.form.time.hourlyHint')
                      : t('automation.form.time.hint')
                  }}</span>
                </div>

                <div v-if="advFreq === 'weekly'" class="sf-adv-row">
                  <span class="sf-adv-label">{{ t('automation.form.days.label') }}</span>
                  <div class="sf-days">
                    <button
                      v-for="d in WEEKDAYS"
                      :key="d.num"
                      type="button"
                      class="sf-day"
                      :class="{ active: advDays.includes(d.num) }"
                      @click="toggleDay(d.num)"
                    >
                      {{ d.label }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Resolved cron + live preview are shown while creating. -->
              <template v-if="!isEdit">
                <div class="sf-preview-bar">
                  <code class="sf-cron" :class="{ invalid: !cronValid }">{{ cronExpression }}</code>
                  <span v-if="cronValid" class="sf-cron-desc">{{ cronSummary }}</span>
                  <span v-else class="sf-warn">{{ t('automation.form.cron.invalid') }}</span>
                </div>
                <p v-if="nextRunPreview" class="sf-nextrun">
                  {{ t('automation.form.nextRun.label') }} <strong>{{ nextRunPreview }}</strong>
                  <span class="sf-hint"> {{ t('automation.form.nextRun.utcHint') }}</span>
                </p>
              </template>
            </div>

            <!-- Event trigger config: level-1 category, then level-2 run stage. -->
            <div v-if="triggerType === 'event'" class="sf-field sf-field--stacked">
              <span class="sf-label">{{ t('automation.form.event.category.label') }}</span>
              <div class="sf-segmented" data-testid="event-category">
                <button
                  v-for="cat in EVENT_CATEGORIES"
                  :key="cat.value"
                  type="button"
                  class="sf-seg"
                  :class="{ active: eventCategory === cat.value }"
                  :data-testid="`event-category-${cat.value}`"
                  @click="selectEventCategory(cat.value)"
                >
                  {{ cat.label }}
                </button>
              </div>

              <!-- Level-2 run stage: only under the run-lifecycle category. -->
              <template v-if="eventCategory === 'run-lifecycle'">
                <span class="sf-label sf-event-reason-label">{{
                  t('automation.form.event.stage.label')
                }}</span>
                <div class="sf-segmented" data-testid="event-stage">
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: runStage === 'started' }"
                    data-testid="event-stage-started"
                    @click="selectRunStage('started')"
                  >
                    {{ t('automation.form.event.stage.started.label') }}
                  </button>
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: runStage === 'settled' }"
                    data-testid="event-stage-settled"
                    @click="selectRunStage('settled')"
                  >
                    {{ t('automation.form.event.stage.settled.label') }}
                  </button>
                </div>
              </template>

              <span class="sf-hint">{{ t('automation.form.event.hint') }}</span>

              <template v-if="showReasonFilter">
                <span class="sf-label sf-event-reason-label">{{
                  t('automation.form.event.reason.label')
                }}</span>
                <div class="sf-days">
                  <button
                    v-for="r in EVENT_REASONS"
                    :key="r.value"
                    type="button"
                    class="sf-day"
                    :class="{ active: eventReasonFilter.includes(r.value) }"
                    @click="toggleReason(r.value)"
                  >
                    {{ r.label }}
                  </button>
                </div>
                <span class="sf-hint">{{ t('automation.form.event.reason.hint') }}</span>
              </template>

              <!-- PR operation event (pr:operation): the MCP integration. Selecting
               this topic IS the explicit opt-in; the model performs PR operations
               with its own tools and only publishes the event — c3 never executes
               PR operations. -->
              <template v-if="showPrFilter">
                <p class="sf-pr-note">{{ t('automation.form.event.pr.note') }}</p>

                <span class="sf-label sf-event-reason-label">{{
                  t('automation.form.event.pr.op.label')
                }}</span>
                <div class="sf-days">
                  <button
                    v-for="op in PR_OPERATION_OPTIONS"
                    :key="op.value"
                    type="button"
                    class="sf-day"
                    :class="{ active: prOperations.includes(op.value) }"
                    @click="togglePrOperation(op.value)"
                  >
                    {{ op.label }}
                  </button>
                </div>

                <span class="sf-label sf-event-reason-label">{{
                  t('automation.form.event.pr.result.label')
                }}</span>
                <div class="sf-days">
                  <button
                    v-for="r in PR_RESULT_OPTIONS"
                    :key="r.value"
                    type="button"
                    class="sf-day"
                    :class="{ active: prResults.includes(r.value) }"
                    @click="togglePrResult(r.value)"
                  >
                    {{ r.label }}
                  </button>
                </div>
                <span class="sf-hint">{{ t('automation.form.event.pr.hint') }}</span>
              </template>

              <template v-if="showIntentFilter">
                <span class="sf-label sf-event-reason-label">{{
                  t('automation.form.event.intent.label')
                }}</span>
                <div class="sf-days">
                  <button
                    v-for="phase in INTENT_PHASE_OPTIONS"
                    :key="phase.value"
                    type="button"
                    class="sf-day"
                    :class="{ active: intentPhases.includes(phase.value) }"
                    @click="toggleIntentPhase(phase.value)"
                  >
                    {{ phase.label }}
                  </button>
                </div>
                <span class="sf-hint">{{ t('automation.form.event.intent.hint') }}</span>
              </template>

              <!-- Run-lifecycle: mandatory sessionKind multi-select (no default) + an
               optional metadata condition builder. -->
              <template v-if="showRunLifecycleFilters">
                <span class="sf-label sf-event-reason-label">{{
                  t('automation.form.event.sessionKind.label')
                }}</span>
                <div class="sf-days">
                  <button
                    v-for="sk in SESSION_KIND_OPTIONS"
                    :key="sk.value"
                    type="button"
                    class="sf-day"
                    :class="{ active: eventSessionKinds.includes(sk.value) }"
                    @click="toggleSessionKind(sk.value)"
                  >
                    {{ sk.label }}
                  </button>
                </div>
                <span v-if="!sessionKindValid" class="sf-warn">{{
                  t('automation.form.event.sessionKind.required')
                }}</span>
                <span v-else class="sf-hint">{{
                  t('automation.form.event.sessionKind.hint')
                }}</span>

                <span class="sf-label sf-event-reason-label">{{
                  t('automation.form.event.metadataFilter.label')
                }}</span>
                <div class="sf-combinator">
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: metadataCombinator === 'AND' }"
                    @click="metadataCombinator = 'AND'"
                  >
                    {{ t('automation.form.event.metadataFilter.and') }}
                  </button>
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: metadataCombinator === 'OR' }"
                    @click="metadataCombinator = 'OR'"
                  >
                    {{ t('automation.form.event.metadataFilter.or') }}
                  </button>
                </div>
                <div
                  v-for="(cond, i) in metadataConditions"
                  :key="`cond-${i}`"
                  class="sf-kv-row"
                  data-testid="metadata-condition-row"
                >
                  <input
                    v-model="cond.key"
                    class="sf-input sf-kv-input"
                    :placeholder="t('automation.form.event.metadataFilter.keyPlaceholder')"
                  />
                  <span class="sf-kv-eq">=</span>
                  <input
                    v-model="cond.value"
                    class="sf-input sf-kv-input"
                    :placeholder="t('automation.form.event.metadataFilter.valuePlaceholder')"
                  />
                  <button
                    type="button"
                    class="sf-kv-del"
                    :aria-label="t('automation.form.metadata.remove')"
                    @click="removeMetadataCondition(i)"
                  >
                    ✕
                  </button>
                </div>
                <button
                  type="button"
                  class="sf-kv-add"
                  data-testid="metadata-condition-add"
                  @click="addMetadataCondition"
                >
                  + {{ t('automation.form.event.metadataFilter.add') }}
                </button>
                <span class="sf-hint">{{ t('automation.form.event.metadataFilter.hint') }}</span>
              </template>
            </div>
          </div>
        </div>

        <!-- Section: metadata annotations (free-form key/value). Only the
             scheduler's own run for this automation carries these into its run
             events, so other automations can chain by them. -->
        <div class="sf-section" data-testid="section-metadata">
          <span class="sf-section-title">{{ t('automation.form.section.metadata') }}</span>
          <div class="sf-section-body">
            <div class="sf-field sf-field--stacked">
              <span class="sf-label">{{ t('automation.form.metadata.label') }}</span>
              <div
                v-for="(row, i) in metadataRows"
                :key="`meta-${i}`"
                class="sf-kv-row"
                data-testid="metadata-row"
              >
                <input
                  v-model="row.key"
                  class="sf-input sf-kv-input"
                  :placeholder="t('automation.form.metadata.keyPlaceholder')"
                />
                <span class="sf-kv-eq">=</span>
                <input
                  v-model="row.value"
                  class="sf-input sf-kv-input"
                  :placeholder="t('automation.form.metadata.valuePlaceholder')"
                />
                <button
                  type="button"
                  class="sf-kv-del"
                  :aria-label="t('automation.form.metadata.remove')"
                  @click="removeMetadataRow(i)"
                >
                  ✕
                </button>
              </div>
              <button
                type="button"
                class="sf-kv-add"
                data-testid="metadata-add"
                @click="addMetadataRow"
              >
                + {{ t('automation.form.metadata.add') }}
              </button>
              <span class="sf-hint">{{ t('automation.form.metadata.hint') }}</span>
            </div>
          </div>
        </div>

        <!-- Section: execution identity & permissions -->
        <div class="sf-section" data-testid="section-execution">
          <span class="sf-section-title">{{ t('automation.form.section.execution') }}</span>
          <div class="sf-section-body">
            <!-- Vendor selector -->
            <div class="sf-field sf-vendor-agent">
              <span class="sf-label">{{ t('automation.form.vendor.label') }}</span>
              <select v-model="vendor" class="sf-input sf-select">
                <option v-for="v in VENDOR_ORDER" :key="v" :value="v" :disabled="!vendorPresent(v)">
                  {{ VENDOR_LABEL[v] }}
                </option>
              </select>
              <template v-if="type === 'llm'">
                <span class="sf-label sf-agent-label">{{ t('automation.form.agent.label') }}</span>
                <select v-model="agentId" class="sf-input sf-select sf-agent-select">
                  <option disabled value="">{{ t('automation.form.agent.placeholder') }}</option>
                  <option v-for="agent in vendorAgents" :key="agent.id" :value="agent.id">
                    {{ agent.displayName }}
                  </option>
                </select>
              </template>
            </div>

            <!-- Permission mode: controls differ by vendor -->
            <div class="sf-field" :class="{ 'sf-field--stacked': vendor === 'codex' }">
              <span class="sf-label">{{ t('automation.form.permissionMode.label') }}</span>

              <!-- Claude: dropdown -->
              <select v-if="vendor === 'claude'" v-model="claudeMode" class="sf-input sf-select">
                <option value="default">
                  {{ t('automation.form.permissionMode.claude.default') }}
                </option>
                <option value="auto">{{ t('automation.form.permissionMode.claude.auto') }}</option>
                <option value="plan">{{ t('automation.form.permissionMode.claude.plan') }}</option>
                <option value="acceptEdits">
                  {{ t('automation.form.permissionMode.claude.acceptEdits') }}
                </option>
                <option value="bypassPermissions">
                  {{ t('automation.form.permissionMode.claude.bypassPermissions') }}
                </option>
              </select>

              <!-- Codex: two segmented controls -->
              <template v-else-if="vendor === 'codex'">
                <span class="sf-label sf-permission-sub">{{
                  t('automation.form.permissionMode.codex.sandboxModeLabel')
                }}</span>
                <div class="sf-segmented">
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: codexSandboxMode === 'workspace-write' }"
                    @click="codexSandboxMode = 'workspace-write'"
                  >
                    {{ t('automation.form.permissionMode.codex.sandboxReadWrite') }}
                  </button>
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: codexSandboxMode === 'read-only' }"
                    @click="codexSandboxMode = 'read-only'"
                  >
                    {{ t('automation.form.permissionMode.codex.sandboxReadOnly') }}
                  </button>
                </div>
                <span class="sf-label sf-permission-sub">{{
                  t('automation.form.permissionMode.codex.approvalLabel')
                }}</span>
                <div class="sf-segmented">
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: codexApprovalPolicy === 'on-request' }"
                    @click="codexApprovalPolicy = 'on-request'"
                  >
                    {{ t('automation.form.permissionMode.codex.approvalOnRequest') }}
                  </button>
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: codexApprovalPolicy === 'on-failure' }"
                    @click="codexApprovalPolicy = 'on-failure'"
                  >
                    {{ t('automation.form.permissionMode.codex.approvalOnFailure') }}
                  </button>
                  <button
                    type="button"
                    class="sf-seg"
                    :class="{ active: codexApprovalPolicy === 'never' }"
                    @click="codexApprovalPolicy = 'never'"
                  >
                    {{ t('automation.form.permissionMode.codex.approvalNever') }}
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- Section: tool permissions -->
        <div class="sf-section" data-testid="section-tools">
          <span class="sf-section-title">{{ t('automation.form.section.tools') }}</span>
          <div class="sf-section-body">
            <!-- Tool checklist -->
            <div class="sf-field sf-field--stacked sf-field--tools">
              <div class="sf-tools-labelrow">
                <span class="sf-label">{{ t('automation.form.tools.label') }}</span>
                <!-- Select/clear stay on the label row for quick access. -->
                <div v-if="currentTools.length" class="sf-tools-actions">
                  <button type="button" class="sf-tools-btn" @click="selectAll">
                    {{ t('automation.form.tools.selectAll.label') }}
                  </button>
                  <button type="button" class="sf-tools-btn" @click="clearAll">
                    {{ t('automation.form.tools.clearAll.label') }}
                  </button>
                </div>
              </div>

              <!-- Loading -->
              <span v-if="props.toolManifestLoading" class="sf-hint">{{
                t('automation.form.tools.loading')
              }}</span>

              <!-- Error -->
              <span v-else-if="props.toolManifestError" class="sf-warn">{{
                props.toolManifestError
              }}</span>

              <!-- The list grows with its content; the form body owns the only vertical
               scroll area in this dialog. -->
              <div v-else-if="currentTools.length" class="sf-tools-scroll">
                <!-- Read-only tools -->
                <div class="sf-tools-group">
                  <span class="sf-tools-subtitle">{{
                    t('automation.form.tools.readOnly.label')
                  }}</span>
                  <div class="sf-tools-grid">
                    <label v-for="_t in readTools" :key="_t.name" class="sf-tool-item">
                      <input
                        type="checkbox"
                        :checked="toolChecked(_t.name)"
                        @change="toggleTool(_t.name)"
                      />
                      <span class="sf-tool-name">{{ _t.name }}</span>
                    </label>
                  </div>
                </div>

                <!-- Write tools -->
                <div class="sf-tools-group">
                  <span class="sf-tools-subtitle">{{
                    t('automation.form.tools.write.label')
                  }}</span>
                  <div class="sf-tools-grid">
                    <label v-for="_t in writeTools" :key="_t.name" class="sf-tool-item">
                      <input
                        type="checkbox"
                        :checked="toolChecked(_t.name)"
                        @change="toggleTool(_t.name)"
                      />
                      <span class="sf-tool-name">{{ _t.name }}</span>
                    </label>
                  </div>
                </div>
              </div>

              <!-- Empty (no tools returned) -->
              <span v-else class="sf-hint">{{ t('automation.form.tools.empty') }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="sf-foot">
        <button class="sf-btn ghost" @click="emit('close')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button class="sf-btn primary" :disabled="!canSave" @click="save">
          {{ isEdit ? t('automation.form.saveChanges.label') : t('automation.form.create.label') }}
        </button>
      </div>
    </div>
  </div>
  <AutomationCronEditor
    :open="cronEditorOpen"
    :automation="automation"
    :cron-expression="cronExpression"
    @close="cronEditorOpen = false"
    @save="updateCronDraft"
  />
</template>

<style scoped>
.sf-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 与其它全屏 sheet 一致(>底部导航 z-index:90),否则移动端底栏会盖住页脚/末项字段 */
  z-index: 200;
  padding: var(--sp-4);
}
.sf-modal {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  width: min(1080px, 100%);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  color: var(--c-text);
  overflow: hidden;
}
.sf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
}
.sf-head h2 {
  font-size: var(--fs-title);
  font-weight: 600;
  margin: 0;
}
.sf-icon-btn {
  background: transparent;
  border: none;
  color: var(--c-text-muted);
  font-size: var(--fs-body);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}
.sf-icon-btn:hover {
  background: var(--c-hover);
  color: var(--c-text);
}
.sf-body {
  padding: var(--sp-4);
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
/* Visual grouping only — sections never own a scroll area (the body does) and
   never collapse; they just card-wrap related fields. */
.sf-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  padding: var(--sp-3);
}
.sf-section-title {
  font-size: var(--fs-caption);
  font-weight: 700;
  color: var(--c-text);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.sf-section-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.sf-field {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}
.sf-field--stacked {
  flex-direction: column;
  align-items: stretch;
}
/* 工具字段用普通块流而非 flex 列:嵌套的 auto-fit grid 在 flex 列做固有高度
   测量时会坍缩成单列、把 flex 子项撑到超高(内容之下留大片空白),块流按真实
   可用宽度测量,区块高度贴合内容。间距由块流 margin 补(flex gap 不生效)。 */
.sf-field--tools {
  display: block;
}
.sf-field--tools > * + * {
  margin-top: var(--sp-2);
}
.sf-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.sf-input,
.sf-textarea {
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text);
  font-size: var(--fs-body);
  padding: var(--sp-2);
  font-family: inherit;
  width: 100%;
}
.sf-input:focus,
.sf-textarea:focus {
  outline: none;
  border-color: var(--c-primary);
}
.sf-textarea {
  resize: vertical;
}
.sf-mono {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
}
/* Inline fields: override .sf-input width:100% so control sits beside label */
.sf-field:not(.sf-field--stacked) > input.sf-input,
.sf-field:not(.sf-field--stacked) > select.sf-input {
  width: auto;
  flex: 1 1 120px;
  min-width: 0;
}
.sf-field:not(.sf-field--stacked) > select.sf-input {
  flex: 0 0 auto;
}
.sf-vendor-agent .sf-agent-label {
  margin-left: var(--sp-2);
}
.sf-hint {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sf-warn {
  font-size: var(--fs-caption);
  color: var(--c-warning);
  margin: var(--sp-1) 0 0;
}

/* Segmented control (task type, execution identity) */
.sf-segmented {
  display: flex;
  gap: var(--sp-1);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px;
}
.sf-seg {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sf-seg:hover:not(:disabled) {
  color: var(--c-text);
}
.sf-seg.active {
  background: var(--c-primary);
  color: #fff;
}
.sf-seg:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.sf-tabpane {
  margin-top: var(--sp-2);
}
.sf-field--stacked .sf-tabpane {
  margin-top: 0;
}

/* Event reason filter and permission mode sub-label spacing. */
.sf-field--stacked .sf-event-reason-label,
.sf-field--stacked .sf-permission-sub {
  margin-top: 0;
}

/* Advanced */
.sf-advanced {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sf-adv-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sf-adv-label {
  width: 90px;
  flex-shrink: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sf-adv-control {
  max-width: 220px;
}
.sf-adv-time {
  width: 64px;
}
.sf-colon {
  color: var(--c-text-muted);
}
.sf-days {
  display: flex;
  gap: var(--sp-1);
  flex-wrap: wrap;
}
.sf-day {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 4px 8px;
  cursor: pointer;
}
.sf-day.active {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: #fff;
}

/* Preview bar */
.sf-preview-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  margin-top: var(--sp-3);
}
.sf-cron-inline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  color: var(--c-text-muted);
}
.sf-cron-edit {
  border: 0;
  padding: 0 4px;
  background: transparent;
  color: var(--c-text-muted);
  cursor: pointer;
  font-size: var(--fs-body);
}
.sf-cron-edit:hover {
  color: var(--c-text);
}
.sf-field--stacked .sf-preview-bar {
  margin-top: 0;
}
.sf-cron {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  background: var(--c-hover);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}
.sf-cron.invalid {
  color: var(--c-error);
}
.sf-cron-desc {
  font-size: var(--fs-caption);
  color: var(--c-text);
}
.sf-nextrun {
  font-size: var(--fs-caption);
  color: var(--c-text);
  margin: var(--sp-2) 0 0;
}
.sf-pr-note {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  margin: 0;
}

/* Key/value row builder (metadata annotations + metadata condition filter). */
.sf-kv-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sf-kv-input {
  flex: 1 1 0;
  min-width: 0;
}
.sf-kv-eq {
  color: var(--c-text-muted);
  flex-shrink: 0;
}
.sf-kv-del {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  cursor: pointer;
  padding: 4px 8px;
}
.sf-kv-del:hover {
  color: var(--c-error);
  border-color: var(--c-error);
}
.sf-kv-add {
  align-self: flex-start;
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 4px 10px;
  cursor: pointer;
}
.sf-kv-add:hover {
  color: var(--c-text);
  background: var(--c-hover);
}
.sf-combinator {
  display: flex;
  gap: var(--sp-1);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px;
  max-width: 200px;
}

/* Tool checklist */
.sf-select {
  max-width: 280px;
}
.sf-tools-labelrow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.sf-tools-actions {
  display: flex;
  gap: var(--sp-2);
  margin-left: auto;
}
/* Keep the tool list in the form's single scroll area. */
.sf-tools-scroll {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sf-tools-btn {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 3px 10px;
  cursor: pointer;
}
.sf-tools-btn:hover {
  color: var(--c-text);
  background: var(--c-hover);
}
.sf-tools-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sf-tools-subtitle {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
/* auto-fit（非 auto-fill）折叠空轨道：工具少时铺满整行不留右侧空白，工具多时
   自然多列换行，高度只随实际行数增长。 */
.sf-tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--sp-1);
}
.sf-tool-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.sf-tool-item:hover {
  background: var(--c-hover);
}
.sf-tool-item input[type='checkbox'] {
  margin: 0;
}
.sf-tool-name {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  color: var(--c-text);
}

.sf-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--c-border);
}
.sf-btn {
  font-size: var(--fs-body);
  padding: 6px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  border: 1px solid var(--c-border);
}
.sf-btn.ghost {
  background: transparent;
  color: var(--c-text-muted);
}
.sf-btn.ghost:hover {
  color: var(--c-text);
  background: var(--c-hover);
}
.sf-btn.primary {
  background: var(--c-primary);
  border-color: var(--c-primary);
  color: #fff;
}
.sf-btn.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 767px) {
  .sf-overlay {
    align-items: stretch;
    justify-content: stretch;
    padding: 0;
    background: var(--c-panel);
  }

  .sf-modal {
    width: 100vw;
    max-width: none;
    height: 100dvh;
    max-height: none;
    border: 0;
    border-radius: 0;
  }

  .sf-head {
    flex-shrink: 0;
    padding: calc(var(--sp-3) + env(safe-area-inset-top)) var(--sp-4) var(--sp-3);
  }

  .sf-body {
    flex: 1 1 auto;
    min-height: 0;
    padding: var(--sp-4);
  }

  .sf-field,
  .sf-adv-row,
  .sf-cron-inline {
    flex-direction: column;
    align-items: stretch;
  }

  .sf-field:not(.sf-field--stacked) > input.sf-input,
  .sf-field:not(.sf-field--stacked) > select.sf-input,
  .sf-field:not(.sf-field--stacked) > select.sf-select {
    width: 100%;
    max-width: none;
    flex: 1 1 auto;
  }

  .sf-adv-label {
    width: auto;
  }

  .sf-vendor-agent .sf-agent-label {
    margin-left: 0;
  }

  .sf-adv-control,
  .sf-select {
    max-width: none;
  }

  .sf-adv-time {
    width: 100%;
  }

  .sf-colon {
    display: none;
  }

  .sf-tools-labelrow,
  .sf-tools-actions {
    align-items: stretch;
  }

  .sf-tools-actions {
    width: 100%;
    margin-left: 0;
  }

  .sf-tools-btn {
    flex: 1;
  }

  .sf-tools-grid {
    grid-template-columns: 1fr;
  }

  .sf-foot {
    flex-shrink: 0;
    padding: var(--sp-3) var(--sp-4) calc(var(--sp-3) + env(safe-area-inset-bottom));
  }

  .sf-btn {
    flex: 1;
  }
}
</style>
