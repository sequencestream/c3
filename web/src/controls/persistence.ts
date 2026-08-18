import { watch } from 'vue'
import type { WorkspaceInfo } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import {
  VIEW_MODE_KEY,
  REQ_PROJECT_KEY,
  DISC_PROJECT_KEY,
  DISC_ID_KEY,
  SCHED_PROJECT_KEY,
  FILES_PROJECT_KEY,
  FILES_CHAT_WIDTH_KEY,
  FILES_CHAT_SESSION_KEY,
  FILES_CHAT_WIDTH_DEFAULT,
  FILES_CHAT_WIDTH_MIN,
  FILES_CHAT_WIDTH_MAX,
  CURRENT_WS_KEY,
  WORK_SESSION_QUERY_START_TIME_KEY,
} from './state'

// Per-workspace Files localStorage key: `c3.files.<workspaceName>.<suffix>`.
function filesKey(workspaceName: string, suffix: string): string {
  return `c3.files.${workspaceName}.${suffix}`
}

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
    automationsProject,
    selectedAutomationId,
    filesProject,
  } = ctx
  const send = ctx.send

  // A time-bounded work-session query must not carry a stale boundary into a
  // different page. Flush synchronously because page-entry actions issue their
  // first requests immediately after changing the active tab.
  watch(
    activeTab,
    (next, previous) => {
      if (next === previous) return
      try {
        localStorage.removeItem(WORK_SESSION_QUERY_START_TIME_KEY)
      } catch {
        /* localStorage unavailable — non-fatal */
      }
    },
    { flush: 'sync' },
  )

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
      if (automationsProject.value)
        localStorage.setItem(SCHED_PROJECT_KEY, automationsProject.value)
      else localStorage.removeItem(SCHED_PROJECT_KEY)
      if (filesProject.value) localStorage.setItem(FILES_PROJECT_KEY, filesProject.value)
      else localStorage.removeItem(FILES_PROJECT_KEY)
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
    if (saved.mode === 'intents' && saved.proj && list.some((w) => w.name === saved.proj)) {
      activeTab.value = 'intents'
      intentsProject.value = saved.proj
      // Same contract as the regular intent entry: the detail progress and PR
      // actions depend on the normalized workspace branch mode, so the restore
      // path must request it too instead of sitting on the default mode.
      send({ type: 'load_workspace_setting', workspaceName: saved.proj })
      send({ type: 'open_intent_session', workspaceName: saved.proj })
      send({ type: 'list_intent_sessions', workspaceName: saved.proj })
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
    if (saved.mode === 'discussion' && saved.proj && list.some((w) => w.name === saved.proj)) {
      activeTab.value = 'discussion'
      discussionsProject.value = saved.proj
      send({ type: 'list_discussions', workspaceName: saved.proj })
      if (saved.id) {
        activeDiscussionId.value = saved.id
        send({ type: 'open_discussion', discussionId: saved.id })
      }
    }
  }

  // After `ready`, re-enter the automations view if a hard refresh left us there,
  // re-fetching the list so the left panel is populated.
  ctx.maybeRestoreAutomations = (list: WorkspaceInfo[]): void => {
    let saved: { mode: string | null; proj: string | null }
    try {
      saved = {
        mode: localStorage.getItem(VIEW_MODE_KEY),
        proj: localStorage.getItem(SCHED_PROJECT_KEY),
      }
    } catch {
      return
    }
    if (saved.mode === 'automations' && saved.proj && list.some((w) => w.name === saved.proj)) {
      activeTab.value = 'automations'
      automationsProject.value = saved.proj
      selectedAutomationId.value = null
      send({ type: 'list_automations', workspaceName: saved.proj })
    }
  }

  // ---- Files 内嵌 ChatColumn 持久化(per-workspace,只 localStorage,best-effort)----
  // 分隔条宽度(像素):缺失 / 解析失败 / 越界时回退默认 360,并夹到 [min, max]。
  ctx.readFilesChatWidth = (workspaceName: string): number => {
    try {
      const raw = localStorage.getItem(filesKey(workspaceName, FILES_CHAT_WIDTH_KEY))
      const px = raw == null ? NaN : Number.parseInt(raw, 10)
      if (!Number.isFinite(px)) return FILES_CHAT_WIDTH_DEFAULT
      return Math.min(FILES_CHAT_WIDTH_MAX, Math.max(FILES_CHAT_WIDTH_MIN, px))
    } catch {
      return FILES_CHAT_WIDTH_DEFAULT
    }
  }

  ctx.persistFilesChatWidth = (workspaceName: string, px: number): void => {
    try {
      localStorage.setItem(filesKey(workspaceName, FILES_CHAT_WIDTH_KEY), String(Math.round(px)))
    } catch {
      /* localStorage unavailable — degrade to no-memory */
    }
  }

  // 内嵌会话 id:缺失 / 空串回退 null。
  ctx.readFilesSessionId = (workspaceName: string): string | null => {
    try {
      const raw = localStorage.getItem(filesKey(workspaceName, FILES_CHAT_SESSION_KEY))
      return raw && raw.length ? raw : null
    } catch {
      return null
    }
  }

  ctx.persistFilesSessionId = (workspaceName: string, id: string | null): void => {
    try {
      if (id) localStorage.setItem(filesKey(workspaceName, FILES_CHAT_SESSION_KEY), id)
      else localStorage.removeItem(filesKey(workspaceName, FILES_CHAT_SESSION_KEY))
    } catch {
      /* localStorage unavailable — degrade to no-memory */
    }
  }

  // After `ready`, re-enter the Files view if a hard refresh left us there,
  // re-loading the root listing (open tabs are intentionally not persisted).
  ctx.maybeRestoreFiles = (list: WorkspaceInfo[]): void => {
    let saved: { mode: string | null; proj: string | null }
    try {
      saved = {
        mode: localStorage.getItem(VIEW_MODE_KEY),
        proj: localStorage.getItem(FILES_PROJECT_KEY),
      }
    } catch {
      return
    }
    if (saved.mode === 'files' && saved.proj && list.some((w) => w.name === saved.proj)) {
      ctx.openFiles(saved.proj)
    }
  }
}
