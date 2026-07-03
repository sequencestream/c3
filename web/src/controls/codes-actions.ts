import { watch } from 'vue'
import { closeTab } from '@/lib/codes-view'
import { PENDING_SESSION_PREFIX, type CodeSearchHit } from '@ccc/shared/protocol'
import type { AppCtx } from './types'

// Install Codes-tab actions (read-only file browser) onto the ctx.
//
// All requests carry the opaque `workspaceId` and a workspace-RELATIVE path —
// the client never constructs or reasons about absolute/escape paths; the
// server guard is the sole boundary (see server/src/features/codes).
export function installCodesActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    codesProject,
    codesDirs,
    codesExpanded,
    codesLoadingDirs,
    codesTabs,
    codesActivePath,
    codesSearchMode,
    codesSearchQuery,
    codesSearchPattern,
    codesSearchResult,
    codesSearchLoading,
    codesBoundSessionId,
    activeSession,
    activeTab,
  } = ctx

  // Wipe every per-workspace artefact (tree cache, tabs, search) — used when the
  // browsed workspace changes so no stale path can leak across workspaces.
  function resetCodesState(): void {
    codesDirs.value = {}
    codesExpanded.value = new Set()
    codesLoadingDirs.value = new Set()
    codesTabs.value = []
    codesActivePath.value = null
    codesSearchMode.value = 'filename'
    codesSearchQuery.value = ''
    codesSearchPattern.value = '*'
    codesSearchResult.value = null
    codesSearchLoading.value = false
  }

  // Enter the Codes view for a workspace: reset on workspace change, lazy-load the
  // root listing once, then restore this workspace's embedded chat session.
  ctx.openCodes = (workspaceId: string): void => {
    ctx.activeTab.value = 'codes'
    if (codesProject.value !== workspaceId) {
      codesProject.value = workspaceId
      resetCodesState()
    }
    ctx.persistViewMode()
    if (!codesDirs.value['']) ctx.loadCodesDir('')
    // Restore the embedded ChatColumn's last session for this workspace. Reuse the
    // control layer's single active session: `select_session` fills the global
    // state the same as Works. When no id is persisted, leave the active session
    // untouched — the panel shows its empty state via the codes binding pointer
    // (the desktop three-column layout gates create-vs-reset on codesBoundSessionId).
    const savedId = ctx.readCodesSessionId(workspaceId)
    if (savedId) {
      codesBoundSessionId.value = { ...codesBoundSessionId.value, [workspaceId]: savedId }
      if (activeSession.value !== savedId) {
        send({ type: 'select_session', workspaceId, sessionId: savedId })
      }
    }
  }

  // 空态「+ 新建」/ 标题栏「↻ 重置」都创建一个普通 work session(沿用 workspace 默认
  // agent,不弹 NewSessionModal,与 Works「+」简化行为一致)。服务端回 session_selected
  // 时,下面的 watch 把新 id 写入 codesBoundSessionId + localStorage;失败经控制层
  // showToast 兜底(入站 error 分发)。
  ctx.createCodesChatSession = (workspaceId: string): void => {
    send({ type: 'create_session', workspaceId })
  }
  ctx.resetCodesChatSession = (workspaceId: string): void => {
    send({ type: 'create_session', workspaceId })
  }

  // 绑定/持久化 Codes 内嵌会话指针:仅当停留在 codes tab 时,把活动会话记为当前
  // codesProject 的绑定会话。切到 Works 后 activeTab≠'codes',此 watch 不会用 Works
  // 的会话覆盖 codes 指针(两指针独立)。
  // 内存绑定即时生效(含 pending id):否则「+ 新建」建出的 pending 会话无法让
  // chatActive(activeSession===codesBoundSessionId)成立,输入框始终禁用 → 死锁
  // (pending 只在首次 run 后经 session_started 转正,而 run 又要先能提交)。
  // 持久化只写真实 id:pending id(create 回执临时 id)重连不存活,等 session_started
  // 迁移到真实 id 再落 localStorage。
  watch(
    activeSession,
    (id) => {
      if (activeTab.value !== 'codes') return
      const ws = codesProject.value
      if (!ws || !id) return
      if (codesBoundSessionId.value[ws] !== id) {
        codesBoundSessionId.value = { ...codesBoundSessionId.value, [ws]: id }
      }
      if (!id.startsWith(PENDING_SESSION_PREFIX)) ctx.persistCodesSessionId(ws, id)
    },
    { flush: 'sync' },
  )

  // Request one directory's immediate children (idempotent while in-flight).
  ctx.loadCodesDir = (rel: string): void => {
    const ws = codesProject.value
    if (!ws || codesLoadingDirs.value.has(rel)) return
    codesLoadingDirs.value = new Set(codesLoadingDirs.value).add(rel)
    send({ type: 'list_dir', workspaceId: ws, rel })
  }

  // Re-fetch the file tree from disk: reload the root plus every currently
  // expanded directory so newly added / removed files show up without collapsing
  // the tree. `list_dir` overwrites each cached listing on reply; in-flight dirs
  // are skipped by loadCodesDir's guard.
  ctx.refreshCodesTree = (): void => {
    if (!codesProject.value) return
    ctx.loadCodesDir('')
    for (const rel of codesExpanded.value) ctx.loadCodesDir(rel)
  }

  // Expand/collapse a tree directory; expanding triggers a one-time lazy load.
  ctx.toggleCodesDir = (rel: string): void => {
    const next = new Set(codesExpanded.value)
    if (next.has(rel)) {
      next.delete(rel)
    } else {
      next.add(rel)
      if (!codesDirs.value[rel]) ctx.loadCodesDir(rel)
    }
    codesExpanded.value = next
  }

  // Open a file in the right pane: focus an already-open tab (optionally jumping
  // to `line`), or open a new tab and fetch its content.
  ctx.openCodeFile = (path: string, line?: number): void => {
    const ws = codesProject.value
    if (!ws) return
    const existing = codesTabs.value.find((tab) => tab.path === path)
    if (existing) {
      if (line != null) existing.focusLine = line
      codesActivePath.value = path
      return
    }
    codesTabs.value = [...codesTabs.value, { path, file: null, loading: true, focusLine: line }]
    codesActivePath.value = path
    send({ type: 'read_file', workspaceId: ws, rel: path })
  }

  // Manually close one tab; focus shifts to the adjacent tab (pure logic in lib).
  ctx.closeCodeTab = (path: string): void => {
    const { tabs, activePath } = closeTab(codesTabs.value, path, codesActivePath.value)
    codesTabs.value = tabs
    codesActivePath.value = activePath
  }

  // Focus an already-open tab.
  ctx.setCodesActiveTab = (path: string): void => {
    codesActivePath.value = path
  }

  // Switch search mode (filename/content); re-run if a query is already present.
  ctx.setCodesSearchMode = (mode: 'filename' | 'content'): void => {
    if (codesSearchMode.value === mode) return
    codesSearchMode.value = mode
    if (codesSearchQuery.value.trim()) ctx.runCodeSearch()
  }

  // Fire a bounded search (filename or content) for the current query.
  ctx.runCodeSearch = (): void => {
    const ws = codesProject.value
    if (!ws) return
    const query = codesSearchQuery.value.trim()
    if (!query) {
      codesSearchResult.value = null
      codesSearchLoading.value = false
      return
    }
    codesSearchLoading.value = true
    const pattern = codesSearchPattern.value.trim() || '*'
    send({ type: 'search_codes', workspaceId: ws, query, mode: codesSearchMode.value, pattern })
  }

  // Open a search hit: jump to the matched line for content hits.
  ctx.openCodeSearchHit = (hit: CodeSearchHit): void => {
    if (hit.type !== 'file') return
    ctx.openCodeFile(hit.path, hit.line)
  }
}
