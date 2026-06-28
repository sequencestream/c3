<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  getJSON,
  postJSON,
  formatPrice,
  formatDate,
  loginHref,
  tierLabel,
  type Plan,
  type License,
  type PlanTier,
  type TierCapability,
} from '../lib/api'
import { useTypedI18n } from '../i18n'

const { t } = useTypedI18n()

// Renewal checkout (§4): the agreement is shown HERE (not at sign-in). On submit
// the server derives the amount from the plan and returns a WeChat Native QR.
interface Agreement {
  title: string
  version: string
  markdown: string
}

const loading = ref(true)
const error = ref('')
const plans = ref<Plan[]>([])
const licenses = ref<License[]>([])
const tiers = ref<PlanTier[]>([])
const capabilities = ref<TierCapability[]>([])
const agreement = ref<Agreement | null>(null)
const planKey = ref('')
const licenseId = ref<number | null>(null)
const accept = ref(false)
const submitting = ref(false)
const qrDataUri = ref('')
const orderNo = ref('')

// Plans split into two columns by tier. Each column keeps the server's
// sort_order (the catalog returns shortest-term-first), so we only filter here.
const paidPlans = computed(() => plans.value.filter((p) => p.tier === 'paid'))
const enterprisePlans = computed(() => plans.value.filter((p) => p.tier === 'enterprise'))

// tierName resolves a tier id to its display label from /v1/plan-tiers, falling
// back to the raw id so a missing tiers fetch never blanks the column heading.
function tierName(tier: string): string {
  return tiers.value.find((t) => t.tier === tier)?.name ?? tier
}

// selectedLicense is the renewal target the disable rule keys off of.
const selectedLicense = computed(() => licenses.value.find((l) => l.licenseId === licenseId.value) ?? null)

// paidDisabled mirrors the server's per-license ErrTierDowngradeBlocked gate:
// when the renewal target is an active enterprise license, only enterprise plans
// may renew it. termEnd is Unix seconds (same unit as formatDate). This is a UX
// guard, not a security boundary — the server stays the authoritative gate.
const paidDisabled = computed(
  () => selectedLicense.value?.tier === 'enterprise' && selectedLicense.value.termEnd * 1000 > Date.now(),
)
// payStatus tracks the order once the QR is shown: '' before checkout, then
// pending → paid/expired/failed as the status poll observes the settlement done
// by the WeChat callback or the every-15s server reconcile job.
const payStatus = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

// pollStatus checks the order's payment state. Once it leaves 'pending' the poll
// stops; on success the page navigates to the account view so the renewed term
// is visible without a manual refresh.
async function pollStatus(): Promise<void> {
  const res = await getJSON<{ status: string }>(`/v1/checkout/status?orderNo=${encodeURIComponent(orderNo.value)}`)
  if (!res.ok || !res.data) return
  payStatus.value = res.data.status
  if (res.data.status === 'pending') return
  stopPolling()
  if (res.data.status === 'paid') {
    setTimeout(() => {
      window.location.href = '/account'
    }, 1500)
  }
}

onUnmounted(stopPolling)

onMounted(async () => {
  const sess = await getJSON<{ signedIn: boolean }>('/v1/session')
  if (!sess.data?.signedIn) {
    window.location.href = loginHref()
    return
  }
  const [p, l, a, t] = await Promise.all([
    getJSON<{ plans: Plan[] }>('/v1/plans'),
    getJSON<{ licenses: License[] }>('/v1/licenses'),
    getJSON<Agreement>('/v1/agreement'),
    getJSON<{ tiers: PlanTier[]; capabilities: TierCapability[] }>('/v1/plan-tiers'),
  ])
  plans.value = p.data?.plans ?? []
  licenses.value = l.data?.licenses ?? []
  agreement.value = a.data
  tiers.value = t.data?.tiers ?? []
  capabilities.value = t.data?.capabilities ?? []
  if (licenses.value.length) licenseId.value = licenses.value[0].licenseId
  // Default the selection to the first selectable plan: skip the paid column when
  // the (default) target is an active enterprise license.
  if (plans.value.length) {
    const first = paidDisabled.value ? (enterprisePlans.value[0] ?? null) : plans.value[0]
    planKey.value = first?.planKey ?? ''
  }
  loading.value = false
})

// When the target license flips to active-enterprise (on mount or on switching
// licenses), a paid plan can no longer renew it — clear the selection so the
// order button never submits a plan the server would reject with a 400.
watch(paidDisabled, (disabled) => {
  if (disabled && paidPlans.value.some((p) => p.planKey === planKey.value)) {
    planKey.value = ''
  }
})

async function submit(): Promise<void> {
  error.value = ''
  if (!accept.value) {
    error.value = t('checkout.errorMustAccept')
    return
  }
  submitting.value = true
  const res = await postJSON<{ orderNo: string; codeUrl?: string; qrDataUri?: string }>('/v1/checkout', {
    planKey: planKey.value,
    licenseId: licenseId.value,
    accept: accept.value,
  })
  submitting.value = false
  if (!res.ok || !res.data) {
    error.value = res.error || t('checkout.errorOrderFailed')
    return
  }
  orderNo.value = res.data.orderNo
  qrDataUri.value = res.data.qrDataUri ?? ''
  // Begin polling for payment confirmation: the callback may never arrive (e.g.
  // the notify URL is not publicly reachable), so the poll is what flips the UI
  // once the server-side reconcile marks the order paid.
  if (qrDataUri.value) {
    payStatus.value = 'pending'
    stopPolling()
    pollTimer = setInterval(() => {
      void pollStatus()
    }, 5000)
  }
}
</script>

<template>
  <main class="ls-card wide checkout-wide">
    <h1>{{ t('checkout.title') }}</h1>
    <p class="note"><a href="/plans">{{ t('checkout.linkCompare') }}</a></p>
    <p v-if="loading" class="note">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-if="!loading && qrDataUri">
      <template v-if="payStatus === 'paid'">
        <p class="ok">{{ t('checkout.paySuccess') }}</p>
      </template>
      <template v-else-if="payStatus === 'expired' || payStatus === 'failed'">
        <p class="error">{{ t('checkout.payIncomplete', { reason: payStatus === 'expired' ? t('checkout.payExpired') : t('checkout.payFailed') }) }}</p>
        <p class="note"><a href="/checkout">{{ t('checkout.linkNewOrder') }}</a></p>
      </template>
      <template v-else>
        <p class="ok">{{ t('checkout.orderCreated', { orderNo }) }}</p>
        <img class="qr" :src="qrDataUri" :alt="t('checkout.qrAlt')" width="256" height="256" />
        <p class="note">{{ t('checkout.qrHint') }}</p>
        <p class="note">{{ t('checkout.waitingPayment') }}</p>
      </template>
    </template>

    <template v-else-if="!loading">
      <h2>{{ t('checkout.compareTitle') }}</h2>
      <table v-if="capabilities.length" class="tier-compare" data-testid="tier-compare">
        <thead>
          <tr>
            <th>{{ t('checkout.capability') }}</th>
            <th>{{ tierName('free') }}</th>
            <th>{{ tierName('paid') }}</th>
            <th>{{ tierName('enterprise') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in capabilities" :key="row.label">
            <td>{{ row.label }}</td>
            <td>{{ row.free }}</td>
            <td>{{ row.paid }}</td>
            <td>{{ row.enterprise }}</td>
          </tr>
        </tbody>
      </table>

      <h2>{{ t('checkout.choosePlan') }}</h2>
      <div class="plan-cols">
        <section class="plan-col" data-testid="free-col">
          <h3>{{ tierName('free') }}</h3>
          <p class="note">{{ t('checkout.freeNoPurchase') }}</p>
        </section>

        <section class="plan-col" :class="{ 'is-disabled': paidDisabled }" data-testid="paid-col">
          <h3>{{ tierName('paid') }}</h3>
          <p v-if="paidDisabled" class="note disabled-hint" data-testid="paid-disabled-hint">
            {{ t('checkout.paidDisabledHint') }}
          </p>
          <label v-for="p in paidPlans" :key="p.planKey" class="opt" :class="{ 'opt-disabled': paidDisabled }">
            <input type="radio" name="plan" :value="p.planKey" v-model="planKey" :disabled="paidDisabled" />
            <span>{{ p.name }}</span><span class="price">{{ formatPrice(p.priceCents, p.currency) }}</span>
          </label>
          <p v-if="!paidPlans.length" class="note">{{ t('checkout.noPaidPlans') }}</p>
        </section>

        <section class="plan-col" data-testid="enterprise-col">
          <h3>{{ tierName('enterprise') }}</h3>
          <label v-for="p in enterprisePlans" :key="p.planKey" class="opt">
            <input type="radio" name="plan" :value="p.planKey" v-model="planKey" />
            <span>{{ p.name }}</span><span class="price">{{ formatPrice(p.priceCents, p.currency) }}</span>
          </label>
          <p v-if="!enterprisePlans.length" class="note">{{ t('checkout.noEnterprisePlans') }}</p>
        </section>
      </div>

      <h2>{{ t('checkout.renewTarget') }}</h2>
      <label v-for="l in licenses" :key="l.licenseId" class="opt">
        <input type="radio" name="lic" :value="l.licenseId" v-model="licenseId" />
        <code class="key">{{ l.licenseKey }}</code>
        <span class="badge" data-testid="lic-tier">{{ tierLabel(l.tier) }}</span>
        <span class="price">{{ formatDate(l.termEnd) }}</span>
      </label>
      <p v-if="!licenses.length" class="note">{{ t('checkout.noRenewableLicenses') }}</p>

      <label class="agree">
        <input type="checkbox" v-model="accept" />
        <span>
          <i18n-t keypath="checkout.agreePrompt" tag="span">
            <template #agreement><a href="/agreement" target="_blank" rel="noopener">{{ agreement?.title }}</a></template>
          </i18n-t>
        </span>
      </label>
      <button :disabled="submitting || !accept || !planKey || licenseId === null" @click="submit">
        {{ submitting ? t('checkout.submitting') : t('checkout.placeOrder') }}
      </button>
    </template>
  </main>
</template>

<style scoped>
/* Checkout needs room for the three-column comparison + picker, so it overrides
 * the shared .ls-card.wide cap (52rem) at ~150% of that width. */
.checkout-wide {
  max-width: 78rem;
}
/* Three-column plan picker: free / paid / enterprise, left to right. Collapses to
 * a single column on narrow viewports so the cards never get cramped. */
.plan-cols {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--sp-4);
  align-items: start;
}
@media (max-width: 48rem) {
  .plan-cols {
    grid-template-columns: 1fr;
  }
}
.plan-col h3 {
  font-size: var(--fs-title-sm);
  font-weight: 600;
  margin: 0 0 var(--sp-2);
  color: var(--c-text);
}
.plan-col.is-disabled h3 {
  color: var(--c-text-muted);
}
.disabled-hint {
  color: var(--c-warning);
}
/* Disabled paid options read as inert: dimmed, no pointer affordance, no hover. */
.opt.opt-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.opt.opt-disabled:hover {
  background: var(--c-card);
}
.tier-compare {
  margin-top: var(--sp-4);
}
</style>
