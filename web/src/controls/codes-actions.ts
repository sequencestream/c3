import { closeTab } from '@/lib/codes-view'
import type { CodeSearchHit } from '@ccc/shared/protocol'
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
    codesSearchResult,
    codesSearchLoading,
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
    codesSearchResult.value = null
    codesSearchLoading.value = false
  }

  // Enter the Codes view for a workspace: reset on workspace change, then
  // lazy-load the root listing once.
  ctx.openCodes = (workspaceId: string): void => {
    ctx.activeTab.value = 'codes'
    if (codesProject.value !== workspaceId) {
      codesProject.value = workspaceId
      resetCodesState()
    }
    ctx.persistViewMode()
    if (!codesDirs.value['']) ctx.loadCodesDir('')
  }

  // Request one directory's immediate children (idempotent while in-flight).
  ctx.loadCodesDir = (rel: string): void => {
    const ws = codesProject.value
    if (!ws || codesLoadingDirs.value.has(rel)) return
    codesLoadingDirs.value = new Set(codesLoadingDirs.value).add(rel)
    send({ type: 'list_dir', workspaceId: ws, rel })
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
    send({ type: 'search_codes', workspaceId: ws, query, mode: codesSearchMode.value })
  }

  // Open a search hit: jump to the matched line for content hits.
  ctx.openCodeSearchHit = (hit: CodeSearchHit): void => {
    if (hit.type !== 'file') return
    ctx.openCodeFile(hit.path, hit.line)
  }
}
