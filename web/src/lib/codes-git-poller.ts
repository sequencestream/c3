/*
 * codes-git-poller.ts — visibility/focus-gated polling for the Codes Git-status
 * snapshot, extracted as an injectable controller so it is fake-timer testable.
 *
 * `isActive()` folds every gate the caller cares about (on the Codes view AND the
 * page visible AND the window focused). `sync()` reconciles the timer to that
 * predicate; call it whenever a gate might have flipped (tab change, visibility,
 * focus/blur). Activating requests immediately, then every `intervalMs`; going
 * inactive stops the timer. Re-`sync()` while already active is a no-op, so a
 * flurry of events never stacks timers. Request de-duplication (at most one in
 * flight, merged follow-up) lives in the action `request` delegates to.
 */
export const CODES_GIT_STATUS_INTERVAL_MS = 15_000

export interface CodesGitStatusPoller {
  /** Reconcile the timer to `isActive()`. Idempotent while state is unchanged. */
  sync(): void
  /** Stop polling and clear the timer (idempotent). For teardown. */
  stop(): void
}

export function createCodesGitStatusPoller(opts: {
  intervalMs: number
  isActive: () => boolean
  request: () => void
}): CodesGitStatusPoller {
  let timer: ReturnType<typeof setInterval> | null = null

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function sync(): void {
    if (!opts.isActive()) {
      stop()
      return
    }
    // Already polling → don't create a second timer (resume/duplicate events).
    if (timer !== null) return
    // Fresh activation (enter / re-visible / re-focus): fetch once immediately…
    opts.request()
    // …then on a steady interval, re-checking the gate each tick as a guard.
    timer = setInterval(() => {
      if (opts.isActive()) opts.request()
      else stop()
    }, opts.intervalMs)
  }

  return { sync, stop }
}
