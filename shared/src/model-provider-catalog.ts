/**
 * The read-only PROVIDER DIRECTORY — the upstreams c3 knows by name: their per-protocol
 * endpoints, the model ids each one currently serves, and the base-URL sanity check both
 * the console and the server probe apply.
 *
 * Two different things live here, and they are deliberately not the same field:
 *
 *  - A TEMPLATE is a STARTING POINT for creating a provider. It copies endpoints into an
 *    ordinary editable record and is never consulted again at runtime
 *    (`ModelProvider.template` is creation provenance).
 *  - A PROVIDER VENDOR is the provider's declared upstream identity
 *    (`ModelProvider.vendor`). It is read continuously — it selects which shipped model
 *    ids this provider suggests — and stays editable on its own, so a hand-built endpoint
 *    can identify with a known vendor without having its connection fields reset.
 *
 * That is why this lives in `shared/` as a plain constant rather than in the wire contract
 * or a database table — an endpoint that moves, or a model that ships, is a documentation
 * fix, not a migration. Nothing here is fetched at runtime: suggestions are deterministic,
 * available offline, and cost no credentials.
 *
 * Suggestions are ADVISORY. Never validation, never a runtime fallback, never an allowlist —
 * any model id can be typed by hand and saved unchanged, which is also the escape hatch for
 * a catalog that has fallen behind an upstream release.
 *
 * MAINTENANCE: every URL and model id here is transcribed from the vendor's public
 * documentation and must be re-verified against a live account before a release — a wrong
 * endpoint costs the user a confusing auth failure, and a retired model id costs them a 404.
 * Shipped models carry no capability metadata (`contextWindow` / `maxOutputTokens`) on
 * purpose: a guessed window larger than the real one makes upstreams truncate or error, so
 * those numbers stay with the operator, who declares them on the provider's own entries.
 */
import type { ModelProvider, ModelProviderModel, ProtocolType } from './protocol.js'

/**
 * Stable Provider Vendor ids — the value space of `ModelProvider.vendor`. `custom` is the
 * catch-all every provider lands on when it names no vendor c3 knows; it is a legitimate
 * choice, not an error state.
 *
 * Distinct from `VendorId` (`claude` / `codex` / `cursor`), which selects the agent
 * executable c3 launches.
 */
export type ProviderVendorId =
  'anthropic' | 'openai' | 'deepseek' | 'moonshot' | 'doubao' | 'zhipu' | 'openrouter' | 'custom'

/** One entry of the Provider Vendor selector. */
export interface ProviderVendor {
  id: ProviderVendorId
  /** Selector label; carries the consumer-facing brand where it differs from the company name. */
  displayName: string
}

/** Every Provider Vendor, in selector order: first-party model vendors, gateway, then `custom`. */
export const PROVIDER_VENDORS = [
  { id: 'anthropic', displayName: 'Anthropic' },
  { id: 'openai', displayName: 'OpenAI (ChatGPT)' },
  { id: 'deepseek', displayName: 'DeepSeek' },
  { id: 'moonshot', displayName: 'Moonshot (Kimi)' },
  { id: 'doubao', displayName: 'Doubao (Volcengine Ark)' },
  { id: 'zhipu', displayName: 'Zhipu (GLM)' },
  { id: 'openrouter', displayName: 'OpenRouter' },
  { id: 'custom', displayName: 'Custom' },
] as const satisfies readonly ProviderVendor[]

type _PinVendorsCoverUnion =
  Exclude<ProviderVendorId, (typeof PROVIDER_VENDORS)[number]['id']> extends never
    ? true
    : [
        'PROVIDER_VENDORS is missing a ProviderVendorId',
        Exclude<ProviderVendorId, (typeof PROVIDER_VENDORS)[number]['id']>,
      ]
const _pinVendorsCoverUnion: _PinVendorsCoverUnion = true
void _pinVendorsCoverUnion

/**
 * Coerce anything persisted in the `vendor` slot to a known id. A blank, unknown, or
 * non-string value — including a vendor id minted by a NEWER c3 than this build — becomes
 * `custom`, so a provider degrades to "no shipped suggestions" instead of being dropped.
 */
export function normalizeProviderVendor(value: unknown): ProviderVendorId {
  if (typeof value !== 'string') return 'custom'
  const id = value.trim()
  return PROVIDER_VENDORS.some((v) => v.id === id) ? (id as ProviderVendorId) : 'custom'
}

/** Look up one vendor's label; `custom` for an unknown id, so this never returns undefined. */
export function providerVendorLabel(vendor: unknown): string {
  const id = normalizeProviderVendor(vendor)
  return PROVIDER_VENDORS.find((v) => v.id === id)!.displayName
}

/** One entry of the provider directory. */
export interface ProviderTemplate {
  /** Stable template id — persisted on the created provider as `template`. */
  id: string
  /** Provider Vendor this preset speaks to; the created provider's initial `vendor`. */
  vendor: ProviderVendorId
  /** Directory display name; the created provider's initial `displayName`. */
  displayName: string
  /** Per-protocol base URLs this upstream serves. A protocol absent here has no known endpoint. */
  urls: Partial<Record<ProtocolType, string>>
  /** OpenAI-slot wire dialect; omitted when the template has no openai URL. */
  wireApi?: 'responses' | 'chat'
  /** Where the endpoints were transcribed from — the page to re-check on maintenance. */
  docs?: string
}

/**
 * The directory itself. Ordered as the console lists it: first-party vendors first,
 * then third-party gateways alphabetically.
 */
export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = [
  {
    id: 'anthropic',
    vendor: 'anthropic',
    displayName: 'Anthropic',
    urls: { anthropic: 'https://api.anthropic.com' },
    docs: 'https://docs.anthropic.com/en/api/overview',
  },
  {
    id: 'openai',
    vendor: 'openai',
    displayName: 'OpenAI',
    urls: { openai: 'https://api.openai.com/v1' },
    wireApi: 'responses',
    docs: 'https://platform.openai.com/docs/api-reference',
  },
  {
    id: 'deepseek',
    vendor: 'deepseek',
    displayName: 'DeepSeek',
    urls: {
      openai: 'https://api.deepseek.com',
      anthropic: 'https://api.deepseek.com/anthropic',
    },
    wireApi: 'chat',
    docs: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'moonshot',
    vendor: 'moonshot',
    displayName: 'Moonshot (Kimi)',
    urls: {
      openai: 'https://api.moonshot.cn/v1',
      anthropic: 'https://api.moonshot.cn/anthropic',
    },
    wireApi: 'chat',
    docs: 'https://platform.moonshot.cn/docs',
  },
  {
    // Volcengine Ark's general endpoint. Ark serves a native `/responses` API, so the
    // relay passes through rather than translating Responses→Chat. Deliberately no
    // anthropic URL: product-specific endpoints such as the Volcengine Coding Plan carry
    // their own subscription and routing semantics and stay manually configured rather
    // than being mixed into this generic preset.
    id: 'doubao',
    vendor: 'doubao',
    displayName: 'Doubao (Volcengine Ark)',
    urls: { openai: 'https://ark.cn-beijing.volces.com/api/v3' },
    wireApi: 'responses',
    docs: 'https://www.volcengine.com/docs/82379/1795150',
  },
  {
    id: 'zhipu',
    vendor: 'zhipu',
    displayName: 'Zhipu (GLM)',
    urls: {
      openai: 'https://open.bigmodel.cn/api/paas/v4',
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
    },
    wireApi: 'chat',
    docs: 'https://docs.bigmodel.cn/',
  },
  {
    id: 'openrouter',
    vendor: 'openrouter',
    displayName: 'OpenRouter',
    urls: { openai: 'https://openrouter.ai/api/v1' },
    wireApi: 'chat',
    docs: 'https://openrouter.ai/docs',
  },
]

/** Look up one template by id; undefined when the id is unknown (a hand-edited config). */
export function findProviderTemplate(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === id)
}

/**
 * The Provider Vendor a template creates its provider with. Unknown / blank template ⇒
 * `custom`: identity is inferred from the template id alone, never from a display name or
 * a URL, so a hand-named "DeepSeek proxy" is not silently given DeepSeek's model list.
 */
export function providerVendorForTemplate(templateId: string | undefined): ProviderVendorId {
  return findProviderTemplate((templateId ?? '').trim())?.vendor ?? 'custom'
}

/**
 * The models each Provider Vendor currently serves — conversational models callable through
 * the preset's endpoint only, so no image, video, or embedding products. Ordered most-capable
 * first, which is the order the console offers them in.
 *
 * `openrouter` ships empty on purpose: it is a gateway onto hundreds of `author/model` ids
 * from every other vendor, and any subset c3 picked would mislead more than it helped. Its
 * providers fall back to free-form entry and their own model entries, like `custom`.
 */
export const PROVIDER_VENDOR_MODELS: Readonly<
  Record<ProviderVendorId, readonly ModelProviderModel[]>
> = {
  anthropic: [
    { id: 'claude-fable-5' },
    { id: 'claude-opus-5' },
    { id: 'claude-sonnet-5' },
    { id: 'claude-haiku-4-5' },
  ],
  openai: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-luna' }],
  deepseek: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }],
  moonshot: [
    { id: 'kimi-k3' },
    { id: 'kimi-k2.7-code' },
    { id: 'kimi-k2.7-code-highspeed' },
    { id: 'kimi-k2.6' },
  ],
  doubao: [
    { id: 'doubao-seed-2-0-pro-260215' },
    { id: 'doubao-seed-2-0-code-preview-260215' },
    { id: 'doubao-seed-2-0-lite-260215' },
    { id: 'doubao-seed-2-0-mini-260215' },
  ],
  zhipu: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
  openrouter: [],
  custom: [],
}

/** The shipped models for a vendor id, coercing an unknown id to `custom` (⇒ empty). */
export function providerVendorModels(vendor: unknown): readonly ModelProviderModel[] {
  return PROVIDER_VENDOR_MODELS[normalizeProviderVendor(vendor)]
}

/**
 * One provider's effective model suggestions: its vendor's shipped models followed by its
 * own entries, de-duplicated by trimmed id. A persisted entry OVERRIDES the shipped one it
 * collides with — keeping the operator's capability metadata — but stays in the shipped
 * entry's position, so the list order depends only on the vendor and the provider's own
 * order, never on which of the two supplied a given id.
 *
 * Blank ids are dropped (the console creates an empty row before it is typed into). Entries
 * are copies: nothing a caller does can mutate the shipped constant.
 *
 * ADVISORY ONLY — this list never validates, restricts, or defaults an agent's model.
 */
export function effectiveProviderModels(
  provider: Pick<ModelProvider, 'vendor' | 'models'>,
): ModelProviderModel[] {
  const out: ModelProviderModel[] = []
  const at = new Map<string, number>()
  for (const model of [...providerVendorModels(provider.vendor), ...(provider.models ?? [])]) {
    const id = model.id.trim()
    if (!id) continue
    const seen = at.get(id)
    if (seen === undefined) {
      at.set(id, out.length)
      out.push({ ...model, id })
    } else {
      out[seen] = { ...model, id }
    }
  }
  return out
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
