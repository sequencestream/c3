import { watch } from 'vue'
import { closeTab, normalizeFilePath, parseAncestors } from '@/lib/files-view'
import {
  PENDING_SESSION_PREFIX,
  type FileGitStatus,
  type FileSearchHit,
} from '@ccc/shared/protocol'
import type { AppCtx } from './types'

// Install Files-tab actions (read-only file browser) onto the ctx.
//
// All requests carry the opaque `workspaceName` and a workspace-RELATIVE path —
// the client never constructs or reasons about absolute/escape paths; the
// server guard is the sole boundary (see server/src/features/files).
export function installFilesActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    filesProject,
    filesDirs,
    filesExpanded,
    filesLoadingDirs,
    filesGitStatus,
    filesTabs,
    filesActivePath,
    filesSearchMode,
    filesSearchQuery,
    filesSearchPattern,
    filesSearchResult,
    filesSearchLoading,
    filesBoundSessionId,
    activeSession,
    activeTab,
    currentWorkspace,
  } = ctx

  // At most one `get_file_git_status` per workspace in flight; a refresh while one
  // is pending sets `statusQueued` so exactly one follow-up runs on reply (merge).
  let statusInFlight = false
  let statusQueued = false

  // Wipe every per-workspace artefact (tree cache, tabs, search, git snapshot) —
  // used when the browsed workspace changes so no stale path can leak across
  // workspaces. The in-flight guards reset too: a late reply for the old
  // workspace is discarded by the id check in applyFileGitStatus.
  function resetFilesState(): void {
    filesDirs.value = {}
    filesExpanded.value = new Set()
    filesLoadingDirs.value = new Set()
    filesGitStatus.value = {}
    statusInFlight = false
    statusQueued = false
    filesTabs.value = []
    filesActivePath.value = null
    filesSearchMode.value = 'filename'
    filesSearchQuery.value = ''
    filesSearchPattern.value = '*'
    filesSearchResult.value = null
    filesSearchLoading.value = false
  }

  // Enter the Files view for a workspace: reset on workspace change, lazy-load the
  // root listing once, then restore this workspace's embedded chat session.
  ctx.openFiles = (workspaceName: string): void => {
    ctx.activeTab.value = 'files'
    if (filesProject.value !== workspaceName) {
      filesProject.value = workspaceName
      resetFilesState()
    }
    ctx.persistViewMode()
    if (!filesDirs.value['']) ctx.loadFilesDir('')
    // Restore the embedded ChatColumn's last session for this workspace. Reuse the
    // control layer's single active session: `select_session` fills the global
    // state the same as Works. When no id is persisted, leave the active session
    // untouched — the panel shows its empty state via the files binding pointer
    // (the desktop three-column layout gates create-vs-reset on filesBoundSessionId).
    const savedId = ctx.readFilesSessionId(workspaceName)
    if (savedId) {
      filesBoundSessionId.value = { ...filesBoundSessionId.value, [workspaceName]: savedId }
      if (activeSession.value !== savedId) {
        send({ type: 'select_session', workspaceName, sessionId: savedId })
      }
    }
  }

  // 空态「+ 新建」/ 标题栏「↻ 重置」都创建一个普通 work session(沿用 workspace 默认
  // agent,不弹 NewSessionModal,与 Works「+」简化行为一致)。服务端回 session_selected
  // 时,下面的 watch 把新 id 写入 filesBoundSessionId + localStorage;失败经控制层
  // showToast 兜底(入站 error 分发)。
  ctx.createFilesChatSession = (workspaceName: string): void => {
    send({ type: 'create_session', workspaceName })
  }
  ctx.resetFilesChatSession = (workspaceName: string): void => {
    send({ type: 'create_session', workspaceName })
  }

  // 绑定/持久化 Files 内嵌会话指针:仅当停留在 files tab 时,把活动会话记为当前
  // filesProject 的绑定会话。切到 Works 后 activeTab≠'files',此 watch 不会用 Works
  // 的会话覆盖 files 指针(两指针独立)。
  // 内存绑定即时生效(含 pending id):否则「+ 新建」建出的 pending 会话无法让
  // chatActive(activeSession===filesBoundSessionId)成立,输入框始终禁用 → 死锁
  // (pending 只在首次 run 后经 session_started 转正,而 run 又要先能提交)。
  // 持久化只写真实 id:pending id(create 回执临时 id)重连不存活,等 session_started
  // 迁移到真实 id 再落 localStorage。
  watch(
    activeSession,
    (id) => {
      if (activeTab.value !== 'files') return
      const ws = filesProject.value
      if (!ws || !id) return
      if (filesBoundSessionId.value[ws] !== id) {
        filesBoundSessionId.value = { ...filesBoundSessionId.value, [ws]: id }
      }
      if (!id.startsWith(PENDING_SESSION_PREFIX)) ctx.persistFilesSessionId(ws, id)
    },
    { flush: 'sync' },
  )

  // Request one directory's immediate children (idempotent while in-flight).
  ctx.loadFilesDir = (rel: string): void => {
    const ws = filesProject.value
    if (!ws || filesLoadingDirs.value.has(rel)) return
    filesLoadingDirs.value = new Set(filesLoadingDirs.value).add(rel)
    send({ type: 'list_dir', workspaceName: ws, rel })
  }

  // Request the workspace Git-status snapshot (idempotent: coalesced while one is
  // already in flight). Decoupled from `list_dir` — the auto-poller calls only
  // this; the manual refresh calls it alongside the tree reload.
  ctx.requestFilesGitStatus = (): void => {
    const ws = filesProject.value
    if (!ws) return
    if (statusInFlight) {
      statusQueued = true
      return
    }
    statusInFlight = true
    send({ type: 'get_file_git_status', workspaceName: ws })
  }

  // Adopt a `file_git_status` reply: authoritative wholesale replace, but only for
  // the workspace currently browsed (a stale reply for a switched-away workspace is
  // dropped). Fire the merged follow-up if a refresh arrived while in flight.
  ctx.applyFileGitStatus = (workspaceName: string, files: Record<string, FileGitStatus>): void => {
    statusInFlight = false
    if (workspaceName === filesProject.value) filesGitStatus.value = files
    if (statusQueued) {
      statusQueued = false
      ctx.requestFilesGitStatus()
    }
  }

  // Re-fetch the file tree from disk: reload the root plus every currently
  // expanded directory so newly added / removed files show up without collapsing
  // the tree. `list_dir` overwrites each cached listing on reply; in-flight dirs
  // are skipped by loadFilesDir's guard. The manual refresh also re-pulls the Git
  // snapshot concurrently (spec: same button, decoupled requests).
  ctx.refreshFilesTree = (): void => {
    if (!filesProject.value) return
    ctx.loadFilesDir('')
    for (const rel of filesExpanded.value) ctx.loadFilesDir(rel)
    ctx.requestFilesGitStatus()
  }

  // Expand/collapse a tree directory; expanding triggers a one-time lazy load.
  ctx.toggleFilesDir = (rel: string): void => {
    const next = new Set(filesExpanded.value)
    if (next.has(rel)) {
      next.delete(rel)
    } else {
      next.add(rel)
      if (!filesDirs.value[rel]) ctx.loadFilesDir(rel)
    }
    filesExpanded.value = next
  }

  // Navigate to a file from a markdown code link: switch to files tab (if needed),
  // expand all ancestor directories (lazy-loading un-cached ones), then open the file.
  ctx.navigateToFile = (path: string, line?: number): void => {
    const ws = activeTab.value === 'files' ? filesProject.value : currentWorkspace.value
    if (!ws) return
    if (activeTab.value !== 'files') ctx.openFiles(ws)
    // Canonicalize the authored path so the optimistic tab key matches the
    // server's `file_read` reply (which echoes the resolved path); otherwise a
    // `./`-prefixed or `..`-bearing link would leave the tab stuck loading.
    const rel = normalizeFilePath(path)
    // Parse and expand all ancestor directories in the code tree.
    const ancestors = parseAncestors(rel)
    const nextExpanded = new Set(filesExpanded.value)
    for (const dir of ancestors) {
      nextExpanded.add(dir)
      if (!filesDirs.value[dir]) ctx.loadFilesDir(dir)
    }
    filesExpanded.value = nextExpanded
    // Open the file (focus or create tab).
    ctx.openFile(rel, line)
  }

  // Open a file in the right pane: focus an already-open tab (optionally jumping
  // to `line`), or open a new tab and fetch its content.
  ctx.openFile = (path: string, line?: number): void => {
    const ws = filesProject.value
    if (!ws) return
    const existing = filesTabs.value.find((tab) => tab.path === path)
    if (existing) {
      if (line != null) existing.focusLine = line
      filesActivePath.value = path
      return
    }
    filesTabs.value = [...filesTabs.value, { path, file: null, loading: true, focusLine: line }]
    filesActivePath.value = path
    send({ type: 'read_file', workspaceName: ws, rel: path })
  }

  // Manually close one tab; focus shifts to the adjacent tab (pure logic in lib).
  ctx.closeFileTab = (path: string): void => {
    const { tabs, activePath } = closeTab(filesTabs.value, path, filesActivePath.value)
    filesTabs.value = tabs
    filesActivePath.value = activePath
  }

  // Focus an already-open tab.
  ctx.setFilesActiveTab = (path: string): void => {
    filesActivePath.value = path
  }

  // Switch search mode (filename/content); re-run if a query is already present.
  ctx.setFilesSearchMode = (mode: 'filename' | 'content'): void => {
    if (filesSearchMode.value === mode) return
    filesSearchMode.value = mode
    if (filesSearchQuery.value.trim()) ctx.runFileSearch()
  }

  // Fire a bounded search (filename or content) for the current query.
  ctx.runFileSearch = (): void => {
    const ws = filesProject.value
    if (!ws) return
    const query = filesSearchQuery.value.trim()
    if (!query) {
      filesSearchResult.value = null
      filesSearchLoading.value = false
      return
    }
    filesSearchLoading.value = true
    const pattern = filesSearchPattern.value.trim() || '*'
    send({ type: 'search_files', workspaceName: ws, query, mode: filesSearchMode.value, pattern })
  }

  // Open a search hit: jump to the matched line for content hits.
  ctx.openFileSearchHit = (hit: FileSearchHit): void => {
    if (hit.type !== 'file') return
    ctx.openFile(hit.path, hit.line)
  }
}
