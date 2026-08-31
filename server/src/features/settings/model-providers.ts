/**
 * Model-provider maintenance handlers: the connection probe.
 *
 * Provider CRUD is deliberately absent — a provider is a field of `SystemSettings`,
 * so creating, editing and deleting one already travels through `save_settings`
 * like every other setting. Adding a parallel CRUD surface would give the registry
 * two write paths with two normalizations. What needs its own handler is what the
 * console CANNOT do from a settings document: dial an endpoint from the server
 * (the browser cannot, and the stored key must not travel to it).
 */
import type { ModelProvider, ProtocolType } from '@ccc/shared/protocol'
import { checkProviderBaseUrl } from '@ccc/shared'
import { loadSettings } from '../../kernel/config/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'

/** How long a probe waits before calling the endpoint unreachable. */
const PROBE_TIMEOUT_MS = 6000

/**
 * The effective URL to dial. Draft fields win when the console sent a `baseUrl`
 * — that is what lets an unsaved edit (or a brand-new provider not yet on disk)
 * be probed as typed. A draft URL is paired only with the draft key from the
 * same request; stored account keys are never sent to an operator-typed host.
 * A named `providerId` without a draft URL falls back to the stored protocol
 * slot and its stored key. Returns null when neither path yields a base URL.
 */
function probeTarget(
  providers: readonly ModelProvider[],
  protocolType: ProtocolType,
  providerId: string | undefined,
  draftBaseUrl: string | undefined,
  draftApiKey: string | undefined,
): { baseUrl: string; apiKey: string } | null {
  if (draftBaseUrl) {
    return { baseUrl: draftBaseUrl, apiKey: draftApiKey ?? '' }
  }
  if (providerId) {
    const provider = providers.find((p) => p.id === providerId)
    const baseUrl = provider?.urls[protocolType]?.trim()
    if (!provider || !baseUrl) return null
    return { baseUrl, apiKey: provider.apiKey }
  }
  return null
}

/**
 * Dial a provider endpoint and report whether it ANSWERS — not whether the key is
 * accepted. A 401/403 is a successful probe: it proves the URL reaches a real API,
 * which is the misconfiguration this catches (a typo'd host, a stale endpoint, a
 * gateway that moved). Key validity is left to the first real run, where the vendor's
 * own error message is far more informative than anything a synthetic request could
 * infer.
 *
 * The request is a bare GET against the base URL with the key attached in both
 * common header shapes, so an upstream that authorizes on either one answers rather
 * than stalling. Nothing is written and no model is invoked, so a probe never costs
 * the user tokens.
 */
export const probeModelProviderHandler: Handler<'probe_model_provider'> = async (
  _ctx,
  conn,
  msg,
) => {
  // Dials an operator-supplied or stored URL from the server; stored keys only
  // pair with stored URLs (see probeTarget).
  if (!requireAdmin(conn)) return
  const { protocolType, providerId } = msg
  const settings = loadSettings()
  const target = probeTarget(
    settings.modelProviders ?? [],
    protocolType,
    providerId,
    msg.baseUrl,
    msg.apiKey,
  )
  if (!target) {
    conn.send({
      type: 'model_provider_probe_result',
      protocolType,
      ...(providerId ? { providerId } : {}),
      reachable: false,
      issue: 'empty',
    })
    return
  }

  const structural = checkProviderBaseUrl(target.baseUrl)
  if (structural.severity === 'error') {
    conn.send({
      type: 'model_provider_probe_result',
      protocolType,
      ...(providerId ? { providerId } : {}),
      reachable: false,
      issue: structural.issue ?? 'not-a-url',
    })
    return
  }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (target.apiKey) {
      headers.authorization = `Bearer ${target.apiKey}`
      headers['x-api-key'] = target.apiKey
    }
    // 'manual': a misconfigured or malicious baseUrl's 30x must not carry the
    // Authorization / x-api-key headers on to a redirect target the operator never
    // typed. The redirect response's own status still answers "does this endpoint
    // exist" — this probe never needed to follow it.
    const resp = await fetch(target.baseUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'manual',
    })
    conn.send({
      type: 'model_provider_probe_result',
      protocolType,
      ...(providerId ? { providerId } : {}),
      reachable: true,
      status: resp.status,
      ...(structural.issue ? { issue: structural.issue } : {}),
      latencyMs: Date.now() - started,
    })
  } catch (err) {
    // The message may quote the URL but never the headers, so no key can leak here.
    const error = err instanceof Error ? err.message : String(err)
    conn.send({
      type: 'model_provider_probe_result',
      protocolType,
      ...(providerId ? { providerId } : {}),
      reachable: false,
      error: controller.signal.aborted ? `timeout after ${PROBE_TIMEOUT_MS}ms` : error,
      latencyMs: Date.now() - started,
    })
  } finally {
    clearTimeout(timer)
  }
}
