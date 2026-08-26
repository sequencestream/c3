/**
 * Model-provider maintenance handlers: the inline-config migration and the
 * connection probe.
 *
 * Provider CRUD is deliberately absent — a provider is a field of `SystemSettings`,
 * so creating, editing and deleting one already travels through `save_settings`
 * like every other setting. Adding a parallel CRUD surface would give the registry
 * two write paths with two normalizations. What needs its own handler is what the
 * console CANNOT do from a settings document: recompute the migration report
 * (a server-side rule over the whole registry) and dial an endpoint from the
 * server (the browser cannot, and the stored key must not travel to it).
 */
import type { ModelProvider, VendorId } from '@ccc/shared/protocol'
import { checkProviderBaseUrl } from '@ccc/shared'
import {
  applyProviderMigration,
  clearInlineConnections,
  planProviderMigration,
  revertProviderMigration,
} from '../../kernel/agent-config/provider-migration.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'
import { settingsFrame } from './index.js'

/**
 * Run one migration action and reply with the report as it stands AFTERWARDS.
 * `plan` writes nothing; the other three persist through `saveSettings` (so the
 * usual normalization applies) and additionally echo `settings`, which is the
 * message every settings consumer already listens to.
 */
export const providerMigrationHandler: Handler<'provider_migration'> = (_ctx, conn, msg) => {
  // Writes agents and providers — the same administrator gate as `save_settings`.
  if (!requireAdmin(conn)) return
  const current = loadSettings()

  let next = current
  switch (msg.action) {
    case 'plan':
      break
    case 'apply':
      next = applyProviderMigration(current, msg.providerIds).settings
      break
    case 'revert':
      next = revertProviderMigration(current, msg.providerIds)
      break
    case 'clear':
      next = clearInlineConnections(current, msg.agentIds)
      break
  }

  const changed = next !== current
  const saved = changed ? saveSettings(next) : current
  conn.send({
    type: 'provider_migration_plan',
    plan: planProviderMigration(saved.agents, saved.modelProviders ?? []),
    changed,
  })
  if (changed) conn.send(settingsFrame(saved))
}

/** How long a probe waits before calling the endpoint unreachable. */
const PROBE_TIMEOUT_MS = 6000

/**
 * The effective connection to dial: a saved provider's (so its key stays server-side)
 * or the draft the console sent. Returns null when a named provider or its vendor
 * connection does not exist — the caller turns that into a structural verdict rather
 * than dialling something arbitrary.
 */
function probeTarget(
  providers: readonly ModelProvider[],
  vendor: VendorId,
  providerId: string | undefined,
  draftBaseUrl: string | undefined,
  draftApiKey: string | undefined,
): { baseUrl: string; apiKey: string } | null {
  if (providerId) {
    const provider = providers.find((p) => p.id === providerId)
    const conn = provider?.connections[vendor]
    if (!provider || !conn) return null
    return { baseUrl: conn.baseUrl, apiKey: conn.apiKey ?? provider.apiKey }
  }
  if (!draftBaseUrl) return null
  return { baseUrl: draftBaseUrl, apiKey: draftApiKey ?? '' }
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
  // Reads a stored credential and dials an operator-supplied URL from the server.
  if (!requireAdmin(conn)) return
  const { vendor, providerId } = msg
  const settings = loadSettings()
  const target = probeTarget(
    settings.modelProviders ?? [],
    vendor,
    providerId,
    msg.baseUrl,
    msg.apiKey,
  )
  if (!target) {
    conn.send({
      type: 'model_provider_probe_result',
      vendor,
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
      vendor,
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
    const resp = await fetch(target.baseUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'follow',
    })
    conn.send({
      type: 'model_provider_probe_result',
      vendor,
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
      vendor,
      ...(providerId ? { providerId } : {}),
      reachable: false,
      error: controller.signal.aborted ? `timeout after ${PROBE_TIMEOUT_MS}ms` : error,
      latencyMs: Date.now() - started,
    })
  } finally {
    clearTimeout(timer)
  }
}
