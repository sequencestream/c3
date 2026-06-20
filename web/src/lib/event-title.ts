/**
 * Display title for a {@link WaitUserInvolveEvent} in the WorkCenter.
 *
 * Most events show their stored `title` or the gated `toolName`. The manual
 * Start-Dev Git/PR cleanup failure todo (toolName === `GIT_CLEANUP_EVENT_TOOL`)
 * has no human title and is not a real tool call: its `toolInput` carries a
 * {@link UiError} `{code, params}`, so we localize that here instead of showing
 * the raw sentinel. Keeps server payloads code-based (i18n on the client).
 */
import { GIT_CLEANUP_EVENT_TOOL, type WaitUserInvolveEvent } from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import { translateUiError } from '@/i18n/errors'

function isUiError(v: unknown): v is UiError {
  return typeof v === 'object' && v !== null && typeof (v as { code?: unknown }).code === 'string'
}

/**
 * Resolve the human-facing title for an event, with a `fallback` (typically the
 * source icon) when nothing else is available.
 */
export function eventDisplayTitle(event: WaitUserInvolveEvent, fallback: string): string {
  if (event.toolName === GIT_CLEANUP_EVENT_TOOL && isUiError(event.toolInput)) {
    return translateUiError(event.toolInput)
  }
  return event.title || event.toolName || fallback
}
