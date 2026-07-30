/**
 * `personalized-setting` feature handlers — the third settings class, beside the
 * administrator-level system settings and the per-workspace settings.
 *
 * Authorization model: **no admin gate**. These are per-person preferences, so any
 * signed-in account changes its own without administrator authority. The account is
 * always the connection's server-verified `subject` — never a value the client sends
 * — so one account can neither read nor write another's record. The connection-level
 * auth gate still applies upstream: an unauthenticated connection on an auth-enabled
 * deployment never reaches these handlers.
 *
 * Without a subject (auth disabled, or a `none` provider) there is no account to
 * store under: the browser is the store, the server persists no shared record, and
 * the reply just echoes the normalized value the client reported.
 */
import type { Handler } from '../../transport/handler-registry.js'
import { resolvePersonalized, savePersonalizedFor } from '../../kernel/config/personalized.js'

export const getPersonalizedSettings: Handler<'get_personalized_settings'> = (_ctx, conn, msg) => {
  try {
    const settings = resolvePersonalized(conn.subject, msg.localFallback)
    conn.send({
      type: 'personalized_settings',
      settings,
      scope: conn.subject ? 'account' : 'local',
    })
  } catch {
    // Never answer a failed read with a pseudo-success snapshot: the client must
    // keep the value it already has rather than adopt a fabricated default.
    conn.send({ type: 'error', error: { code: 'personalizedSetting.loadFailed' } })
  }
}

export const savePersonalizedSettingsHandler: Handler<'save_personalized_settings'> = (
  _ctx,
  conn,
  msg,
) => {
  try {
    const settings = savePersonalizedFor(conn.subject, msg.settings)
    conn.send({
      type: 'personalized_settings',
      settings,
      scope: conn.subject ? 'account' : 'local',
    })
  } catch {
    // A failed write leaves the stored value untouched; the client keeps the
    // language it is already showing and surfaces the failure.
    conn.send({ type: 'error', error: { code: 'personalizedSetting.saveFailed' } })
  }
}
