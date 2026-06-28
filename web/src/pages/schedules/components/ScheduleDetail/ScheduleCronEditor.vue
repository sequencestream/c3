<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { describeCron } from '@ccc/shared/cron'
import type { Schedule } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  schedule: Schedule | null
  /** Parent-held draft value; lets the full form re-open this editor before saving. */
  cronExpression?: string
}>()

const emit = defineEmits<{
  close: []
  save: [cronExpression: string]
}>()

type Frequency = 'minutely' | 'hourly' | 'daily' | 'weekly'

// 0=周日 … 6=周六,顺序与文案 key 对应。
const WEEKDAYS = computed<{ num: number; label: string }[]>(() => [
  { num: 0, label: t('schedule.form.weekday.sun') },
  { num: 1, label: t('schedule.form.weekday.mon') },
  { num: 2, label: t('schedule.form.weekday.tue') },
  { num: 3, label: t('schedule.form.weekday.wed') },
  { num: 4, label: t('schedule.form.weekday.thu') },
  { num: 5, label: t('schedule.form.weekday.fri') },
  { num: 6, label: t('schedule.form.weekday.sat') },
])

const frequency = ref<Frequency>('hourly')
const interval = ref(1)
const hour = ref(0)
const minute = ref(0)
// weekly 选中的星期几数字集合(单一事实源)。
const days = ref<number[]>([])

function parseNumber(value: string, fallback: number, max: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback
}

// 解析 cron 的 day-of-week 字段为数字数组(支持逗号列表 `2,6` 与区间 `1-5`),
// 与 ScheduleForm.renderDow 互逆。
function parseDow(raw: string): number[] {
  const list: number[] = []
  for (const part of raw.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) continue
    const lo = parseInt(m[1], 10)
    const hi = m[2] !== undefined ? parseInt(m[2], 10) : lo
    for (let v = lo; v <= hi; v++) if (v >= 0 && v <= 6 && !list.includes(v)) list.push(v)
  }
  return list.sort((a, b) => a - b)
}

// 与 ScheduleForm.renderDow 同规则:`1-5` 压缩,其余升序逗号拼接。
function renderDow(selected: number[]): string {
  const sorted = [...selected].sort((a, b) => a - b)
  if (sorted.length === 0) return '*'
  if (sorted.length === 5 && sorted.join(',') === '1,2,3,4,5') return '1-5'
  return sorted.join(',')
}

function seedCron(expression: string): void {
  const [minuteField = '0', hourField = '*', , , dowField = '*'] = expression.split(/\s+/)
  if (minuteField.startsWith('*/')) {
    frequency.value = 'minutely'
    interval.value = parseNumber(minuteField.slice(2), 1, 59) || 1
    return
  }
  minute.value = parseNumber(minuteField, 0, 59)
  if (hourField.startsWith('*/')) {
    frequency.value = 'hourly'
    interval.value = parseNumber(hourField.slice(2), 1, 23) || 1
    return
  }
  hour.value = parseNumber(hourField, 0, 23)
  frequency.value = dowField === '*' ? 'daily' : 'weekly'
  // weekly 时回填选中的星期几;历史上被存成 `*` 的旧数据解析为空,
  // 给一个合理默认(工作日 1-5,与新建表单一致),避免一打开即不可保存。
  if (frequency.value === 'weekly') {
    const parsed = parseDow(dowField)
    days.value = parsed.length ? parsed : [1, 2, 3, 4, 5]
  }
}

function toggleDay(num: number): void {
  const i = days.value.indexOf(num)
  if (i >= 0) days.value.splice(i, 1)
  else days.value.push(num)
}

watch(
  () =>
    [
      props.open,
      props.schedule?.id,
      props.cronExpression ?? props.schedule?.cronExpression,
    ] as const,
  ([open, , cronExpression]) => {
    if (open && cronExpression) seedCron(cronExpression)
  },
  { immediate: true },
)

const resolvedCronExpression = computed(() => {
  const n = Math.max(1, Math.min(frequency.value === 'minutely' ? 59 : 23, interval.value || 1))
  switch (frequency.value) {
    case 'minutely':
      return `*/${n} * * * *`
    case 'hourly':
      return `${minute.value} */${n} * * *`
    case 'daily':
      return `${minute.value} ${hour.value} * * *`
    case 'weekly':
      return `${minute.value} ${hour.value} * * ${renderDow(days.value)}`
    default:
      return '0 * * * *'
  }
})

// weekly 必须至少选 1 个星期几才能保存;其它频率不受此约束。
const daysInvalid = computed(() => frequency.value === 'weekly' && days.value.length === 0)
const canSave = computed(() => !daysInvalid.value)

function save(): void {
  if (!canSave.value) return
  emit('save', resolvedCronExpression.value)
}
</script>

<template>
  <div v-if="open" class="sce-overlay" @click.self="emit('close')">
    <section
      class="sce-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('schedule.form.schedule.label')"
    >
      <header class="sce-head">
        <h3>{{ t('schedule.form.schedule.label') }}</h3>
        <button
          type="button"
          class="sce-close"
          :title="t('common.action.close.tooltip')"
          @click="emit('close')"
        >
          ✕
        </button>
      </header>
      <div class="sce-body">
        <label class="sce-field">
          <span>{{ t('schedule.form.frequency.label') }}</span>
          <div class="sce-frequency">
            <select v-model="frequency" class="sce-input">
              <option value="minutely">{{ t('schedule.form.freq.minutely.label') }}</option>
              <option value="hourly">{{ t('schedule.form.freq.hourly.label') }}</option>
              <option value="daily">{{ t('schedule.form.freq.daily.label') }}</option>
              <option value="weekly">{{ t('schedule.form.freq.weekly.label') }}</option>
            </select>
            <input
              v-if="frequency === 'minutely' || frequency === 'hourly'"
              v-model.number="interval"
              class="sce-input sce-interval"
              type="number"
              min="1"
              :max="frequency === 'minutely' ? 59 : 23"
            />
          </div>
        </label>
        <label v-if="frequency !== 'minutely'" class="sce-field">
          <span>{{ t('schedule.form.time.label') }}</span>
          <input v-model.number="hour" class="sce-input sce-time" type="number" min="0" max="23" />
          <span>:</span>
          <input
            v-model.number="minute"
            class="sce-input sce-time"
            type="number"
            min="0"
            max="59"
          />
        </label>
        <div v-if="frequency === 'weekly'" class="sce-field sce-field--stacked">
          <span>{{ t('schedule.form.days.label') }}</span>
          <div class="sce-days">
            <button
              v-for="d in WEEKDAYS"
              :key="d.num"
              type="button"
              class="sce-day"
              :class="{ active: days.includes(d.num) }"
              @click="toggleDay(d.num)"
            >
              {{ d.label }}
            </button>
          </div>
          <span v-if="daysInvalid" class="sce-warn">{{ t('schedule.form.days.required') }}</span>
        </div>
        <div class="sce-preview">
          <code>{{ resolvedCronExpression }}</code
          ><span>{{ describeCron(resolvedCronExpression) }}</span>
        </div>
      </div>
      <footer class="sce-actions">
        <button type="button" class="sce-button" @click="emit('close')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button
          type="button"
          class="sce-button sce-button--primary"
          :disabled="!canSave"
          @click="save"
        >
          {{ t('common.action.save.label') }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.sce-overlay {
  position: fixed;
  inset: 0;
  /* Must cover the full schedule-edit modal (z-index: 200) when opened from it. */
  z-index: 400;
  display: grid;
  place-items: center;
  padding: var(--sp-4);
  background: rgba(0, 0, 0, 0.45);
}
.sce-modal {
  width: min(440px, 100%);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md);
  background: var(--c-panel);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}
.sce-head,
.sce-actions {
  display: flex;
  align-items: center;
  padding: var(--sp-3);
}
.sce-head {
  justify-content: space-between;
  border-bottom: 1px solid var(--c-border);
}
.sce-head h3 {
  margin: 0;
  font-size: var(--fs-body);
}
.sce-close,
.sce-button {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  background: var(--c-input);
  color: var(--c-text);
  cursor: pointer;
  padding: 5px 10px;
}
.sce-body {
  display: grid;
  gap: var(--sp-3);
  padding: var(--sp-4);
}
.sce-field,
.sce-frequency {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.sce-field--stacked {
  flex-direction: column;
  align-items: flex-start;
}
.sce-field > span:first-child {
  min-width: 52px;
  color: var(--c-text-muted);
}
.sce-days {
  display: flex;
  gap: var(--sp-1);
  flex-wrap: wrap;
}
.sce-day {
  background: var(--c-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: 4px 8px;
  cursor: pointer;
}
.sce-day.active {
  background: var(--c-accent);
  border-color: var(--c-accent);
  color: var(--c-accent-text, #fff);
}
.sce-warn {
  font-size: var(--fs-caption);
  color: var(--c-warning);
}
.sce-input {
  min-width: 0;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  background: var(--c-input);
  color: var(--c-text);
}
.sce-interval,
.sce-time {
  width: 64px;
}
.sce-preview {
  display: flex;
  gap: var(--sp-2);
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
}
.sce-preview code {
  color: var(--c-text);
}
.sce-actions {
  justify-content: flex-end;
  gap: var(--sp-2);
  border-top: 1px solid var(--c-border);
}
.sce-button--primary {
  border-color: var(--c-accent);
  background: var(--c-accent);
  color: var(--c-accent-text, #fff);
}
.sce-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
