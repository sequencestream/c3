/**
 * `settings` feature handlers — slice 1/3 (ADR-0009).
 */
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import type { Handler } from '../../transport/handler-registry.js'

export const getSettings: Handler<'get_settings'> = (_ctx, conn) => {
  conn.send({ type: 'settings', settings: loadSettings() })
}

export const saveSettingsHandler: Handler<'save_settings'> = (_ctx, conn, msg) => {
  conn.send({ type: 'settings', settings: saveSettings(msg.settings) })
}
