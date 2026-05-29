/**
 * Thin wrapper over the Agent SDK's session-introspection API. The SDK is the
 * source of truth for which sessions exist, their history, and their titles
 * (persisted as JSONL under `~/.claude/projects/<encoded-cwd>/`). c3 only adds
 * the per-session mode (from `state.ts`) when surfacing them to the sidebar.
 */

import {
  deleteSession,
  getSessionMessages,
  listSessions,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionInfo, TranscriptItem } from '@ccc/shared/protocol'
import { getSessionMode } from './state.js'
import { stringifyToolResult } from './format.js'

/** Best display title for a session, preferring a user-set title. */
function titleOf(s: {
  customTitle?: string
  summary?: string
  firstPrompt?: string
  sessionId: string
}): string {
  return s.customTitle?.trim() || s.summary?.trim() || s.firstPrompt?.trim() || 'Untitled session'
}

/** List a workspace's sessions, newest first, each tagged with its c3 mode. */
export async function listWorkspaceSessions(dir: string): Promise<SessionInfo[]> {
  const sessions = await listSessions({ dir })
  return sessions
    .map((s) => ({
      sessionId: s.sessionId,
      title: titleOf(s),
      lastModified: s.lastModified,
      mode: getSessionMode(s.sessionId),
    }))
    .sort((a, b) => b.lastModified - a.lastModified)
}

/** Resolve a single session's display title (after a run created/renamed it). */
export async function sessionTitle(dir: string, sessionId: string): Promise<string> {
  try {
    const sessions = await listSessions({ dir })
    const found = sessions.find((s) => s.sessionId === sessionId)
    return found ? titleOf(found) : 'Untitled session'
  } catch {
    return 'Untitled session'
  }
}

/**
 * Map one SDK transcript message to zero or more render items. Mirrors the live
 * mapping in `claude.ts` so replayed history looks identical to live output.
 */
function mapMessage(m: { type: string; message: unknown }): TranscriptItem[] {
  const msg = m.message as { role?: string; content?: unknown } | undefined
  const content = msg?.content
  if (m.type === 'assistant') {
    if (!Array.isArray(content)) return []
    const items: TranscriptItem[] = []
    for (const block of content) {
      const b = block as { type?: string; text?: string; name?: string; input?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') {
        items.push({ kind: 'assistant', text: b.text })
      } else if (b.type === 'tool_use' && b.name) {
        items.push({ kind: 'tool_use', toolName: b.name, input: b.input ?? {} })
      }
    }
    return items
  }
  if (m.type === 'user') {
    if (typeof content === 'string') return [{ kind: 'user', text: content }]
    if (!Array.isArray(content)) return []
    const items: TranscriptItem[] = []
    for (const block of content) {
      const b = block as { type?: string; text?: string; content?: unknown; is_error?: boolean }
      if (b.type === 'text' && typeof b.text === 'string') {
        items.push({ kind: 'user', text: b.text })
      } else if (b.type === 'tool_result') {
        items.push({
          kind: 'tool_result',
          content: stringifyToolResult(b.content),
          isError: !!b.is_error,
        })
      }
    }
    return items
  }
  return []
}

/** Read a session's transcript and flatten it into render items. */
export async function loadHistory(dir: string, sessionId: string): Promise<TranscriptItem[]> {
  const messages = await getSessionMessages(sessionId, { dir })
  return messages.flatMap(mapMessage)
}

export async function removeSession(dir: string, sessionId: string): Promise<void> {
  await deleteSession(sessionId, { dir })
}

export async function renameWorkspaceSession(
  dir: string,
  sessionId: string,
  title: string,
): Promise<void> {
  await renameSession(sessionId, title, { dir })
}
