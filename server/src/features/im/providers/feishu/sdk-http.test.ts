/**
 * SDK HTTP transport boundary tests.
 *
 * The registerApp begin/poll calls ride the SDK's process-level axios
 * singleton, so the transport contract is pinned here: axios proxy detection
 * stays off, every request gets the agent c3's `proxyAgentFor` decides for ITS
 * target origin (and only that origin), direct / NO_PROXY targets get the
 * agent cleared, configuration changes retire cached agents, and repeated
 * initialization never stacks an interceptor.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent as HttpsAgent } from 'node:https'
import {
  createSdkHttpInterceptor,
  installSdkHttpAgent,
  installedSdkHttpInterceptors,
  sdkHttpInterceptor,
} from './sdk-http.js'
import type { ProxySettingsView } from '../../../../kernel/infra/proxy-fetch.js'

function agentStub(name: string): HttpsAgent {
  return { destroy: vi.fn(), name } as unknown as HttpsAgent
}

const DIRECT: ProxySettingsView = { enabled: false, httpProxy: '', httpsProxy: '' }

describe('feishu SDK HTTP transport', () => {
  it('sets axios proxy=false once and keeps exactly one interceptor across re-inits', () => {
    const before = installedSdkHttpInterceptors()
    const first = installSdkHttpAgent()
    installSdkHttpAgent()
    installSdkHttpAgent()
    // The SDK ships its own UA fallback interceptor; our initializer adds
    // exactly one more, no matter how many times it is called.
    expect(installedSdkHttpInterceptors()).toBe(before + 1)
    expect(sdkHttpInterceptor()).not.toBeNull()
    first.release()
    // Release ejects our handler and removes the install marker, so a re-init
    // after release installs exactly one fresh handler (no stacking).
    expect(installedSdkHttpInterceptors()).toBe(before)
    installSdkHttpAgent()
    expect(installedSdkHttpInterceptors()).toBe(before + 1)
  })

  it('applies the agent only for the request target origin, clearing it otherwise', () => {
    const agentFor = vi.fn((url: string) => {
      return url.startsWith('https://accounts.feishu.cn') ? agentStub('accounts') : null
    })
    const { handler } = createSdkHttpInterceptor({
      proxySettings: () => ({
        enabled: true,
        httpProxy: 'http://proxy:8080',
        httpsProxy: 'http://proxy:8080',
      }),
      env: {},
      agentFor,
    })

    const accounts = handler({
      url: 'https://accounts.feishu.cn/oauth/v1/app/registration',
      httpsAgent: undefined,
    })
    expect(accounts.httpsAgent).toBeDefined()
    expect(agentFor).toHaveBeenLastCalledWith(
      'https://accounts.feishu.cn/oauth/v1/app/registration',
      expect.objectContaining({ enabled: true }),
      {},
    )

    // A direct-connection request must not keep the previous request's agent.
    const direct = handler({ url: 'https://open.feishu.cn/open-apis/xxx', httpsAgent: undefined })
    expect(direct.httpsAgent).toBeUndefined()
    expect(agentFor).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/xxx',
      expect.objectContaining({ enabled: true }),
      {},
    )
  })

  it('resolves each request with the current settings and env (proxy / NO_PROXY / direct)', () => {
    const settings = { enabled: false, httpProxy: '', httpsProxy: '' }
    const agentFor = vi.fn((_url: string, _s: ProxySettingsView, e?: NodeJS.ProcessEnv) => {
      return e?.NO_PROXY?.includes('feishu.cn') ? null : agentStub('env-agent')
    })
    const { handler } = createSdkHttpInterceptor({
      proxySettings: () => settings,
      env: { HTTPS_PROXY: 'http://env-proxy:3128' },
      agentFor,
    })

    // Settings off + env proxy on: env wins.
    const proxied = handler({ url: 'https://accounts.feishu.cn/begin', httpsAgent: undefined })
    expect(proxied.httpsAgent).toBeDefined()

    // NO_PROXY for the same origin: agent cleared, no cache reuse of env-agent.
    const { handler: noProxy } = createSdkHttpInterceptor({
      proxySettings: () => settings,
      env: { HTTPS_PROXY: 'http://env-proxy:3128', NO_PROXY: 'feishu.cn' },
      agentFor,
    })
    const direct = noProxy({ url: 'https://accounts.feishu.cn/begin', httpsAgent: undefined })
    expect(direct.httpsAgent).toBeUndefined()
  })

  it('reuses the cached agent while the config is stable and retires it on change', () => {
    let settings: ProxySettingsView = {
      enabled: true,
      httpProxy: 'http://one:8080',
      httpsProxy: 'http://one:8080',
    }
    const first = agentStub('one')
    const second = agentStub('two')
    const agentFor = vi.fn(() => first)
    const { handler } = createSdkHttpInterceptor({
      proxySettings: () => settings,
      env: {},
      agentFor,
    })
    const a = handler({ url: 'https://accounts.feishu.cn/poll', httpsAgent: undefined })
    const b = handler({ url: 'https://accounts.feishu.cn/poll', httpsAgent: undefined })
    expect(a.httpsAgent).toBe(first)
    expect(b.httpsAgent).toBe(first)
    expect(agentFor).toHaveBeenCalledTimes(1)

    // Config change: the old agent is destroyed and a new one is built.
    agentFor.mockReturnValue(second)
    settings = { enabled: true, httpProxy: 'http://two:8080', httpsProxy: 'http://two:8080' }
    const c = handler({ url: 'https://accounts.feishu.cn/poll', httpsAgent: undefined })
    expect(c.httpsAgent).toBe(second)
    expect(first.destroy).toHaveBeenCalled()
  })

  it('release destroys cached agents and clears the cache', () => {
    const agent = agentStub('cached')
    const { handler, release } = createSdkHttpInterceptor({
      proxySettings: () => ({ enabled: true, httpProxy: 'http://p:1', httpsProxy: 'http://p:1' }),
      env: {},
      agentFor: () => agent,
    })
    handler({ url: 'https://accounts.feishu.cn/x', httpsAgent: undefined })
    release()
    expect(agent.destroy).toHaveBeenCalled()
  })
})
