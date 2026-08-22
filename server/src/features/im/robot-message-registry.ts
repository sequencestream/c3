/**
 * Type-safe robot safety message registry: locale fallback, parameter validation,
 * navigation link construction, and rendering. Sole source of fixed control copy
 * for IM robots — independent from Web vue-i18n.
 */
import { ROBOT_CONTEXT_MAX_CODEPOINTS, type UiLang } from '@ccc/shared/protocol'
import { loadSettings } from '../../kernel/config/index.js'
import { loadPersonalizedFor } from '../../kernel/config/personalized.js'
import {
  isRobotMessageKey,
  isRobotMessageLocale,
  ROBOT_MESSAGE_BASE_LOCALE,
  ROBOT_MESSAGE_CATALOG,
  ROBOT_MESSAGE_KEYS,
  type RobotMessageKey,
  type RobotMessageLocale,
} from './robot-message-catalog.js'

export {
  isRobotMessageKey,
  isRobotMessageLocale,
  ROBOT_MESSAGE_BASE_LOCALE,
  ROBOT_MESSAGE_KEYS,
  ROBOT_MESSAGE_LOCALES,
} from './robot-message-catalog.js'
export type { RobotMessageKey, RobotMessageLocale } from './robot-message-catalog.js'

export type MessageUsagePolicy = 'fixed_notice' | 'binding_notice' | 'broadcast_only'

export type DeepLinkKind = 'session' | 'intent' | 'discussion'

export type RobotNavTarget =
  | { kind: 'webEntry' }
  | { kind: 'objectDeepLink'; linkKind: DeepLinkKind; workspaceName: string; id: string }

/** Per-key parameter shapes — callers cannot pass undeclared fields. */
export type RobotMessageParams = {
  'system.safeFallback': Record<string, never>
  'binding.identityRequired': { nav?: RobotNavTarget }
  'binding.identityRequiredGroup': { nav?: RobotNavTarget }
  'binding.useDm': Record<string, never>
  'binding.success': Record<string, never>
  'binding.failed': { nav?: RobotNavTarget }
  'binding.tokenUnusable': Record<string, never>
  'binding.scopeChanged': Record<string, never>
  'visibility.notVisible': Record<string, never>
  'visibility.groupAllHidden': { nav?: RobotNavTarget }
  'visibility.groupPartiallyHidden': { totalCount: number; nav?: RobotNavTarget }
  'visibility.capabilityDenied': { nav?: RobotNavTarget }
  'visibility.webRequired': { nav?: RobotNavTarget }
  'token.expired': Record<string, never>
  'token.consumed': Record<string, never>
  'token.cancelled': Record<string, never>
  'token.unusable': Record<string, never>
  'token.wrongChat': Record<string, never>
  'runtime.timeout': Record<string, never>
  'runtime.blocked': { nav?: RobotNavTarget }
  'runtime.error': { nav?: RobotNavTarget }
  'runtime.guardRefused': { nav?: RobotNavTarget }
  'runtime.busy': Record<string, never>
  'runtime.storeUnavailable': Record<string, never>
  'runtime.inputRejectedCredential': Record<string, never>
  'runtime.inputRejectedTooLong': { maxChars: number }
  'runtime.securityError': Record<string, never>
  'navigation.webEntry.linked': { link: string }
  'navigation.webEntry.plain': Record<string, never>
  'navigation.objectDeepLink.linked': { link: string }
  'navigation.objectDeepLink.plain': Record<string, never>
  'broadcast.automationPaused': { title: string }
  'broadcast.automationSilentTimeout': { title: string }
  'broadcast.automationRetriesExhausted': { title: string }
  'broadcast.specPendingReview': { title: string }
  'broadcast.permissionRequestQueued': { title: string }
  'broadcast.deliveryPendingReview': { title: string }
  'broadcast.mainlineDrift': { title: string }
}

export type RobotMessageRef<K extends RobotMessageKey = RobotMessageKey> = {
  key: K
  params: RobotMessageParams[K]
}

export type RobotRenderContext = {
  personalLocale?: UiLang | null
  robotLocale?: UiLang | null
  /** When omitted, read fresh from system settings at render time. */
  baseUrl?: string | null
}

export type RenderDiagnostic = {
  key: RobotMessageKey
  attemptedLocales: RobotMessageLocale[]
  reason: 'unknown_key' | 'invalid_params' | 'missing_template' | 'fallback'
}

const MESSAGE_USAGE: Record<RobotMessageKey, MessageUsagePolicy> = {
  'system.safeFallback': 'fixed_notice',
  'binding.identityRequired': 'binding_notice',
  'binding.identityRequiredGroup': 'binding_notice',
  'binding.useDm': 'binding_notice',
  'binding.success': 'binding_notice',
  'binding.failed': 'binding_notice',
  'binding.tokenUnusable': 'binding_notice',
  'binding.scopeChanged': 'binding_notice',
  'visibility.notVisible': 'fixed_notice',
  'visibility.groupAllHidden': 'fixed_notice',
  'visibility.groupPartiallyHidden': 'fixed_notice',
  'visibility.capabilityDenied': 'fixed_notice',
  'visibility.webRequired': 'fixed_notice',
  'token.expired': 'fixed_notice',
  'token.consumed': 'fixed_notice',
  'token.cancelled': 'fixed_notice',
  'token.unusable': 'fixed_notice',
  'token.wrongChat': 'fixed_notice',
  'runtime.timeout': 'fixed_notice',
  'runtime.blocked': 'fixed_notice',
  'runtime.error': 'fixed_notice',
  'runtime.guardRefused': 'fixed_notice',
  'runtime.busy': 'fixed_notice',
  'runtime.storeUnavailable': 'fixed_notice',
  'runtime.inputRejectedCredential': 'fixed_notice',
  'runtime.inputRejectedTooLong': 'fixed_notice',
  'runtime.securityError': 'fixed_notice',
  'navigation.webEntry.linked': 'fixed_notice',
  'navigation.webEntry.plain': 'fixed_notice',
  'navigation.objectDeepLink.linked': 'fixed_notice',
  'navigation.objectDeepLink.plain': 'fixed_notice',
  'broadcast.automationPaused': 'broadcast_only',
  'broadcast.automationSilentTimeout': 'broadcast_only',
  'broadcast.automationRetriesExhausted': 'broadcast_only',
  'broadcast.specPendingReview': 'broadcast_only',
  'broadcast.permissionRequestQueued': 'broadcast_only',
  'broadcast.deliveryPendingReview': 'broadcast_only',
  'broadcast.mainlineDrift': 'broadcast_only',
}

/** Binding notices that may be sent in group chats (narrow exemption). */
export const BINDING_GROUP_ALLOWED_KEYS = new Set<RobotMessageKey>([
  'binding.identityRequired',
  'binding.identityRequiredGroup',
  'binding.useDm',
])

const DEEP_LINK_KINDS = new Set<DeepLinkKind>(['session', 'intent', 'discussion'])
const MAX_BROADCAST_TITLE = 200
const MAX_TOTAL_COUNT = 10_000

let registryValidated = false

export function messageUsagePolicy(key: RobotMessageKey): MessageUsagePolicy {
  return MESSAGE_USAGE[key]
}

export function isBindingGroupAllowedKey(key: RobotMessageKey): boolean {
  return BINDING_GROUP_ALLOWED_KEYS.has(key)
}

export function normalizeRobotLocale(raw: string | null | undefined): RobotMessageLocale | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  return isRobotMessageLocale(trimmed) ? trimmed : null
}

/** Personal uiLang → robot locale → system default (en), deduplicated. */
export function resolveLocaleChain(ctx: RobotRenderContext): RobotMessageLocale[] {
  const chain: RobotMessageLocale[] = []
  const push = (loc: RobotMessageLocale | null | undefined): void => {
    if (loc && !chain.includes(loc)) chain.push(loc)
  }
  push(normalizeRobotLocale(ctx.personalLocale ?? undefined))
  push(normalizeRobotLocale(ctx.robotLocale ?? undefined))
  push(ROBOT_MESSAGE_BASE_LOCALE)
  return chain
}

export function parsePublicBaseUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null
  const trimmed = raw.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  if (parsed.username || parsed.password) return null
  if (parsed.search || parsed.hash) return null
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
}

export function buildObjectDeepLink(
  baseUrl: string,
  kind: DeepLinkKind,
  workspaceName: string,
  id: string,
): string | null {
  if (!DEEP_LINK_KINDS.has(kind)) return null
  if (!workspaceName.trim() || !id.trim()) return null
  const root = parsePublicBaseUrl(baseUrl)
  if (!root) return null
  const ws = encodeURIComponent(workspaceName)
  const objId = encodeURIComponent(id)
  return `${root}/#/${kind}/${ws}/${objId}`
}

function escapePlainText(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0)!
    if (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    if (code === 0x7f) continue
    if (code >= 0x202a && code <= 0x202e) continue
    if (code >= 0x2066 && code <= 0x2069) continue
    out += ch
  }
  return out
}

function sanitizeLink(value: string): string {
  const cleaned = escapePlainText(value.trim())
  if (!cleaned || /\s/.test(cleaned)) return ''
  if (/^\/\//.test(cleaned)) return ''
  try {
    const u = new URL(cleaned)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    if (u.username || u.password || u.search || u.hash) return ''
    return cleaned
  } catch {
    return ''
  }
}

function renderNavSuffix(
  nav: RobotNavTarget | undefined,
  baseUrl: string | null,
  locale: RobotMessageLocale,
): string {
  if (!nav) return ''
  if (nav.kind === 'webEntry') {
    if (baseUrl) {
      const link = sanitizeLink(baseUrl)
      if (link) {
        return fillTemplate(
          ROBOT_MESSAGE_CATALOG['navigation.webEntry.linked'].templates[locale] ??
            ROBOT_MESSAGE_CATALOG['navigation.webEntry.linked'].templates.en,
          { link },
          ROBOT_MESSAGE_CATALOG['navigation.webEntry.linked'].placeholders,
        )
      }
    }
    return (
      ROBOT_MESSAGE_CATALOG['navigation.webEntry.plain'].templates[locale] ??
      ROBOT_MESSAGE_CATALOG['navigation.webEntry.plain'].templates.en
    )
  }
  if (nav.kind === 'objectDeepLink') {
    const deep = baseUrl && buildObjectDeepLink(baseUrl, nav.linkKind, nav.workspaceName, nav.id)
    if (deep) {
      const link = sanitizeLink(deep)
      if (link) {
        return fillTemplate(
          ROBOT_MESSAGE_CATALOG['navigation.objectDeepLink.linked'].templates[locale] ??
            ROBOT_MESSAGE_CATALOG['navigation.objectDeepLink.linked'].templates.en,
          { link },
          ROBOT_MESSAGE_CATALOG['navigation.objectDeepLink.linked'].placeholders,
        )
      }
    }
    return (
      ROBOT_MESSAGE_CATALOG['navigation.objectDeepLink.plain'].templates[locale] ??
      ROBOT_MESSAGE_CATALOG['navigation.objectDeepLink.plain'].templates.en
    )
  }
  return ''
}

function fillTemplate(
  template: string,
  params: Record<string, string | number>,
  allowed: readonly string[],
): string {
  let out = template
  for (const name of allowed) {
    const val = params[name]
    if (val === undefined) continue
    const safe = name === 'link' ? sanitizeLink(String(val)) : escapePlainText(String(val))
    out = out.split(`{${name}}`).join(safe)
  }
  out = out.replace(/\{[a-zA-Z]+\}/g, '')
  return out.trim()
}

function validateParams(
  key: RobotMessageKey,
  raw: unknown,
): Record<string, string | number> | null {
  const noParamKeys = new Set<RobotMessageKey>([
    'system.safeFallback',
    'binding.useDm',
    'binding.success',
    'binding.tokenUnusable',
    'binding.scopeChanged',
    'visibility.notVisible',
    'token.expired',
    'token.consumed',
    'token.cancelled',
    'token.unusable',
    'token.wrongChat',
    'runtime.timeout',
    'runtime.busy',
    'runtime.storeUnavailable',
    'runtime.inputRejectedCredential',
    'runtime.securityError',
    'navigation.webEntry.plain',
    'navigation.objectDeepLink.plain',
  ])

  if (noParamKeys.has(key)) {
    if (raw === undefined || (raw && typeof raw === 'object' && Object.keys(raw).length === 0)) {
      return {}
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const rec = raw as Record<string, unknown>
      if (Object.keys(rec).length === 0) return {}
    }
    return null
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const optionalNavKeys = new Set<RobotMessageKey>([
      'binding.identityRequired',
      'binding.identityRequiredGroup',
      'binding.failed',
      'visibility.groupAllHidden',
      'visibility.capabilityDenied',
      'visibility.webRequired',
      'runtime.blocked',
      'runtime.error',
      'runtime.guardRefused',
    ])
    if (optionalNavKeys.has(key)) return {}
    return null
  }

  const rec = raw as Record<string, unknown>
  const allowed = new Set(ROBOT_MESSAGE_CATALOG[key].placeholders)
  for (const k of Object.keys(rec)) {
    if (!allowed.has(k) && k !== 'nav') return null
  }

  const out: Record<string, string | number> = {}

  if (key === 'runtime.inputRejectedTooLong') {
    const max = rec.maxChars
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_TOTAL_COUNT) {
      return null
    }
    out.maxChars = max
    return out
  }

  if (key === 'visibility.groupPartiallyHidden') {
    const total = rec.totalCount
    if (
      typeof total !== 'number' ||
      !Number.isInteger(total) ||
      total < 0 ||
      total > MAX_TOTAL_COUNT
    ) {
      return null
    }
    out.totalCount = total
    if (rec.nav !== undefined && !isNavTarget(rec.nav)) return null
    return out
  }

  for (const bk of [
    'broadcast.automationPaused',
    'broadcast.automationSilentTimeout',
    'broadcast.automationRetriesExhausted',
    'broadcast.specPendingReview',
    'broadcast.permissionRequestQueued',
    'broadcast.deliveryPendingReview',
    'broadcast.mainlineDrift',
  ] as const) {
    if (key === bk) {
      const title = rec.title
      if (typeof title !== 'string' || title.length === 0 || title.length > MAX_BROADCAST_TITLE) {
        return null
      }
      out.title = escapePlainText(title)
      return out
    }
  }

  if (key === 'navigation.webEntry.linked' || key === 'navigation.objectDeepLink.linked') {
    const link = rec.link
    if (typeof link !== 'string') return null
    const safe = sanitizeLink(link)
    if (!safe) return null
    out.link = safe
    return out
  }

  if (rec.nav !== undefined && !isNavTarget(rec.nav)) return null
  return out
}

function isNavTarget(value: unknown): value is RobotNavTarget {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  if (rec.kind === 'webEntry') return true
  if (rec.kind !== 'objectDeepLink') return false
  return (
    typeof rec.linkKind === 'string' &&
    DEEP_LINK_KINDS.has(rec.linkKind as DeepLinkKind) &&
    typeof rec.workspaceName === 'string' &&
    typeof rec.id === 'string' &&
    rec.workspaceName.length > 0 &&
    rec.id.length > 0 &&
    rec.workspaceName.length <= 128 &&
    rec.id.length <= 128
  )
}

function resolveBaseUrl(ctx: RobotRenderContext): string | null {
  if (ctx.baseUrl !== undefined) return parsePublicBaseUrl(ctx.baseUrl)
  try {
    return parsePublicBaseUrl(loadSettings().baseUrl ?? null)
  } catch {
    return null
  }
}

export function renderRobotMessage(
  ref: RobotMessageRef,
  ctx: RobotRenderContext,
  diag?: RenderDiagnostic,
): string {
  const chain = resolveLocaleChain(ctx)
  if (diag) {
    diag.key = ref.key
    diag.attemptedLocales = [...chain]
  }

  if (!isRobotMessageKey(ref.key)) {
    if (diag) diag.reason = 'unknown_key'
    return renderSafeFallback(chain)
  }

  const params = validateParams(ref.key, ref.params)
  if (params === null) {
    if (diag) diag.reason = 'invalid_params'
    return renderSafeFallback(chain)
  }

  const nav = (ref.params as { nav?: RobotNavTarget }).nav
  const baseUrl = resolveBaseUrl(ctx)

  for (const locale of chain) {
    const entry = ROBOT_MESSAGE_CATALOG[ref.key]
    const template = entry?.templates[locale]
    if (!template) continue
    const body = fillTemplate(template, params, entry.placeholders)
    const suffix = renderNavSuffix(nav, baseUrl, locale)
    const combined = `${body}${suffix}`.trim()
    if (combined) return combined
  }

  if (diag) diag.reason = 'missing_template'
  return renderSafeFallback(chain)
}

function renderSafeFallback(chain: RobotMessageLocale[]): string {
  const key: RobotMessageKey = 'system.safeFallback'
  for (const locale of chain) {
    const t = ROBOT_MESSAGE_CATALOG[key].templates[locale]
    if (t) return t
  }
  return ROBOT_MESSAGE_CATALOG[key].templates.en
}

/** Startup validation — incomplete baseline catalog prevents supervisor start. */
export function validateRobotMessageRegistry(): void {
  if (registryValidated) return
  for (const key of ROBOT_MESSAGE_KEYS) {
    const entry = ROBOT_MESSAGE_CATALOG[key]
    if (!entry) throw new Error(`robot message registry missing key: ${key}`)
    const base = entry.templates[ROBOT_MESSAGE_BASE_LOCALE]
    if (!base || !base.trim()) {
      throw new Error(`robot message registry missing baseline template: ${key}`)
    }
  }
  registryValidated = true
}

export function resetRobotMessageRegistryForTests(): void {
  registryValidated = false
}

export function resolveRobotRenderContext(input: {
  subject?: string | null
  robotLocale?: UiLang | null
  baseUrl?: string | null
}): RobotRenderContext {
  let personalLocale: UiLang | undefined
  if (input.subject) {
    try {
      personalLocale = loadPersonalizedFor(input.subject)?.uiLang
    } catch {
      /* skip unavailable personal settings */
    }
  }
  return {
    personalLocale: personalLocale ?? null,
    robotLocale: input.robotLocale ?? null,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
  }
}

export function runtimeInputTooLongRef(): RobotMessageRef<'runtime.inputRejectedTooLong'> {
  return {
    key: 'runtime.inputRejectedTooLong',
    params: { maxChars: ROBOT_CONTEXT_MAX_CODEPOINTS },
  }
}

export type TurnDisplaySignals = {
  objectNotVisible: boolean
  groupVisibleCount: number
  groupHiddenCount: number
}

export function createTurnDisplaySignals(): TurnDisplaySignals {
  return { objectNotVisible: false, groupVisibleCount: 0, groupHiddenCount: 0 }
}

export function recordObjectNotVisible(signals: TurnDisplaySignals): void {
  signals.objectNotVisible = true
}

export function recordGroupHidden(
  signals: TurnDisplaySignals,
  visibleCount: number,
  hiddenCount: number,
): void {
  if (hiddenCount <= 0) return
  signals.groupVisibleCount += visibleCount
  signals.groupHiddenCount += hiddenCount
}

/** Fixed priority: object_not_visible > group hidden > null (keep model answer). */
export function pickSecurityMessage(
  signals: TurnDisplaySignals,
  chatType: 'group' | 'p2p',
): RobotMessageRef | null {
  if (signals.objectNotVisible) {
    return { key: 'visibility.notVisible', params: {} }
  }
  if (signals.groupHiddenCount > 0 && chatType === 'group') {
    if (signals.groupVisibleCount === 0) {
      return {
        key: 'visibility.groupAllHidden',
        params: { nav: { kind: 'webEntry' } },
      }
    }
    return {
      key: 'visibility.groupPartiallyHidden',
      params: {
        totalCount: signals.groupVisibleCount + signals.groupHiddenCount,
        nav: { kind: 'webEntry' },
      },
    }
  }
  return null
}

export function outcomeToRuntimeMessage(outcome: string): RobotMessageRef | null {
  switch (outcome) {
    case 'timeout':
      return { key: 'runtime.timeout', params: {} }
    case 'blocked':
      return { key: 'runtime.blocked', params: { nav: { kind: 'webEntry' } } }
    case 'guard_refused':
      return { key: 'runtime.guardRefused', params: { nav: { kind: 'webEntry' } } }
    case 'busy':
      return { key: 'runtime.busy', params: {} }
    case 'error':
      return { key: 'runtime.error', params: { nav: { kind: 'webEntry' } } }
    default:
      return null
  }
}

export function assertSendableCategory(
  ref: RobotMessageRef,
  category: 'fixed_notice' | 'binding_notice',
): boolean {
  const policy = messageUsagePolicy(ref.key)
  if (policy === 'broadcast_only') return false
  if (category === 'binding_notice') return policy === 'binding_notice'
  return policy === 'fixed_notice'
}
