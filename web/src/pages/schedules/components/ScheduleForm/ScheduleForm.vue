<script setup lang="ts">
/**
 * ScheduleForm.vue — modal for creating and editing a schedule.
 *
 * One component serves both flows: `schedule === null` is a create, otherwise an
 * edit (type is immutable on edit, per the protocol). The cron expression is
 * built with an Advanced segmented builder (frequency / interval / time / days)
 * that feeds a single `cronExpression`, with a live "next run" preview computed
 * by the same `computeNextRunAt` the server uses.
 *
 * The schedule's display name is auto-generated server-side from the task
 * content on create — the create flow does not collect a name. On EDIT the form
 * exposes a Title input prefilled with the current name: saving a non-empty
 * value sets a sticky manual title; clearing it reverts to auto-naming.
 *
 * Cron fields are interpreted in the system `timezone` (the `timezone` prop,
 * sourced from the server settings); the preview passes it to `computeNextRunAt`
 * so the previewed instant matches the one the server will schedule.
 */
import { ref, computed, watch } from 'vue'
import type {
  Schedule,
  ScheduleType,
  ScheduleTriggerType,
  RunLifecycleTopic,
  RunEndReason,
  McpMode,
  CreateScheduleInput,
  UpdateScheduleInput,
} from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron, describeCron } from '@ccc/shared/cron'
import { useTypedI18n } from '@/i18n'

// `d` 别名为 `fmtDateTime`:模板里 `v-for="d in WEEKDAYS"` 已占用 `d`,避免 shadow。
const { t, d: fmtDateTime } = useTypedI18n()

const props = defineProps<{
  open: boolean
  /** Non-null = edit an existing schedule; null = create a new one. */
  schedule: Schedule | null
  /** Owning workspace for new schedules. */
  workspacePath: string
  /** System IANA time zone the cron next-run preview is computed in. */
  timezone: string
}>()

const emit = defineEmits<{
  close: []
  create: [input: CreateScheduleInput]
  update: [id: string, input: UpdateScheduleInput]
}>()

const isEdit = computed(() => props.schedule !== null)

const MCP_MODES = computed<{ value: McpMode; label: string; hint: string }[]>(() => [
  {
    value: 'read-only',
    label: t('schedule.form.mcpMode.readOnly.label'),
    hint: t('schedule.form.mcpMode.readOnly.hint'),
  },
  {
    value: 'sandboxed',
    label: t('schedule.form.mcpMode.sandboxed.label'),
    hint: t('schedule.form.mcpMode.sandboxed.hint'),
  },
  {
    value: 'full-access',
    label: t('schedule.form.mcpMode.fullAccess.label'),
    hint: t('schedule.form.mcpMode.fullAccess.hint'),
  },
])

const WEEKDAYS = computed<{ num: number; label: string }[]>(() => [
  { num: 0, label: t('schedule.form.weekday.sun') },
  { num: 1, label: t('schedule.form.weekday.mon') },
  { num: 2, label: t('schedule.form.weekday.tue') },
  { num: 3, label: t('schedule.form.weekday.wed') },
  { num: 4, label: t('schedule.form.weekday.thu') },
  { num: 5, label: t('schedule.form.weekday.fri') },
  { num: 6, label: t('schedule.form.weekday.sat') },
])

const TRIGGER_TYPES = computed<{ value: ScheduleTriggerType; label: string }[]>(() => [
  { value: 'cron', label: t('schedule.form.trigger.cron.label') },
  { value: 'event', label: t('schedule.form.trigger.event.label') },
])

const EVENT_TOPICS = computed<{ value: RunLifecycleTopic; label: string }[]>(() => [
  { value: 'run:started', label: t('schedule.form.event.topic.started.label') },
  { value: 'run:settled', label: t('schedule.form.event.topic.settled.label') },
])

const EVENT_REASONS = computed<{ value: RunEndReason; label: string }[]>(() => [
  { value: 'complete', label: t('schedule.form.event.reason.complete.label') },
  { value: 'error', label: t('schedule.form.event.reason.error.label') },
  { value: 'aborted', label: t('schedule.form.event.reason.aborted.label') },
])

// ---- Form draft ----------------------------------------------------------
const type = ref<ScheduleType>('command')
// Manual display title — edit-only. Prefilled from the current name; an empty
// value on save tells the server to revert to auto-naming.
const title = ref('')
const mcpMode = ref<McpMode>('sandboxed')
const command = ref('')
const prompt = ref('')
const cronExpression = ref('*/30 * * * *')
const triggerType = ref<ScheduleTriggerType>('cron')
const eventTopic = ref<RunLifecycleTopic>('run:settled')
const eventReasonFilter = ref<RunEndReason[]>([])

// The reason filter only applies to run:settled (run:started has no outcome).
const showReasonFilter = computed(
  () => triggerType.value === 'event' && eventTopic.value === 'run:settled',
)

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

// Re-seed the draft whenever the modal opens (or the target schedule changes).
watch(
  () => [props.open, props.schedule] as const,
  ([open, sched]) => {
    if (!open) return
    if (sched) {
      type.value = sched.type
      title.value = readConfigField(sched.config, 'name')
      mcpMode.value = sched.mcpMode
      cronExpression.value = sched.cronExpression || '*/30 * * * *'
      command.value = readConfigField(sched.config, 'command')
      prompt.value = readConfigField(sched.config, 'prompt')
      triggerType.value = sched.triggerType
      eventTopic.value = sched.eventTopic ?? 'run:settled'
      eventReasonFilter.value = sched.eventReasonFilter ? [...sched.eventReasonFilter] : []
    } else {
      type.value = 'command'
      title.value = ''
      mcpMode.value = 'sandboxed'
      cronExpression.value = '*/30 * * * *'
      command.value = ''
      prompt.value = ''
      triggerType.value = 'cron'
      eventTopic.value = 'run:settled'
      eventReasonFilter.value = []
    }
  },
  { immediate: true },
)

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
const canSave = computed(() => taskFilled.value && triggerValid.value)

function toggleReason(r: RunEndReason): void {
  const i = eventReasonFilter.value.indexOf(r)
  if (i >= 0) eventReasonFilter.value.splice(i, 1)
  else eventReasonFilter.value.push(r)
}

function buildConfig(): Record<string, unknown> {
  // Name is auto-generated server-side; the form supplies only the task body.
  const base: Record<string, unknown> = {}
  if (type.value === 'command') base.command = command.value.trim()
  else base.prompt = prompt.value
  return base
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
  if (isEdit.value && props.schedule) {
    // Carry the manual title: a non-empty value is stored sticky server-side; an
    // empty value reverts to auto-naming. Create never sends a name (auto only).
    config.name = title.value.trim()
    const input: UpdateScheduleInput = {
      config,
      mcpMode: mcpMode.value,
      triggerType: triggerType.value,
    }
    // The store clears the other trigger's fields on a triggerType switch, so we
    // only send the fields matching the chosen type (avoids a double column set).
    if (isEvent) {
      input.eventTopic = eventTopic.value
      input.eventReasonFilter = reasonFilter
    } else {
      input.cronExpression = cronExpression.value
    }
    emit('update', props.schedule.id, input)
  } else {
    emit('create', {
      type: type.value,
      config,
      workspacePath: props.workspacePath,
      mcpMode: mcpMode.value,
      triggerType: triggerType.value,
      cronExpression: isEvent ? '' : cronExpression.value,
      eventTopic: isEvent ? eventTopic.value : null,
      eventReasonFilter: reasonFilter,
    })
  }
  emit('close')
}
</script>

<template>
  <div v-if="open" class="sf-overlay" @click.self="emit('close')">
    <div class="sf-modal" role="dialog" aria-modal="true">
      <div class="sf-head">
        <h2>{{ isEdit ? t('schedule.form.editTitle') : t('schedule.form.newTitle') }}</h2>
        <button
          class="sf-icon-btn"
          :title="t('common.action.close.tooltip')"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="sf-body">
        <!-- Title (edit only): auto-named on create, manually editable here. -->
        <label v-if="isEdit" class="sf-field">
          <span class="sf-label">{{ t('schedule.form.title.label') }}</span>
          <input
            v-model="title"
            class="sf-input"
            :placeholder="t('schedule.form.title.placeholder')"
          />
          <span class="sf-hint">{{ t('schedule.form.title.hint') }}</span>
        </label>

        <div class="sf-field">
          <span class="sf-label">{{ t('schedule.form.taskType.label') }}</span>
          <div class="sf-segmented">
            <button
              type="button"
              class="sf-seg"
              :class="{ active: type === 'command' }"
              :disabled="isEdit"
              @click="type = 'command'"
            >
              {{ t('schedule.form.type.command.label') }}
            </button>
            <button
              type="button"
              class="sf-seg"
              :class="{ active: type === 'llm' }"
              :disabled="isEdit"
              @click="type = 'llm'"
            >
              {{ t('schedule.form.type.llm.label') }}
            </button>
          </div>
          <span v-if="isEdit" class="sf-hint">{{ t('schedule.form.taskType.locked') }}</span>
        </div>

        <!-- Command body -->
        <label v-if="type === 'command'" class="sf-field">
          <span class="sf-label">{{ t('schedule.form.command.label') }}</span>
          <textarea
            v-model="command"
            class="sf-textarea sf-mono"
            rows="2"
            :placeholder="t('schedule.form.command.placeholder')"
          />
        </label>

        <!-- LLM prompt -->
        <label v-else class="sf-field">
          <span class="sf-label">{{ t('schedule.form.prompt.label') }}</span>
          <textarea
            v-model="prompt"
            class="sf-textarea"
            rows="6"
            :placeholder="t('schedule.form.prompt.placeholder')"
          />
        </label>

        <!-- Trigger type: a cron schedule vs a run lifecycle event -->
        <div class="sf-field">
          <span class="sf-label">{{ t('schedule.form.trigger.label') }}</span>
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

        <!-- Schedule (cron) builder -->
        <div v-if="triggerType === 'cron'" class="sf-field">
          <span class="sf-label">{{ t('schedule.form.schedule.label') }}</span>

          <!-- Advanced segmented builder -->
          <div class="sf-tabpane sf-advanced">
            <label class="sf-adv-row">
              <span class="sf-adv-label">{{ t('schedule.form.frequency.label') }}</span>
              <select v-model="advFreq" class="sf-input sf-adv-control">
                <option value="minutely">{{ t('schedule.form.freq.minutely.label') }}</option>
                <option value="hourly">{{ t('schedule.form.freq.hourly.label') }}</option>
                <option value="daily">{{ t('schedule.form.freq.daily.label') }}</option>
                <option value="weekly">{{ t('schedule.form.freq.weekly.label') }}</option>
              </select>
            </label>

            <label v-if="advFreq === 'minutely' || advFreq === 'hourly'" class="sf-adv-row">
              <span class="sf-adv-label">{{ t('schedule.form.interval.label') }}</span>
              <input
                v-model.number="advInterval"
                type="number"
                min="1"
                :max="advFreq === 'minutely' ? 59 : 23"
                class="sf-input sf-adv-control"
              />
              <span class="sf-hint">{{
                advFreq === 'minutely'
                  ? t('schedule.form.interval.minutes')
                  : t('schedule.form.interval.hours')
              }}</span>
            </label>

            <div
              v-if="advFreq === 'hourly' || advFreq === 'daily' || advFreq === 'weekly'"
              class="sf-adv-row"
            >
              <span class="sf-adv-label">{{ t('schedule.form.time.label') }}</span>
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
                  ? t('schedule.form.time.hourlyHint')
                  : t('schedule.form.time.hint')
              }}</span>
            </div>

            <div v-if="advFreq === 'weekly'" class="sf-adv-row">
              <span class="sf-adv-label">{{ t('schedule.form.days.label') }}</span>
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

          <!-- Resolved cron + live preview (shared across all tabs) -->
          <div class="sf-preview-bar">
            <code class="sf-cron" :class="{ invalid: !cronValid }">{{ cronExpression }}</code>
            <span v-if="cronValid" class="sf-cron-desc">{{ cronSummary }}</span>
            <span v-else class="sf-warn">{{ t('schedule.form.cron.invalid') }}</span>
          </div>
          <p v-if="nextRunPreview" class="sf-nextrun">
            {{ t('schedule.form.nextRun.label') }} <strong>{{ nextRunPreview }}</strong>
            <span class="sf-hint"> {{ t('schedule.form.nextRun.utcHint') }}</span>
          </p>
        </div>

        <!-- Event trigger config -->
        <div v-if="triggerType === 'event'" class="sf-field">
          <span class="sf-label">{{ t('schedule.form.event.topic.label') }}</span>
          <div class="sf-segmented">
            <button
              v-for="ev in EVENT_TOPICS"
              :key="ev.value"
              type="button"
              class="sf-seg"
              :class="{ active: eventTopic === ev.value }"
              @click="eventTopic = ev.value"
            >
              {{ ev.label }}
            </button>
          </div>
          <span class="sf-hint">{{ t('schedule.form.event.hint') }}</span>

          <template v-if="showReasonFilter">
            <span class="sf-label sf-event-reason-label">{{
              t('schedule.form.event.reason.label')
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
            <span class="sf-hint">{{ t('schedule.form.event.reason.hint') }}</span>
          </template>
        </div>

        <!-- Execution identity -->
        <div class="sf-field">
          <span class="sf-label">{{ t('schedule.form.execIdentity.label') }}</span>
          <div class="sf-segmented">
            <button
              v-for="m in MCP_MODES"
              :key="m.value"
              type="button"
              class="sf-seg"
              :class="{ active: mcpMode === m.value }"
              @click="mcpMode = m.value"
            >
              {{ m.label }}
            </button>
          </div>
          <span class="sf-hint">{{ MCP_MODES.find((m) => m.value === mcpMode)?.hint }}</span>
        </div>
      </div>

      <div class="sf-foot">
        <button class="sf-btn ghost" @click="emit('close')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button class="sf-btn primary" :disabled="!canSave" @click="save">
          {{ isEdit ? t('schedule.form.saveChanges.label') : t('schedule.form.create.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sf-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: var(--sp-4);
}
.sf-modal {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  width: min(720px, 100%);
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
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.sf-field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
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

/* Event reason filter sub-label spacing within the event field. */
.sf-event-reason-label {
  margin-top: var(--sp-2);
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
</style>
