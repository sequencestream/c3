/*
 * log-view.ts — the runtime-log viewer's model: what one polled chunk does to
 * the displayed buffer.
 *
 * Kept free of Vue and of the DOM so the rule is testable as plain data; the
 * page only holds the state and paints it. Whether the view follows the tail is
 * a scroll-metrics question the chat column already answers (`isNearBottom` in
 * `chat-scroll.ts`), so it is not restated here.
 *
 * The buffer is bounded on purpose. A tab left open for a day would otherwise
 * grow without limit, so the oldest lines are dropped once either cap is hit —
 * this viewer shows the live tail, it is not a log archive.
 */
import type { RuntimeLogChunk } from '@ccc/shared/protocol'

/** Poll cadence while the page is visible and focused. */
export const LOG_POLL_INTERVAL_MS = 3_000

/** Retained-line cap; the oldest lines are dropped past it. */
export const LOG_MAX_LINES = 5_000

/** Retained-character cap, so very long lines cannot defeat the line cap. */
export const LOG_MAX_CHARS = 1_000_000

export interface LogViewState {
  /** Complete lines, oldest first (without their trailing newline). */
  lines: string[]
  /** The trailing partial line, still waiting for its newline. */
  partial: string
  /** Byte offset to send on the next poll. */
  nextOffset: number
  /** Whether older lines have been dropped to honour the caps. */
  dropped: boolean
  /** Whether the server has a live log file at all. */
  available: boolean
}

export interface LogViewLimits {
  maxLines: number
  maxChars: number
}

export const DEFAULT_LOG_VIEW_LIMITS: LogViewLimits = {
  maxLines: LOG_MAX_LINES,
  maxChars: LOG_MAX_CHARS,
}

export function createLogViewState(): LogViewState {
  return { lines: [], partial: '', nextOffset: 0, dropped: false, available: true }
}

/**
 * Fold one polled chunk into the view state, returning a new state.
 *
 * A `reset` chunk replaces the buffer (first read, or the file rotated under
 * us); otherwise its text continues the trailing partial line. `dropped` is
 * sticky: once the viewer has thrown history away, it has thrown it away.
 */
export function applyLogChunk(
  state: LogViewState,
  chunk: RuntimeLogChunk,
  limits: LogViewLimits = DEFAULT_LOG_VIEW_LIMITS,
): LogViewState {
  if (!chunk.available) {
    return { ...createLogViewState(), available: false, dropped: state.dropped }
  }

  const base = chunk.reset
    ? { lines: [] as string[], partial: '' }
    : { lines: state.lines, partial: state.partial }

  const pieces = (base.partial + chunk.text).split('\n')
  const partial = pieces.pop() ?? ''
  const lines = pieces.length > 0 ? [...base.lines, ...pieces] : base.lines

  const capped = capLines(lines, limits)
  return {
    lines: capped.lines,
    partial,
    nextOffset: chunk.nextOffset,
    dropped: state.dropped || capped.dropped,
    available: true,
  }
}

/** Drop oldest lines until both caps hold. */
function capLines(lines: string[], limits: LogViewLimits): { lines: string[]; dropped: boolean } {
  let start = Math.max(0, lines.length - Math.max(1, limits.maxLines))
  let chars = 0
  // Walk back from the newest line, keeping as much as the char budget allows.
  for (let i = lines.length - 1; i >= start; i--) {
    chars += lines[i].length + 1
    if (chars > limits.maxChars) {
      start = i + 1
      break
    }
  }
  return { lines: start === 0 ? lines : lines.slice(start), dropped: start > 0 }
}

/** The text the viewer paints for a state (complete lines plus the partial one). */
export function logViewText(state: LogViewState): string {
  const body = state.lines.join('\n')
  if (!state.partial) return body
  return body ? `${body}\n${state.partial}` : state.partial
}
