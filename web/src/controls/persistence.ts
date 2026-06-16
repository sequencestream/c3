import type { WorkspaceInfo } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import {
  VIEW_MODE_KEY,
  REQ_PROJECT_KEY,
  DISC_PROJECT_KEY,
  DISC_ID_KEY,
  SCHED_PROJECT_KEY,
  CURRENT_WS_KEY,
} from './state'

// Install localStorage view-restore persistence + the post-`ready` restore
// helpers onto the shared ctx. All reads/writes are best-effort (a disabled
// localStorage degrades to in-memory-only, which already survives a WS reconnect).
export function installPersistence(ctx: AppCtx): void {
  const {
    currentWorkspace,
    activeTab,
    intentsProject,
    discussionsProject,
    activeDiscussionId,
    schedulesProject,
    selectedScheduleId,
  } = ctx
  const send = ctx.send

  // Read the persisted current-workspace path (null when unset/unavailable).
  ctx.readStoredWorkspace = (): string | null => {
    try {
      return localStorage.getItem(CURRENT_WS_KEY)
    } catch {
      return null
    }
  }

  // Persist the current-workspace selection so a hard refresh restores it.
  ctx.persistCurrentWorkspace = (): void => {
    try {
      if (currentWorkspace.value) localStorage.setItem(CURRENT_WS_KEY, currentWorkspace.value)
      else localStorage.removeItem(CURRENT_WS_KEY)
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }

  // Persist the intent-view selection so a hard refresh restores it (Vue's
  // in-memory state already survives a WS reconnect; this only covers reload).
  ctx.persistViewMode = (): void => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, activeTab.value)
      if (intentsProject.value) localStorage.setItem(REQ_PROJECT_KEY, intentsProject.value)
      if (discussionsProject.value) localStorage.setItem(DISC_PROJECT_KEY, discussionsProject.value)
      if (activeDiscussionId.value) localStorage.setItem(DISC_ID_KEY, activeDiscussionId.value)
      else localStorage.removeItem(DISC_ID_KEY)
      if (schedulesProject.value) localStorage.setItem(SCHED_PROJECT_KEY, schedulesProject.value)
      else localStorage.removeItem(SCHED_PROJECT_KEY)
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }

  // After `ready`, re-enter the intent view if a hard refresh left us there.
  ctx.maybeRestoreIntents = (list: WorkspaceInfo[]): void => {
    let saved: { mode: string | null; proj: string | null }
    try {
      saved = {
        mode: localStorage.getItem(VIEW_MODE_KEY),
        proj: localStorage.getItem(REQ_PROJECT_KEY),
      }
    } catch {
      return
    }
    if (saved.mode === 'intents' && saved.proj && list.some((w) => w.id === saved.proj)) {
      activeTab.value = 'intents'
      intentsProject.value = saved.proj
      send({ type: 'open_intent_chat', workspaceId: saved.proj })
      send({ type: 'list_intent_sessions', workspaceId: saved.proj })
    }
  }

  // After `ready`, re-enter the discussion view if a hard refresh left us there,
  // re-fetching the list and (if one was open) re-opening that discussion.
  ctx.maybeRestoreDiscussions = (list: WorkspaceInfo[]): void => {
    let saved: { mode: string | null; proj: string | null; id: string | null }
    try {
      saved = {
        mode: localStorage.getItem(VIEW_MODE_KEY),
        proj: localStorage.getItem(DISC_PROJECT_KEY),
        id: localStorage.getItem(DISC_ID_KEY),
      }
    } catch {
      return
    }
    if (saved.mode === 'discussion' && saved.proj && list.some((w) => w.id === saved.proj)) {
      activeTab.value = 'discussion'
      discussionsProject.value = saved.proj
      send({ type: 'list_discussions', workspaceId: saved.proj })
      if (saved.id) {
        activeDiscussionId.value = saved.id
        send({ type: 'open_discussion', discussionId: saved.id })
      }
    }
  }

  // After `ready`, re-enter the schedules view if a hard refresh left us there,
  // re-fetching the list so the left panel is populated.
  ctx.maybeRestoreSchedules = (list: WorkspaceInfo[]): void => {
    let saved: { mode: string | null; proj: string | null }
    try {
      saved = {
        mode: localStorage.getItem(VIEW_MODE_KEY),
        proj: localStorage.getItem(SCHED_PROJECT_KEY),
      }
    } catch {
      return
    }
    if (saved.mode === 'schedules' && saved.proj && list.some((w) => w.id === saved.proj)) {
      activeTab.value = 'schedules'
      schedulesProject.value = saved.proj
      selectedScheduleId.value = null
      send({ type: 'list_schedules', workspaceId: saved.proj })
    }
  }
}
