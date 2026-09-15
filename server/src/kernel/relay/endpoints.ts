/**
 * Provider base URL → concrete endpoint. Pure string work: no HTTP, no SDK, no IO,
 * so it sits in kernel and both callers share one rule set.
 *
 * Two callers with the same requirement. The relay (`transport/relay/`) resolves a
 * candidate's base to the endpoint it proxies an agent's traffic to; the model
 * provider speed test dials the SAME endpoint directly, and must land on exactly
 * the address a real run would use — a measurement taken against a differently
 * normalized URL would describe a path no agent takes. Hence one module rather
 * than a second copy of "does this base already carry /v1".
 *
 * Normalization is the operator's configured base plus the protocol's own suffix,
 * and nothing else: no host rewriting, no scheme upgrade, no discovery. Structural
 * validity is `checkProviderBaseUrl`'s job and is checked before these run.
 */

/**
 * Resolve a codex-native (Responses) provider base to its `/responses` endpoint.
 * A base that already ends in `/responses` is used as-is. `/v1` is never inserted:
 * a `…/v1` base yields `…/v1/responses`, and a base without a version segment is
 * taken at face value, because Responses gateways disagree about versioning and
 * inventing one produces a 404 the operator cannot see the cause of.
 */
export function responsesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/responses$/.test(trimmed)) return trimmed
  return `${trimmed}/responses`
}

/**
 * Resolve a provider base URL to its Chat Completions endpoint. The user configures
 * an OpenAI-style base (`https://api.deepseek.com/`, `https://api.moonshot.ai/v1`,
 * …); normalize to `<base>/chat/completions`, inserting `/v1` only when the base
 * does not already carry a version segment.
 */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(trimmed)) return trimmed
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/**
 * Resolve an anthropic-compat provider base to its Messages endpoint. The user
 * configures an anthropic gateway base (`https://api.deepseek.com/anthropic`); the
 * claude SDK would POST `<ANTHROPIC_BASE_URL>/v1/messages`, so mirror that shape
 * onto the real base.
 */
export function anthropicMessagesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/v1\/messages$/.test(trimmed)) return trimmed
  return `${trimmed}/v1/messages`
}
