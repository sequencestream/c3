<script setup lang="ts">
/**
 * ScheduleForm.vue — modal for creating and editing a schedule.
 *
 * One component serves both flows: `schedule === null` is a create, otherwise an
 * edit (type is immutable on edit, per the protocol). The cron expression can be
 * built three ways — a natural-language box, one-click presets, or an Advanced
 * segmented builder — all of which feed a single `cronExpression`, with a live
 * "next run" preview computed by the same `computeNextRunAt` the server uses.
 *
 * The schedule's display name is auto-generated server-side from the task
 * content on create — the form does not collect a name or description.
 *
 * Schedule times are interpreted as server (UTC) time — there is no per-schedule
 * timezone.
 */
import { ref, computed, watch } from 'vue'
import type {
  Schedule,
  ScheduleType,
  McpMode,
  CreateScheduleInput,
  UpdateScheduleInput,
} from '@ccc/shared/protocol'
import { computeNextRunAt, isValidCron, describeCron } from '@ccc/shared/cron'
import { nlToCron, CRON_PRESETS } from '@ccc/shared/nl-cron'
import MarkdownText from './MarkdownText.vue'

const props = defineProps<{
  open: boolean
  /** Non-null = edit an existing schedule; null = create a new one. */
  schedule: Schedule | null
  /** Owning workspace for new schedules. */
  workspacePath: string
}>()

const emit = defineEmits<{
  close: []
  create: [input: CreateScheduleInput]
  update: [id: string, input: UpdateScheduleInput]
}>()

const isEdit = computed(() => props.schedule !== null)

const MCP_MODES: { value: McpMode; label: string; hint: string }[] = [
  { value: 'read-only', label: 'Read-only', hint: 'Tools that only read; writes are blocked.' },
  { value: 'sandboxed', label: 'Sandboxed', hint: 'Writes allowed, but queued for approval.' },
  { value: 'full-access', label: 'Full access', hint: 'No restrictions — use with care.' },
]

const WEEKDAYS = [
  { num: 0, label: 'Sun' },
  { num: 1, label: 'Mon' },
  { num: 2, label: 'Tue' },
  { num: 3, label: 'Wed' },
  { num: 4, label: 'Thu' },
  { num: 5, label: 'Fri' },
  { num: 6, label: 'Sat' },
]

// ---- Form draft ----------------------------------------------------------
const type = ref<ScheduleType>('command')
const mcpMode = ref<McpMode>('sandboxed')
const command = ref('')
const prompt = ref('')
const cronExpression = ref('*/30 * * * *')

// Cron builder mode.
type CronTab = 'nl' | 'presets' | 'advanced'
const cronTab = ref<CronTab>('nl')
const nlText = ref('')

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
      mcpMode.value = sched.mcpMode
      cronExpression.value = sched.cronExpression
      command.value = readConfigField(sched.config, 'command')
      prompt.value = readConfigField(sched.config, 'prompt')
      cronTab.value = 'advanced'
    } else {
      type.value = 'command'
      mcpMode.value = 'sandboxed'
      cronExpression.value = '*/30 * * * *'
      command.value = ''
      prompt.value = ''
      cronTab.value = 'nl'
      nlText.value = ''
    }
  },
  { immediate: true },
)

// ---- Natural-language mode ----------------------------------------------
const nlParsed = computed(() => (nlText.value.trim() ? nlToCron(nlText.value) : null))
watch(nlParsed, (cron) => {
  if (cronTab.value === 'nl' && cron) cronExpression.value = cron
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
  if (cronTab.value === 'advanced') cronExpression.value = cron
})

function toggleDay(num: number): void {
  const i = advDays.value.indexOf(num)
  if (i >= 0) advDays.value.splice(i, 1)
  else advDays.value.push(num)
}

function selectTab(tab: CronTab): void {
  cronTab.value = tab
  if (tab === 'advanced') cronExpression.value = advancedCron.value
  else if (tab === 'nl' && nlParsed.value) cronExpression.value = nlParsed.value
}

function applyPreset(cron: string): void {
  cronExpression.value = cron
}

// ---- Live preview --------------------------------------------------------
const cronValid = computed(() => isValidCron(cronExpression.value))
const cronSummary = computed(() => (cronValid.value ? describeCron(cronExpression.value) : ''))
const nextRunPreview = computed(() => {
  if (!cronValid.value) return null
  try {
    return new Date(computeNextRunAt(cronExpression.value, Date.now())).toLocaleString()
  } catch {
    return null
  }
})

// ---- Save ----------------------------------------------------------------
const taskFilled = computed(() =>
  type.value === 'command' ? command.value.trim().length > 0 : prompt.value.trim().length > 0,
)
const canSave = computed(() => taskFilled.value && cronValid.value)

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
  if (isEdit.value && props.schedule) {
    emit('update', props.schedule.id, {
      config,
      cronExpression: cronExpression.value,
      mcpMode: mcpMode.value,
    })
  } else {
    emit('create', {
      type: type.value,
      config,
      workspacePath: props.workspacePath,
      cronExpression: cronExpression.value,
      mcpMode: mcpMode.value,
    })
  }
  emit('close')
}
</script>

<template>
  <div v-if="open" class="sf-overlay" @click.self="emit('close')">
    <div class="sf-modal" role="dialog" aria-modal="true">
      <div class="sf-head">
        <h2>{{ isEdit ? 'Edit Schedule' : 'New Schedule' }}</h2>
        <button class="sf-icon-btn" title="Close" @click="emit('close')">✕</button>
      </div>

      <div class="sf-body">
        <div class="sf-field">
          <span class="sf-label">Task type</span>
          <div class="sf-segmented">
            <button
              type="button"
              class="sf-seg"
              :class="{ active: type === 'command' }"
              :disabled="isEdit"
              @click="type = 'command'"
            >
              Command
            </button>
            <button
              type="button"
              class="sf-seg"
              :class="{ active: type === 'llm' }"
              :disabled="isEdit"
              @click="type = 'llm'"
            >
              LLM prompt
            </button>
          </div>
          <span v-if="isEdit" class="sf-hint">Task type cannot be changed after creation.</span>
        </div>

        <!-- Command body -->
        <label v-if="type === 'command'" class="sf-field">
          <span class="sf-label">Command</span>
          <textarea
            v-model="command"
            class="sf-textarea sf-mono"
            rows="2"
            placeholder="pnpm build && pnpm test"
          />
        </label>

        <!-- LLM prompt with live markdown preview -->
        <div v-else class="sf-field">
          <span class="sf-label">Prompt</span>
          <div class="sf-prompt-grid">
            <textarea
              v-model="prompt"
              class="sf-textarea"
              rows="6"
              placeholder="Run a security audit and summarize findings…"
            />
            <div class="sf-prompt-preview">
              <span class="sf-preview-tag">Preview</span>
              <MarkdownText v-if="prompt.trim()" :text="prompt" kind="assistant" />
              <p v-else class="sf-preview-empty">Markdown preview appears here.</p>
            </div>
          </div>
        </div>

        <!-- Schedule (cron) builder -->
        <div class="sf-field">
          <span class="sf-label">Schedule</span>
          <div class="sf-tabs">
            <button
              type="button"
              class="sf-tab"
              :class="{ active: cronTab === 'nl' }"
              @click="selectTab('nl')"
            >
              Natural language
            </button>
            <button
              type="button"
              class="sf-tab"
              :class="{ active: cronTab === 'presets' }"
              @click="selectTab('presets')"
            >
              Presets
            </button>
            <button
              type="button"
              class="sf-tab"
              :class="{ active: cronTab === 'advanced' }"
              @click="selectTab('advanced')"
            >
              Advanced
            </button>
          </div>

          <!-- NL -->
          <div v-if="cronTab === 'nl'" class="sf-tabpane">
            <input
              v-model="nlText"
              class="sf-input"
              placeholder="e.g. weekdays at 8am, every 30 minutes, every Monday at 3am"
            />
            <p v-if="nlText.trim() && !nlParsed" class="sf-warn">
              Couldn't understand that phrasing — try a preset or the Advanced builder.
            </p>
          </div>

          <!-- Presets -->
          <div v-else-if="cronTab === 'presets'" class="sf-tabpane sf-presets">
            <button
              v-for="p in CRON_PRESETS"
              :key="p.cron"
              type="button"
              class="sf-preset-card"
              :class="{ active: cronExpression === p.cron }"
              @click="applyPreset(p.cron)"
            >
              {{ p.label }}
            </button>
          </div>

          <!-- Advanced segmented builder -->
          <div v-else class="sf-tabpane sf-advanced">
            <label class="sf-adv-row">
              <span class="sf-adv-label">Frequency</span>
              <select v-model="advFreq" class="sf-input sf-adv-control">
                <option value="minutely">Every N minutes</option>
                <option value="hourly">Every N hours</option>
                <option value="daily">Every day</option>
                <option value="weekly">Weekly (pick days)</option>
              </select>
            </label>

            <label v-if="advFreq === 'minutely' || advFreq === 'hourly'" class="sf-adv-row">
              <span class="sf-adv-label">Interval</span>
              <input
                v-model.number="advInterval"
                type="number"
                min="1"
                :max="advFreq === 'minutely' ? 59 : 23"
                class="sf-input sf-adv-control"
              />
              <span class="sf-hint">{{ advFreq === 'minutely' ? 'minutes' : 'hours' }}</span>
            </label>

            <div
              v-if="advFreq === 'hourly' || advFreq === 'daily' || advFreq === 'weekly'"
              class="sf-adv-row"
            >
              <span class="sf-adv-label">Time</span>
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
                advFreq === 'hourly' ? 'minute past each hour' : 'hour : minute (UTC)'
              }}</span>
            </div>

            <div v-if="advFreq === 'weekly'" class="sf-adv-row">
              <span class="sf-adv-label">Days</span>
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
            <span v-else class="sf-warn">Invalid cron expression</span>
          </div>
          <p v-if="nextRunPreview" class="sf-nextrun">
            Next run: <strong>{{ nextRunPreview }}</strong>
            <span class="sf-hint"> (schedule times are interpreted as UTC)</span>
          </p>
        </div>

        <!-- Execution identity -->
        <div class="sf-field">
          <span class="sf-label">Execution identity</span>
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
        <button class="sf-btn ghost" @click="emit('close')">Cancel</button>
        <button class="sf-btn primary" :disabled="!canSave" @click="save">
          {{ isEdit ? 'Save changes' : 'Create schedule' }}
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
.sf-segmented,
.sf-tabs {
  display: flex;
  gap: var(--sp-1);
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 2px;
}
.sf-seg,
.sf-tab {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sf-seg:hover:not(:disabled),
.sf-tab:hover {
  color: var(--c-text);
}
.sf-seg.active,
.sf-tab.active {
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

/* Presets */
.sf-presets {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--sp-2);
}
.sf-preset-card {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  color: var(--c-text);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  cursor: pointer;
  text-align: left;
}
.sf-preset-card:hover {
  border-color: var(--c-primary);
}
.sf-preset-card.active {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
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

/* LLM prompt + preview */
.sf-prompt-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
}
@media (max-width: 640px) {
  .sf-prompt-grid {
    grid-template-columns: 1fr;
  }
}
.sf-prompt-preview {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2);
  overflow-y: auto;
  max-height: 220px;
  font-size: var(--fs-body);
}
.sf-preview-tag {
  display: block;
  font-size: var(--fs-badge);
  color: var(--c-text-muted);
  text-transform: uppercase;
  margin-bottom: var(--sp-1);
}
.sf-preview-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
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
