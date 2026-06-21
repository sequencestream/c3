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

const frequency = ref<Frequency>('hourly')
const interval = ref(1)
const hour = ref(0)
const minute = ref(0)
const dayOfWeek = ref('*')

function parseNumber(value: string, fallback: number, max: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback
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
  dayOfWeek.value = dowField || '*'
  frequency.value = dowField === '*' ? 'daily' : 'weekly'
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
      return `${minute.value} ${hour.value} * * ${dayOfWeek.value}`
    default:
      return '0 * * * *'
  }
})

function save(): void {
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
        <div class="sce-preview">
          <code>{{ resolvedCronExpression }}</code
          ><span>{{ describeCron(resolvedCronExpression) }}</span>
        </div>
      </div>
      <footer class="sce-actions">
        <button type="button" class="sce-button" @click="emit('close')">
          {{ t('common.action.cancel.label') }}
        </button>
        <button type="button" class="sce-button sce-button--primary" @click="save">
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
.sce-field > span:first-child {
  min-width: 52px;
  color: var(--c-text-muted);
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
</style>
