// api.ts — tiny fetch helpers for the license-server SPA. All endpoints are the
// same-origin /v1 JSON API (see specs §10); the sign-in cookie rides along.

export interface Plan {
  planKey: string
  name: string
  durationMonths: number
  priceCents: number
  currency: string
}

export interface License {
  licenseId: number
  licenseKey: string
  planKey: string
  status: string
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
      return { ok: false, status: res.status, data: null, error: err?.message ?? `HTTP ${res.status}` }
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
