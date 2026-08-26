/**
 * The read-only PROVIDER DIRECTORY — a pre-fill catalog of well-known upstreams and
 * their per-vendor endpoints, plus the base-URL sanity check both the console and
 * the server probe apply.
 *
 * A template is a STARTING POINT, never a constraint: creating a provider from one
 * copies its endpoints into an ordinary editable record, and nothing at runtime ever
 * reads the template again (`ModelProvider.template` is informational). That is why
 * this lives in `shared/` as a plain constant rather than in the wire contract or a
 * database table — an endpoint that moves is a documentation fix, not a migration.
 *
 * MAINTENANCE: these URLs are transcribed from each vendor's public documentation and
 * must be re-verified against a live account before a release — a template that
 * pre-fills a wrong endpoint costs the user a confusing auth failure. Deliberately
 * NO model ids are listed: model catalogs churn far faster than endpoints, and a
 * stale suggestion is worse than an empty field the user fills in once.
 */
import type { VendorId } from './protocol.js'

/** One template's endpoint for a single vendor. Mirrors `ProviderConnection`'s shape. */
export interface ProviderTemplateConnection {
  baseUrl: string
  /** Codex-only wire protocol; omitted for other vendors. */
  wireApi?: 'responses' | 'chat'
}

/** One entry of the provider directory. */
export interface ProviderTemplate {
  /** Stable template id — persisted on the created provider as `template`. */
  id: string
  /** Directory display name; the created provider's initial `displayName`. */
  displayName: string
  /** Per-vendor endpoints this upstream serves. A vendor absent here has no known endpoint. */
  connections: Partial<Record<VendorId, ProviderTemplateConnection>>
  /** Where the endpoints were transcribed from — the page to re-check on maintenance. */
  docs?: string
}

/**
 * The directory itself. Ordered as the console lists it: first-party vendors first,
 * then third-party gateways alphabetically.
 *
 * `cursor` never appears: it authenticates only through its own CLI login, so it can
 * neither reference a provider nor be pointed at a third-party endpoint.
 */
export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    connections: { claude: { baseUrl: 'https://api.anthropic.com' } },
    docs: 'https://docs.anthropic.com/en/api/overview',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    connections: { codex: { baseUrl: 'https://api.openai.com/v1', wireApi: 'responses' } },
    docs: 'https://platform.openai.com/docs/api-reference',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    connections: {
      claude: { baseUrl: 'https://api.deepseek.com/anthropic' },
      codex: { baseUrl: 'https://api.deepseek.com/v1', wireApi: 'chat' },
    },
    docs: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot (Kimi)',
    connections: {
      claude: { baseUrl: 'https://api.moonshot.cn/anthropic' },
      codex: { baseUrl: 'https://api.moonshot.cn/v1', wireApi: 'chat' },
    },
    docs: 'https://platform.moonshot.cn/docs',
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu (GLM)',
    connections: {
      claude: { baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
      codex: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', wireApi: 'chat' },
    },
    docs: 'https://docs.bigmodel.cn/',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    connections: { codex: { baseUrl: 'https://openrouter.ai/api/v1', wireApi: 'chat' } },
    docs: 'https://openrouter.ai/docs',
  },
]

/** Look up one template by id; undefined when the id is unknown (a hand-edited config). */
export function findProviderTemplate(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === id)
}

/**
 * What is structurally wrong with a base URL. Ordered by how the console reports it:
 * `error` arms block a save, `warning` arms only annotate the field.
 *
 *  - `empty`          — no URL at all: the connection is not usable.
 *  - `not-a-url`      — unparseable, or missing a host.
 *  - `bad-scheme`     — not http/https (the relay speaks HTTP only).
 *  - `has-query`      — carries a query string or fragment; the relay appends its own
 *                       path (`/v1/messages`, `/responses`), so anything after the
 *                       path is silently lost and the user should know.
 *  - `insecure`       — plain http to a non-loopback host: the API key would cross the
 *                       network in clear text. A warning, not an error — a private LAN
 *                       gateway is a legitimate setup.
 */
export type BaseUrlIssue = 'empty' | 'not-a-url' | 'bad-scheme' | 'has-query' | 'insecure'

/** The check's verdict: `null` issue ⇒ structurally fine. */
export interface BaseUrlCheck {
  issue: BaseUrlIssue | null
  severity: 'error' | 'warning' | null
}

/** Hosts where plain http is normal rather than a leak. */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/**
 * Structural check for a provider base URL — the cheap half of "is this connection
 * going to work", run on every keystroke in the console and again before a live
 * probe. It never touches the network; a URL that passes may still be unreachable.
 */
export function checkProviderBaseUrl(baseUrl: string): BaseUrlCheck {
  const trimmed = baseUrl.trim()
  if (!trimmed) return { issue: 'empty', severity: 'error' }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { issue: 'not-a-url', severity: 'error' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { issue: 'bad-scheme', severity: 'error' }
  }
  if (!url.hostname) return { issue: 'not-a-url', severity: 'error' }
  if (url.search || url.hash) return { issue: 'has-query', severity: 'warning' }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    return { issue: 'insecure', severity: 'warning' }
  }
  return { issue: null, severity: null }
}
