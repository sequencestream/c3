import { computed } from 'vue'
import type { Delivery, Intent } from '@ccc/shared/protocol'
import { CLAUDE_MODE_FALLBACK } from '@/composables/useModeLabel'
import { agentNameAt } from '@/lib/agent-prefix'
import { type StateDeps, sumSessionCounts, type TabKey } from './types'
import type { SessionSlice } from './session'
import type { NavigationSlice } from './navigation'
import type { DeliverySlice } from './delivery'
import type { SettingsSlice } from './settings'

export function buildCrossDomainSlice(
  deps: StateDeps,
  session: SessionSlice,
  navigation: NavigationSlice,
  delivery: DeliverySlice,
  settings: SettingsSlice,
) {
  const { t, modeLabel } = deps
  const {
    activeSession,
    ownerRunningCounts,
    sessionCounts,
    currentWorkspace,
    currentAgentIndexBySession,
    messages,
    sessionsByWorkspace,
  } = session
  const { serverSettings, intentsProject, intents, activeVendor, activeAgentSwitch } = navigation
  const { deliveriesProject, deliveries, deliveriesNeedsAction } = delivery
  const { vendorCapabilities, vendorModes } = settings

  const currentAgentName = computed(() =>
    activeSession.value
      ? agentNameAt(
          serverSettings.value,
          activeAgentSwitch.value?.current.id,
          currentAgentIndexBySession.value[activeSession.value] ?? 0,
        )
      : '',
  )

  // ---- Top-bar tabs ----
  // 顶部 tab 数据源。意图/讨论/自动化 三个 tab 的角标是「进行中条目数」(owner 去重),
  // 「会话」tab 的角标是六类进行中会话数之和 —— 两套口径并存,互不替代。角标的无障碍
  // 文案按 tab 各自的 key 取,不再共用「会话」文案。
  const HEADER_TABS = computed<
    { key: TabKey; label: string; badgeCount?: number; badgeAriaLabel?: string }[]
  >(() => {
    const owners = ownerRunningCounts.value
    const tabs: { key: TabKey; label: string; badgeCount?: number; badgeAriaLabel?: string }[] = [
      {
        key: 'intents',
        label: t('nav.tab.intents.label'),
        badgeCount: owners.intent,
        badgeAriaLabel: t('nav.tab.intents.ariaLabel', { count: owners.intent }),
      },
      {
        key: 'deliveries',
        label: t('nav.tab.delivery.label'),
        badgeCount: deliveriesNeedsAction.value[currentWorkspace.value ?? ''] ?? 0,
        badgeAriaLabel: t('nav.tab.delivery.ariaLabel', {
          count: deliveriesNeedsAction.value[currentWorkspace.value ?? ''] ?? 0,
        }),
      },
      {
        key: 'discussion',
        label: t('nav.tab.discussion.label'),
        badgeCount: owners.discussion,
        badgeAriaLabel: t('nav.tab.discussion.ariaLabel', { count: owners.discussion }),
      },
      {
        key: 'automations',
        label: t('nav.tab.automations.label'),
        badgeCount: owners.automation,
        badgeAriaLabel: t('nav.tab.automations.ariaLabel', { count: owners.automation }),
      },
      { key: 'files', label: t('nav.tab.files.label') },
    ]
    if (serverSettings.value?.showSessionsPage === true) {
      const running = sumSessionCounts(sessionCounts.value)
      tabs.push({
        key: 'console',
        label: t('nav.tab.console.label'),
        badgeCount: running,
        badgeAriaLabel: t('nav.tab.console.ariaLabel', { count: running }),
      })
    }
    return tabs
  })
  const currentIntents = computed<Intent[]>(() =>
    intentsProject.value ? (intents.value[intentsProject.value] ?? []) : [],
  )
  /**
   * The delivery page's intent pool (its link picker) — keyed by the DELIVERY
   * workspace, not the intents tab's. The two tabs can sit on different
   * workspaces, and the picker must offer the delivery's own.
   */
  const deliveryLinkIntents = computed<Intent[]>(() =>
    deliveriesProject.value ? (intents.value[deliveriesProject.value] ?? []) : [],
  )
  /**
   * The mirror image for the intent page's 「关联交付」 picker — the deliveries of
   * the INTENTS workspace, which may differ from the delivery tab's. Fed by the
   * same `deliveries` frame (keyed by workspace), so the picker stays fresh on
   * broadcast without the intent page owning a second cache.
   */
  const intentLinkDeliveries = computed<Delivery[]>(() =>
    intentsProject.value ? (deliveries.value[intentsProject.value] ?? []) : [],
  )
  const taskStoreAvailable = computed(() => {
    const caps = vendorCapabilities.value
    const vendor = activeVendor.value
    if (!caps || !vendor) return true
    return caps[vendor]?.taskStore ?? true
  })
  const modeOptions = computed(() => {
    const vendor = activeVendor.value
    const catalog = vendor ? vendorModes.value?.[vendor] : undefined
    const list = catalog
      ? catalog.modes.map((m) => ({ token: m.token, labelCode: m.labelCode }))
      : CLAUDE_MODE_FALLBACK
    return list.map((m) => ({ value: m.token, label: modeLabel(m.labelCode) }))
  })

  // The time zone automation cron fields are interpreted in for the live preview.
  const automationTimezone = computed(
    () => serverSettings.value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  )

  return {
    currentAgentName,
    HEADER_TABS,
    currentIntents,
    deliveryLinkIntents,
    intentLinkDeliveries,
    taskStoreAvailable,
    modeOptions,
    automationTimezone,
  } as const
}

export type CrossDomainSlice = ReturnType<typeof buildCrossDomainSlice>
