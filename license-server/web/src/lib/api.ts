// api.ts — tiny fetch helpers for the license-server SPA. All endpoints are the
// same-origin /v1 JSON API (see specs §10); the sign-in cookie rides along.

import { t } from '../i18n'

export interface Plan {
  planKey: string
  name: string
  durationMonths: number
  priceCents: number
  currency: string
  tier: string
}

export interface PlanTier {
  tier: string
  name: string
}

export interface TierCapability {
  label: string
  free: string
  paid: string
  enterprise: string
}

export interface License {
  licenseId: number
  licenseKey: string
  status: string
  tier: string
  termEnd: number
  aliveInstallId: string | null
  aliveTime: number | null
}

export interface Order {
  orderId: number
  orderNo: string
  planKey: string
  amountCents: number
  currency: string
  status: string
  paymentRef: string
  createdAt: number
}

export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: string
}

export async function getJSON<T>(url: string): Promise<ApiResult<T>> {
  return request<T>('GET', url)
}

export async function postJSON<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  return request<T>('POST', url, body)
}

async function request<T>(method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!res.ok) {
      const err = parsed['error'] as { message?: string } | undefined
      return {
        ok: false,
        status: res.status,
        data: null,
        error: err?.message ?? `HTTP ${res.status}`,
      }
    }
    return { ok: true, status: res.status, data: parsed as T, error: '' }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) }
  }
}

// query reads a URL query parameter from the current location.
export function query(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? ''
}

// formatPrice renders a minor-unit price (e.g. 590 CNY → "¥5.90").
export function formatPrice(cents: number, currency: string): string {
  const major = (cents / 100).toFixed(2)
  return currency === 'CNY' ? `¥${major}` : `${major} ${currency}`
}

// formatDate renders a UTC Unix-seconds timestamp as YYYY-MM-DD.
export function formatDate(unix: number): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toISOString().slice(0, 10)
}

// statusBadgeClass maps a license/order status to a §3.8 badge variant class.
// active/paid → success; pending → warning; failed → error; expired/other → muted.
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active':
    case 'paid':
      return 'badge badge-success'
    case 'pending':
      return 'badge badge-warning'
    case 'failed':
      return 'badge badge-error'
    default:
      return 'badge'
  }
}

// tierLabel renders a license/plan tier id as its localized display label. Kept
// here (not derived from /v1/plan-tiers) so views that don't fetch the tier
// catalog — e.g. the account page — can still label a license's tier. Resolves
// via the global i18n so it tracks the active UI language.
export function tierLabel(tier: string): string {
  switch (tier) {
    case 'free':
      return t('tier.free')
    case 'paid':
      return t('tier.paid')
    case 'enterprise':
      return t('tier.enterprise')
    default:
      return tier
  }
}

// loginHref builds the sign-in URL, preserving the binding round if present so
// the user returns to the activation view after GitHub.
export function loginHref(): string {
  const installId = query('installId')
  const requestId = query('requestId')
  const p = new URLSearchParams()
  if (installId) p.set('installId', installId)
  if (requestId) p.set('requestId', requestId)
  const q = p.toString()
  return q ? `/login?${q}` : '/login'
}
