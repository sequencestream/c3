/**
 * The MODEL VENDOR DIRECTORY — every upstream c3 knows by name, and the model ids each one
 * currently serves. This is the release-maintained data file: it holds no logic beyond three
 * lookups, so adding a vendor or refreshing a model list is a one-place edit.
 *
 * A Model Vendor is a provider's declared upstream identity (`ModelProvider.vendor`). It is
 * read continuously — it selects the shipped model suggestions offered for that provider —
 * and is editable on its own, separate from the endpoint TEMPLATE that created the record
 * (see `model-provider-catalog.ts`). A hand-built endpoint can therefore identify with a
 * known vendor without adopting its URLs.
 *
 * Distinct from `VendorId` (`claude` / `codex` / `cursor`), which selects the agent
 * executable c3 launches. A Model Vendor says whose models are on the other end of the wire.
 *
 * Suggestions are ADVISORY. Never validation, never a runtime fallback, never an allowlist —
 * any model id can be typed by hand and saved unchanged, which is also the escape hatch for
 * a catalog that has fallen behind an upstream release.
 *
 * MAINTENANCE: every model id here is transcribed from the vendor's published catalog and
 * must be re-verified before a release — a retired id costs the user a 404. Ids are written
 * exactly as the upstream API expects them in the `model` request field, so an aggregator's
 * namespaced ids keep their slashes (`meta-llama/Llama-3.3-70B-Instruct-Turbo`) while a
 * first-party vendor's do not. A vendor whose catalog could not be verified ships EMPTY
 * rather than guessed: an empty list costs a free-text entry, a wrong list costs a failed run.
 *
 * Entries carry no capability metadata (`contextWindow` / `maxOutputTokens`) on purpose: a
 * guessed window larger than the real one makes upstreams truncate or error, so those numbers
 * stay with the operator, who declares them on the provider's own model entries.
 */
import type { ModelProviderModel } from './protocol.js'

/**
 * Stable Model Vendor ids — the value space of `ModelProvider.vendor`. `custom` is the
 * catch-all every provider lands on when it names no vendor c3 knows; it is a legitimate
 * choice, not an error state.
 *
 * Ids are permanent once shipped: they are persisted on provider records, so a rename would
 * silently reset those providers to `custom`.
 */
export type ModelVendorId =
  // First-party model vendors.
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'mistral'
  | 'cohere'
  | 'deepseek'
  | 'moonshot'
  | 'doubao'
  | 'zhipu'
  | 'qwen'
  | 'minimax'
  | 'xiaomi'
  | 'tencent'
  | 'qianfan'
  | 'stepfun'
  | 'longcat'
  | 'arcee'
  | 'byteplus'
  | 'venice'
  // Inference clouds and model marketplaces.
  | 'groq'
  | 'cerebras'
  | 'together'
  | 'fireworks'
  | 'novita'
  | 'nvidia'
  | 'deepinfra'
  | 'huggingface'
  | 'baseten'
  | 'chutes'
  | 'featherless'
  | 'gmi'
  | 'synthetic'
  | 'bedrock'
  | 'gradium'
  | 'vydra'
  | 'inferrs'
  // Gateways that route to other vendors' models.
  | 'openrouter'
  | 'litellm'
  | 'vercel-ai-gateway'
  | 'cloudflare-ai-gateway'
  | 'clawrouter'
  | 'github-copilot'
  | 'kilocode'
  | 'opencode'
  // Runtimes serving models from the operator's own machine.
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  | 'sglang'
  | 'custom'

/**
 * How the selector groups vendors. Purely presentational — grouping never changes which
 * models a vendor offers, and a vendor's group is not persisted anywhere.
 */
export type ModelVendorGroup = 'model' | 'cloud' | 'gateway' | 'local' | 'custom'

/** One entry of the model vendor directory. */
export interface ModelVendor {
  id: ModelVendorId
  /** Selector label; carries the consumer-facing brand where it differs from the company name. */
  displayName: string
  /** Which selector group this vendor is listed under. */
  group: ModelVendorGroup
  /**
   * The model ids this vendor serves, most-capable first. Empty ⇒ c3 ships no verified
   * catalog for it; the provider then offers only its own entries plus free-text input.
   */
  models: readonly ModelProviderModel[]
}

/**
 * The directory itself, in selector order: first-party model vendors, inference clouds,
 * gateways, local runtimes, then the `custom` catch-all.
 */
export const MODEL_VENDORS = [
  // ---- First-party model vendors ----
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    group: 'model',
    models: [
      { id: 'claude-fable-5' },
      { id: 'claude-opus-5' },
      { id: 'claude-sonnet-5' },
      { id: 'claude-haiku-4-5' },
    ],
  },
  {
    id: 'openai',
    displayName: 'OpenAI (ChatGPT)',
    group: 'model',
    models: [
      { id: 'gpt-5.6-sol' },
      { id: 'gpt-5.6-terra' },
      { id: 'gpt-5.6-luna' },
      { id: 'gpt-5.5' },
    ],
  },
  {
    id: 'google',
    displayName: 'Google (Gemini)',
    group: 'model',
    models: [
      { id: 'gemini-3.1-pro-preview' },
      { id: 'gemini-3.5-flash' },
      { id: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash' },
    ],
  },
  {
    id: 'xai',
    displayName: 'xAI (Grok)',
    group: 'model',
    models: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }, { id: 'grok-4.3' }, { id: 'grok-build-0.1' }],
  },
  {
    id: 'mistral',
    displayName: 'Mistral',
    group: 'model',
    models: [
      { id: 'mistral-large-latest' },
      { id: 'mistral-medium-3-5' },
      { id: 'mistral-small-latest' },
      { id: 'devstral-medium-latest' },
      { id: 'codestral-latest' },
    ],
  },
  {
    id: 'cohere',
    displayName: 'Cohere',
    group: 'model',
    models: [
      { id: 'command-a-plus-05-2026' },
      { id: 'command-a-reasoning-08-2025' },
      { id: 'command-a-03-2025' },
      { id: 'north-mini-code-1-0' },
    ],
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    group: 'model',
    models: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }],
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot (Kimi)',
    group: 'model',
    models: [
      { id: 'kimi-k3' },
      { id: 'kimi-k2.7-code' },
      { id: 'kimi-k2.7-code-highspeed' },
      { id: 'kimi-k2.6' },
    ],
  },
  {
    id: 'doubao',
    displayName: 'Doubao (Volcengine Ark)',
    group: 'model',
    models: [
      { id: 'doubao-seed-2-0-pro-260215' },
      { id: 'doubao-seed-2-0-code-preview-260215' },
      { id: 'doubao-seed-2-0-lite-260215' },
      { id: 'doubao-seed-2-0-mini-260215' },
    ],
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu / Z.AI (GLM)',
    group: 'model',
    models: [
      { id: 'glm-5.3' },
      { id: 'glm-5.3-flash' },
      { id: 'glm-5.2' },
      { id: 'glm-5.1' },
      { id: 'glm-5-turbo' },
    ],
  },
  {
    id: 'qwen',
    displayName: 'Qwen (Alibaba DashScope)',
    group: 'model',
    models: [
      { id: 'qwen3.8-max' },
      { id: 'qwen3.8-flash' },
      { id: 'qwen3.7-max' },
      { id: 'qwen3.7-plus' },
      { id: 'qwen3-coder-next' },
      { id: 'qwen3-coder-plus' },
    ],
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    group: 'model',
    models: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }, { id: 'MiniMax-M2.7-highspeed' }],
  },
  {
    id: 'xiaomi',
    displayName: 'Xiaomi (MiMo)',
    group: 'model',
    models: [{ id: 'mimo-v2.5-pro' }, { id: 'mimo-v2.5' }],
  },
  {
    id: 'tencent',
    displayName: 'Tencent (Hunyuan)',
    group: 'model',
    models: [{ id: 'hy3' }, { id: 'hy3-preview' }],
  },
  {
    id: 'qianfan',
    displayName: 'Baidu Qianfan (ERNIE)',
    group: 'model',
    models: [
      { id: 'ernie-5.1' },
      { id: 'ernie-5.0' },
      { id: 'ernie-5.0-thinking-preview' },
      { id: 'deepseek-v4-pro' },
      { id: 'deepseek-v3.2' },
    ],
  },
  {
    id: 'stepfun',
    displayName: 'StepFun',
    group: 'model',
    models: [{ id: 'step-3.7-flash' }, { id: 'step-3.5-flash' }],
  },
  {
    id: 'longcat',
    displayName: 'LongCat',
    group: 'model',
    models: [{ id: 'LongCat-2.0' }],
  },
  {
    id: 'arcee',
    displayName: 'Arcee AI',
    group: 'model',
    models: [{ id: 'trinity-large-thinking' }],
  },
  { id: 'byteplus', displayName: 'BytePlus', group: 'model', models: [] },
  { id: 'venice', displayName: 'Venice', group: 'model', models: [] },

  // ---- Inference clouds and model marketplaces ----
  {
    id: 'groq',
    displayName: 'Groq',
    group: 'cloud',
    models: [
      { id: 'openai/gpt-oss-120b' },
      { id: 'openai/gpt-oss-20b' },
      { id: 'qwen/qwen3.6-27b' },
      { id: 'groq/compound' },
      { id: 'groq/compound-mini' },
    ],
  },
  {
    id: 'cerebras',
    displayName: 'Cerebras',
    group: 'cloud',
    models: [{ id: 'gemma-4-31b' }, { id: 'gpt-oss-120b' }],
  },
  {
    id: 'together',
    displayName: 'Together AI',
    group: 'cloud',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Pro' },
      { id: 'moonshotai/Kimi-K2.6' },
      { id: 'zai-org/GLM-5.2' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    ],
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks',
    group: 'cloud',
    models: [
      { id: 'accounts/fireworks/routers/glm-5p2-fast' },
      { id: 'accounts/fireworks/routers/kimi-k2p6-turbo' },
      { id: 'accounts/fireworks/models/kimi-k2p6' },
    ],
  },
  {
    id: 'novita',
    displayName: 'NovitaAI',
    group: 'cloud',
    models: [
      { id: 'moonshotai/kimi-k3' },
      { id: 'moonshotai/kimi-k2.7-code' },
      { id: 'deepseek/deepseek-v4-pro' },
      { id: 'deepseek/deepseek-v4-flash' },
      { id: 'minimax/minimax-m3' },
      { id: 'zai-org/glm-5.2' },
      { id: 'qwen/qwen3.7-max' },
    ],
  },
  {
    id: 'nvidia',
    displayName: 'NVIDIA',
    group: 'cloud',
    models: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b' },
      { id: 'nvidia/nemotron-3-super-120b-a12b' },
      { id: 'nvidia/nemotron-3.5-lightning-30b-a3b' },
      { id: 'deepseek-ai/deepseek-v4-pro' },
      { id: 'moonshotai/kimi-k2.6' },
      { id: 'minimaxai/minimax-m3' },
      { id: 'z-ai/glm-5.2' },
    ],
  },
  {
    id: 'deepinfra',
    displayName: 'DeepInfra',
    group: 'cloud',
    models: [{ id: 'deepseek-ai/DeepSeek-V4-Flash' }],
  },
  {
    id: 'huggingface',
    displayName: 'Hugging Face',
    group: 'cloud',
    models: [{ id: 'deepseek-ai/DeepSeek-R1' }],
  },
  {
    id: 'chutes',
    displayName: 'Chutes',
    group: 'cloud',
    models: [{ id: 'zai-org/GLM-5-TEE' }],
  },
  {
    id: 'featherless',
    displayName: 'Featherless AI',
    group: 'cloud',
    models: [{ id: 'Qwen/Qwen3-32B' }],
  },
  {
    id: 'gmi',
    displayName: 'GMI Cloud',
    group: 'cloud',
    models: [{ id: 'google/gemini-3.1-flash-lite' }],
  },
  { id: 'baseten', displayName: 'Baseten', group: 'cloud', models: [] },
  { id: 'synthetic', displayName: 'Synthetic', group: 'cloud', models: [] },
  { id: 'bedrock', displayName: 'Amazon Bedrock', group: 'cloud', models: [] },
  { id: 'gradium', displayName: 'Gradium', group: 'cloud', models: [] },
  { id: 'vydra', displayName: 'Vydra', group: 'cloud', models: [] },
  { id: 'inferrs', displayName: 'inferrs', group: 'cloud', models: [] },

  // ---- Gateways. Catalogs stay empty: a gateway fronts hundreds of `author/model` ids
  // from every other vendor, and any subset c3 picked would mislead more than it helped.
  { id: 'openrouter', displayName: 'OpenRouter', group: 'gateway', models: [] },
  { id: 'litellm', displayName: 'LiteLLM', group: 'gateway', models: [] },
  { id: 'vercel-ai-gateway', displayName: 'Vercel AI Gateway', group: 'gateway', models: [] },
  {
    id: 'cloudflare-ai-gateway',
    displayName: 'Cloudflare AI Gateway',
    group: 'gateway',
    models: [],
  },
  { id: 'clawrouter', displayName: 'ClawRouter', group: 'gateway', models: [] },
  { id: 'github-copilot', displayName: 'GitHub Copilot', group: 'gateway', models: [] },
  { id: 'kilocode', displayName: 'Kilocode', group: 'gateway', models: [] },
  { id: 'opencode', displayName: 'OpenCode', group: 'gateway', models: [] },

  // ---- Local runtimes. Catalogs stay empty by nature: the models are whatever the
  // operator has pulled onto that machine, which c3 cannot know without asking it.
  { id: 'ollama', displayName: 'Ollama', group: 'local', models: [] },
  { id: 'lmstudio', displayName: 'LM Studio', group: 'local', models: [] },
  { id: 'vllm', displayName: 'vLLM', group: 'local', models: [] },
  { id: 'sglang', displayName: 'SGLang', group: 'local', models: [] },

  { id: 'custom', displayName: 'Custom', group: 'custom', models: [] },
] as const satisfies readonly ModelVendor[]

type _PinVendorsCoverUnion =
  Exclude<ModelVendorId, (typeof MODEL_VENDORS)[number]['id']> extends never
    ? true
    : [
        'MODEL_VENDORS is missing a ModelVendorId',
        Exclude<ModelVendorId, (typeof MODEL_VENDORS)[number]['id']>,
      ]
const _pinVendorsCoverUnion: _PinVendorsCoverUnion = true
void _pinVendorsCoverUnion

/**
 * Coerce anything persisted in the `vendor` slot to a known id. A blank, unknown, or
 * non-string value — including a vendor id minted by a NEWER c3 than this build — becomes
 * `custom`, so a provider degrades to "no shipped suggestions" instead of being dropped.
 */
export function normalizeModelVendor(value: unknown): ModelVendorId {
  if (typeof value !== 'string') return 'custom'
  const id = value.trim()
  return MODEL_VENDORS.some((v) => v.id === id) ? (id as ModelVendorId) : 'custom'
}

/** One vendor's label; an unknown id reads as `custom`, so this never returns undefined. */
export function modelVendorLabel(vendor: unknown): string {
  const id = normalizeModelVendor(vendor)
  return MODEL_VENDORS.find((v) => v.id === id)!.displayName
}

/** The models c3 ships for a vendor id, coercing an unknown id to `custom` (⇒ empty). */
export function modelVendorModels(vendor: unknown): readonly ModelProviderModel[] {
  const id = normalizeModelVendor(vendor)
  return MODEL_VENDORS.find((v) => v.id === id)!.models
}
