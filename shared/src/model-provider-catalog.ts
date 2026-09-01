/**
 * The read-only PROVIDER DIRECTORY — the upstreams c3 knows by name: their per-protocol
 * endpoints, the model ids each one currently serves, and the base-URL sanity check both
 * the console and the server probe apply.
 *
 * A TEMPLATE is a STARTING POINT for creating a provider: it copies endpoints into an
 * ordinary editable record and is never consulted again at runtime
 * (`ModelProvider.template` is creation provenance). Each template also names the Model
 * Vendor it speaks to, which is what the created provider starts out identifying as.
 *
 * The vendor directory and its model catalogs live next door in `model-vendor-catalog.ts`
 * — that file is release-maintained data, this one is endpoints and the merge rule.
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
 * MAINTENANCE: every URL here is transcribed from the vendor's public documentation and must
 * be re-verified against a live account before a release — a wrong endpoint costs the user a
 * confusing auth failure. A vendor whose base URL could not be verified gets a directory
 * identity but NO template: an absent preset costs one paste, a wrong one costs a debugging
 * session. Templates only prefill the protocol slot whose dialect the endpoint actually
 * speaks, so an OpenAI-compatible upstream never seeds the anthropic slot.
 */
import type { ModelProvider, ModelProviderModel, ProtocolType } from './protocol.js'
import type { ModelVendorId } from './model-vendor-catalog.js'
import { modelVendorModels } from './model-vendor-catalog.js'

/** One entry of the provider directory. */
export interface ProviderTemplate {
  /** Stable template id — persisted on the created provider as `template`. */
  id: string
  /** Model Vendor this preset speaks to; the created provider's initial `vendor`. */
  vendor: ModelVendorId
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
    // The China endpoint. Z.AI's global host (api.z.ai) and both Coding Plan paths are
    // separate subscriptions, so they stay a manual edit rather than four near-identical
    // presets.
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
    // DashScope's OpenAI-compatible mode (China). The Coding Plan and Token Plan hosts are
    // separate subscriptions; the global host swaps in `dashscope-intl`.
    id: 'qwen',
    vendor: 'qwen',
    displayName: 'Qwen (Alibaba DashScope)',
    urls: { openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    wireApi: 'chat',
    docs: 'https://help.aliyun.com/zh/model-studio/',
  },
  {
    // MiniMax publishes an Anthropic-compatible endpoint, so this preset fills the
    // anthropic slot rather than the openai one. The China host is api.minimaxi.com.
    id: 'minimax',
    vendor: 'minimax',
    displayName: 'MiniMax',
    urls: { anthropic: 'https://api.minimax.io/anthropic' },
    docs: 'https://platform.minimax.io/docs',
  },
  {
    // Pay-as-you-go host. The Token Plan endpoints are per-region subscriptions.
    id: 'xiaomi',
    vendor: 'xiaomi',
    displayName: 'Xiaomi (MiMo)',
    urls: { openai: 'https://api.xiaomimimo.com/v1' },
    wireApi: 'chat',
    docs: 'https://platform.xiaomimimo.com/docs',
  },
  {
    id: 'tencent',
    vendor: 'tencent',
    displayName: 'Tencent (Hunyuan TokenHub)',
    urls: { openai: 'https://tokenhub.tencentmaas.com/v1' },
    wireApi: 'chat',
    docs: 'https://cloud.tencent.com/document/product/1729',
  },
  {
    id: 'qianfan',
    vendor: 'qianfan',
    displayName: 'Baidu Qianfan (ERNIE)',
    urls: { openai: 'https://qianfan.baidubce.com/v2' },
    wireApi: 'chat',
    docs: 'https://cloud.baidu.com/doc/qianfan-api/index.html',
  },
  {
    id: 'stepfun',
    vendor: 'stepfun',
    displayName: 'StepFun',
    urls: { openai: 'https://api.stepfun.com/v1' },
    wireApi: 'chat',
    docs: 'https://platform.stepfun.com/docs',
  },
  {
    id: 'longcat',
    vendor: 'longcat',
    displayName: 'LongCat',
    urls: { openai: 'https://api.longcat.chat/openai' },
    wireApi: 'chat',
    docs: 'https://longcat.chat/platform/docs',
  },
  {
    id: 'xai',
    vendor: 'xai',
    displayName: 'xAI (Grok)',
    urls: { openai: 'https://api.x.ai/v1' },
    wireApi: 'chat',
    docs: 'https://docs.x.ai/docs/api-reference',
  },
  {
    id: 'mistral',
    vendor: 'mistral',
    displayName: 'Mistral',
    urls: { openai: 'https://api.mistral.ai/v1' },
    wireApi: 'chat',
    docs: 'https://docs.mistral.ai/api/',
  },
  {
    // Cohere's native API is not OpenAI-shaped; the compatibility path is.
    id: 'cohere',
    vendor: 'cohere',
    displayName: 'Cohere',
    urls: { openai: 'https://api.cohere.ai/compatibility/v1' },
    wireApi: 'chat',
    docs: 'https://docs.cohere.com/docs/compatibility-api',
  },
  {
    id: 'groq',
    vendor: 'groq',
    displayName: 'Groq',
    urls: { openai: 'https://api.groq.com/openai/v1' },
    wireApi: 'chat',
    docs: 'https://console.groq.com/docs/openai',
  },
  {
    id: 'cerebras',
    vendor: 'cerebras',
    displayName: 'Cerebras',
    urls: { openai: 'https://api.cerebras.ai/v1' },
    wireApi: 'chat',
    docs: 'https://inference-docs.cerebras.ai/',
  },
  {
    id: 'together',
    vendor: 'together',
    displayName: 'Together AI',
    urls: { openai: 'https://api.together.xyz/v1' },
    wireApi: 'chat',
    docs: 'https://docs.together.ai/docs/openai-api-compatibility',
  },
  {
    id: 'fireworks',
    vendor: 'fireworks',
    displayName: 'Fireworks',
    urls: { openai: 'https://api.fireworks.ai/inference/v1' },
    wireApi: 'chat',
    docs: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility',
  },
  {
    id: 'novita',
    vendor: 'novita',
    displayName: 'NovitaAI',
    urls: { openai: 'https://api.novita.ai/openai/v1' },
    wireApi: 'chat',
    docs: 'https://novita.ai/docs/api-reference',
  },
  {
    id: 'nvidia',
    vendor: 'nvidia',
    displayName: 'NVIDIA',
    urls: { openai: 'https://integrate.api.nvidia.com/v1' },
    wireApi: 'chat',
    docs: 'https://docs.api.nvidia.com/',
  },
  {
    id: 'openrouter',
    vendor: 'openrouter',
    displayName: 'OpenRouter',
    urls: { openai: 'https://openrouter.ai/api/v1' },
    wireApi: 'chat',
    docs: 'https://openrouter.ai/docs',
  },
  {
    // Local runtimes listen on loopback, so the default ports are the whole preset. The
    // base-URL check treats plain http to loopback as normal rather than a leaked key.
    id: 'lmstudio',
    vendor: 'lmstudio',
    displayName: 'LM Studio (local)',
    urls: { openai: 'http://localhost:1234/v1' },
    wireApi: 'chat',
    docs: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
  },
  {
    id: 'vllm',
    vendor: 'vllm',
    displayName: 'vLLM (local)',
    urls: { openai: 'http://127.0.0.1:8000/v1' },
    wireApi: 'chat',
    docs: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
  },
  {
    id: 'sglang',
    vendor: 'sglang',
    displayName: 'SGLang (local)',
    urls: { openai: 'http://127.0.0.1:30000/v1' },
    wireApi: 'chat',
    docs: 'https://docs.sglang.ai/backend/openai_api_completions.html',
  },
]

/** Look up one template by id; undefined when the id is unknown (a hand-edited config). */
export function findProviderTemplate(id: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.id === id)
}

/**
 * The Model Vendor a template creates its provider with. Unknown / blank template ⇒
 * `custom`: identity is inferred from the template id alone, never from a display name or
 * a URL, so a hand-named "DeepSeek proxy" is not silently given DeepSeek's model list.
 */
export function modelVendorForTemplate(templateId: string | undefined): ModelVendorId {
  return findProviderTemplate((templateId ?? '').trim())?.vendor ?? 'custom'
}

/**
 * One provider's effective model suggestions: its Model Vendor's shipped models followed by its
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
  for (const model of [...modelVendorModels(provider.vendor), ...(provider.models ?? [])]) {
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
