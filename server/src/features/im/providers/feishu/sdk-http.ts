/**
 * Process-level HTTP transport for the Feishu SDK's Device Authorization
 * calls (`registerApp` begin/poll). The SDK owns the device-authorization
 * flow, but c3 owns the proxy decision — exactly like the long-link boundary:
 * axios must never read proxy environment variables itself, and every request
 * gets the agent c3's `proxyAgentFor` decides for ITS target origin.
 *
 * The SDK's `defaultHttpInstance` is a process singleton that cannot be
 * replaced per call, so this is a deliberate process-level side effect:
 *  - `defaults.proxy = false` kills axios' own env-proxy detection (it made
 *    the long link fail on machines with `HTTPS_PROXY` exported);
 *  - one request interceptor re-applies `proxyAgentFor` per request, so the
 *    account-domain agent of a previous request can never leak onto another
 *    Feishu origin, and direct / `NO_PROXY` targets get their agent cleared;
 *  - agents are cached by target origin + effective proxy configuration and
 *    dropped when the configuration changes, so a poll loop does not open a
 *    new connection pool every few seconds.
 *
 * Initialization is idempotent (repeated calls never stack an interceptor);
 * `releaseSdkHttpAgents()` destroys cached agents for tests and shutdown.
 * The WebSocket long link is unaffected: `WSClient` receives an explicit
 * agent and never touches this interceptor.
 */
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import type { Agent as HttpsAgent } from 'node:https'
import { getProxyConfig } from '../../../../kernel/config/index.js'
import { proxyAgentFor } from '../../../../kernel/infra/proxy-agent.js'
import type { ProxySettingsView } from '../../../../kernel/infra/proxy-fetch.js'

/** The minimal axios request-config shape the interceptor touches. */
interface SdkRequestConfig {
  url?: string
  httpsAgent?: HttpsAgent | undefined
}

interface AxiosLike {
  defaults: { proxy?: unknown }
  interceptors: {
    request: {
      use: (onFulfilled: (config: SdkRequestConfig) => SdkRequestConfig) => number
      eject: (id: number) => void
      handlers?: { fulfilled: (config: SdkRequestConfig) => SdkRequestConfig }[]
    }
  }
}

export interface SdkHttpDeps {
  /** Settings reader; defaults to the live system settings (re-read per request). */
  proxySettings?: () => ProxySettingsView
  env?: NodeJS.ProcessEnv
  /** Agent resolver; defaults to the real proxy-aware resolver. */
  agentFor?: typeof proxyAgentFor
}

/** One cached agent plus the configuration snapshot it was created under. */
interface CachedAgent {
  agent: HttpsAgent
  /** Effective proxy configuration key — changing it invalidates the agent. */
  configKey: string
}

const INSTALLED = Symbol('c3-sdk-http-interceptor-installed')

/** The SDK's axios instance at runtime (typed as a narrow axios-like shape). */
const http = defaultHttpInstance as unknown as AxiosLike

/** How a request's agent depends on the proxy configuration snapshot. */
function configKey(settings: ProxySettingsView, env: NodeJS.ProcessEnv): string {
  return JSON.stringify([
    settings.enabled,
    settings.httpProxy,
    settings.httpsProxy,
    env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? '',
    env.NO_PROXY ?? env.no_proxy ?? '',
  ])
}

/** The interceptor plus its cached-agent release handle, deps injected. */
export interface SdkHttpInterceptor {
  handler: (config: SdkRequestConfig) => SdkRequestConfig
  release: () => void
}

/**
 * Build a request interceptor honoring c3's proxy decision for each request.
 * Kept separate from the singleton install so tests can inject proxy settings,
 * env and an agent resolver without touching the process-global instance.
 */
export function createSdkHttpInterceptor(deps: SdkHttpDeps = {}): SdkHttpInterceptor {
  const proxySettings = deps.proxySettings ?? getProxyConfig
  const env = deps.env ?? process.env
  const agentFor = deps.agentFor ?? proxyAgentFor
  const agents = new Map<string, CachedAgent>()
  return {
    handler: (config) => {
      const url = config.url
      if (!url) return config
      let absolute: URL
      try {
        absolute = new URL(url)
      } catch {
        return config
      }
      // Only HTTPS requests get an agent; proxy resolution for others is
      // meaningless and would only add a stale connection pool.
      if (absolute.protocol !== 'https:') {
        config.httpsAgent = undefined
        return config
      }
      const origin = absolute.origin
      const key = configKey(proxySettings(), env)
      const cached = agents.get(origin)
      if (cached && cached.configKey === key) {
        config.httpsAgent = cached.agent
        return config
      }
      if (cached) {
        // Configuration changed: retire the agent built for the old config.
        cached.agent.destroy()
        agents.delete(origin)
      }
      const agent = agentFor(absolute.href, proxySettings(), env)
      config.httpsAgent = agent ?? undefined
      if (agent) agents.set(origin, { agent, configKey: key })
      return config
    },
    release: () => {
      for (const { agent } of agents.values()) agent.destroy()
      agents.clear()
    },
  }
}

/**
 * Configure the SDK's process-global HTTP transport once. Repeated calls are
 * no-ops for the interceptor (only the default proxy kill is re-applied,
 * which is harmless). Returns a release handle for tests and shutdown.
 */
export function installSdkHttpAgent(deps: SdkHttpDeps = {}): { release: () => void } {
  // Axios must never combine its own env-proxy reading with c3's decision.
  http.defaults.proxy = false

  if (INSTALLED in http) {
    // Idempotent re-init: the interceptor is already installed; only make sure
    // the shared agent cache is still releaseable by the (first) caller.
    return { release: () => {} }
  }
  const { handler, release } = createSdkHttpInterceptor(deps)
  const interceptorId = http.interceptors.request.use(handler)
  Object.defineProperty(http, INSTALLED, { value: interceptorId, configurable: true })
  return {
    release: () => {
      release()
      http.interceptors.request.eject(interceptorId)
      // Reflect.deleteProperty keeps `INSTALLED` removable so a later init
      // after release installs one fresh interceptor instead of stacking.
      Reflect.deleteProperty(http, INSTALLED)
    },
  }
}

/**
 * The interceptor installed on the SDK instance, when one is installed —
 * exposed for tests asserting single-install and per-request behavior.
 */
export function sdkHttpInterceptor(): SdkHttpInterceptor['handler'] | null {
  const handlers = http.interceptors.request.handlers
  const installed = handlers?.find((h) => h && typeof h.fulfilled === 'function')
  return installed ? installed.fulfilled : null
}

/**
 * Number of request interceptors installed on the SDK instance — exposed for
 * tests asserting repeated initialization never stacks handlers.
 */
export function installedSdkHttpInterceptors(): number {
  return (
    http.interceptors.request.handlers?.filter((h) => h !== null && h !== undefined).length ?? 0
  )
}
