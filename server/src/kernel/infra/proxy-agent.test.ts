/**
 * Which connections go through a proxy. The agent shares `resolveProxyUrl` with
 * the outbound fetch path, so what is pinned here is the wiring around it: that
 * a WebSocket URL is judged as the HTTP(S) it upgrades from, and that the
 * exemptions (loopback, NO_PROXY, no configuration at all) yield no agent rather
 * than a pass-through one.
 */
import { describe, expect, it } from 'vitest'
import { proxyAgentFor } from './proxy-agent.js'
import type { ProxySettingsView } from './proxy-fetch.js'

const off: ProxySettingsView = { enabled: false, httpProxy: '', httpsProxy: '' }
const on: ProxySettingsView = {
  enabled: true,
  httpProxy: 'http://proxy.local:8080',
  httpsProxy: 'http://proxy.local:8080',
}

describe('proxyAgentFor', () => {
  it('returns no agent when nothing configures a proxy', () => {
    expect(proxyAgentFor('wss://open.feishu.cn/ws', off, {})).toBeNull()
  })

  it('builds an agent for a wss target when a proxy is configured', () => {
    expect(proxyAgentFor('wss://open.feishu.cn/ws', on, {})).not.toBeNull()
  })

  it('treats ws:// as http:// for the proxy decision', () => {
    expect(proxyAgentFor('ws://example.com/ws', on, {})).not.toBeNull()
  })

  it('honours the environment when settings are off', () => {
    expect(
      proxyAgentFor('wss://open.feishu.cn/ws', off, { HTTPS_PROXY: 'http://env.local:3128' }),
    ).not.toBeNull()
  })

  it('never proxies loopback', () => {
    expect(proxyAgentFor('ws://127.0.0.1:3000/ws', on, {})).toBeNull()
    expect(proxyAgentFor('ws://localhost:3000/ws', on, {})).toBeNull()
  })

  it('honours NO_PROXY', () => {
    expect(proxyAgentFor('wss://open.feishu.cn/ws', on, { NO_PROXY: 'open.feishu.cn' })).toBeNull()
  })

  it('returns no agent for an unparseable target instead of throwing', () => {
    expect(proxyAgentFor('not a url', on, {})).toBeNull()
  })

  it('returns no agent when the configured proxy is malformed, rather than throwing', () => {
    const bad: ProxySettingsView = { enabled: true, httpProxy: ':::', httpsProxy: ':::' }
    expect(proxyAgentFor('wss://open.feishu.cn/ws', bad, {})).toBeNull()
  })
})
