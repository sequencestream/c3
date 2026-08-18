/*
 * files-git-poller.ts — the Files view's Git-status polling cadence.
 *
 * The controller is the shared `createGatedPoller` (`poller.ts`); what is
 * Files-specific is only how often it fires.
 */
export const FILES_GIT_STATUS_INTERVAL_MS = 15_000
