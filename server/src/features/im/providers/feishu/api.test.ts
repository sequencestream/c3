/**
 * application v7 long-connection configuration tests.
 *
 * The token and the `applicationConfig` PATCH both ride c3's own outbound
 * channel (`outboundFetch`) — no SDK `Client`, no v6 PATCH/GET, no second
 * token cache. The PATCH path is pinned exactly and the body carries ONLY the
 * event subscription fields; `code=0` is the single success signal, and every
 * refusal maps to a closed `manual_setup_required` reason while the caller
 * keeps the credentials it already owns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureAppWebsocket, FeishuApiError } from './api.js'

vi.mock('../../../../kernel/infra/proxy-fetch.js', () => ({
  outboundFetch: vi.fn(),
}))

import { outboundFetch } from '../../../../kernel/infra/proxy-fetch.js'

const fetchMock = vi.mocked(outboundFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function tokenOk(): Response {
  return jsonResponse({ code: 0, tenant_access_token: 'tat-1', expire: 7200 })
}

function calls() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    headers: (init as RequestInit | undefined)?.headers,
    body: (init as RequestInit | undefined)?.body,
    signal: (init as RequestInit | undefined)?.signal,
  }))
}

describe('configureAppWebsocket (application v7)', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('fetches a tenant token with the new credentials and PATCHes the exact v7 path', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(jsonResponse({ code: 0 }))
    const outcome = await configureAppWebsocket('cli_new', 'new-secret')
    expect(outcome).toBe('configured')

    const [tokenCall, patchCall] = calls()
    expect(tokenCall.url).toBe(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    )
    expect(tokenCall.method).toBe('POST')
    expect(JSON.parse(String(tokenCall.body))).toEqual({
      app_id: 'cli_new',
      app_secret: 'new-secret',
    })
    expect(patchCall.url).toBe(
      'https://open.feishu.cn/open-apis/application/v7/applications/cli_new/config',
    )
    expect(patchCall.url).not.toContain('lang')
    expect(patchCall.method).toBe('PATCH')
    expect(JSON.parse(String(patchCall.body))).toEqual({
      event: { subscription_type: 'websocket', add_events: ['im.message.receive_v1'] },
    })
    expect(JSON.parse(String(patchCall.body))).not.toHaveProperty('scopes')
  })

  it('maps HTTP 403 to config_forbidden', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(jsonResponse({ code: 1 }, 403))
    expect(await configureAppWebsocket('cli_new', 'new-secret')).toBe('config_forbidden')
  })

  it('maps HTTP 404/405/501 to config_unavailable', async () => {
    for (const status of [404, 405, 501]) {
      fetchMock.mockReset()
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(jsonResponse({ code: 1 }, status))
      expect(await configureAppWebsocket('cli_new', 'new-secret')).toBe('config_unavailable')
    }
  })

  it('maps a non-zero business code to config_rejected', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(jsonResponse({ code: 20001 }))
    expect(await configureAppWebsocket('cli_new', 'new-secret')).toBe('config_rejected')
  })

  it('maps a token business rejection to config_rejected', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 10003, msg: 'app not found' }))
    expect(await configureAppWebsocket('cli_new', 'new-secret')).toBe('config_rejected')
  })

  it('maps a network failure to config_network_error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(await configureAppWebsocket('cli_new', 'new-secret')).toBe('config_network_error')
  })

  it('rejects missing credentials defensively', async () => {
    await expect(configureAppWebsocket('', 'new-secret')).rejects.toBeInstanceOf(FeishuApiError)
    await expect(configureAppWebsocket('cli_new', '')).rejects.toBeInstanceOf(FeishuApiError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The design doc's "cancel/15s timeout covers the token + PATCH leg" claim
  // only holds if the token fetch actually carries the same signal as the
  // PATCH — otherwise a hung token request outlives cancellation and keeps
  // the connection's single registration slot occupied.
  it('applies the same combined abort/timeout signal to the token fetch as to the PATCH', async () => {
    fetchMock.mockResolvedValueOnce(tokenOk()).mockResolvedValueOnce(jsonResponse({ code: 0 }))
    await configureAppWebsocket('cli_new', 'new-secret', { timeoutMs: 5_000 })

    const [tokenCall, patchCall] = calls()
    expect(tokenCall.signal).toBeInstanceOf(AbortSignal)
    expect(tokenCall.signal).toBe(patchCall.signal)
  })

  it('aborts the token fetch when the caller cancels, without ever issuing the PATCH', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )

    const outcome = configureAppWebsocket('cli_new', 'new-secret', { signal: controller.signal })
    controller.abort()

    expect(await outcome).toBe('config_network_error')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
