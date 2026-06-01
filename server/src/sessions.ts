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
import { resolve } from 'node:path'
import type { SessionInfo, TranscriptItem } from '@ccc/shared/protocol'
import { EMPTY_TURN_NOTICE } from '@ccc/shared/protocol'
import { getSessionMode } from './state.js'
import { normalizeTranscriptText, stringifyToolResult } from './format.js'
import {
  listHiddenSessions,
  recordToolSession,
  isToolSessionRecorded,
  deleteToolSessionRecord,
} from './requirements/store.js'
import { getShowToolSessions } from './settings.js'

/**
 * Module-level tracker for tool-created sessions (completion judge, consensus
 * advisor queries). These sessions are created by `askOneShot()` and
 * `askAgentOnce()` via the SDK's `query()` and need to be distinguishable
 * from ordinary user-initiated sessions for filtering and display purposes.
 *
 * The set is a write-through cache over the persisted `tool_sessions` table:
 * recording also writes the db, so the tag survives restarts (an in-memory-only
 * set would be empty after a restart and leak historic tool sessions into the
 * list even with the setting off). `isToolSession` falls back to the db on a
 * cache miss to recognise sessions recorded by a previous process.
 */
const toolSessionIds: Set<string> = new Set()

/** Record a session id that was created by a tool (not by the user). */
export function addToolSession(id: string): void {
  toolSessionIds.add(id)
  recordToolSession(id)
}

/** Whether a session was created by a tool. */
export function isToolSession(id: string): boolean {
  return toolSessionIds.has(id) || isToolSessionRecorded(id)
}

/** Best display title for a session, preferring a user-set title. */
function titleOf(s: {
  customTitle?: string
  summary?: string
  firstPrompt?: string
  sessionId: string
}): string {
  return s.customTitle?.trim() || s.summary?.trim() || s.firstPrompt?.trim() || 'Untitled session'
}

/**
 * List a workspace's sessions, newest first, each tagged with its c3 mode.
 * Requirement-communication sessions are filtered out (they belong to the
 * requirement view, not the normal list). Tool-created sessions (completion
 * judge, consensus advisor) are also hidden by default, controlled by the
 * `showToolSessions` system setting. Uses the resolved path as the key, to
 * match how the store records `project_path`. If the store is unavailable it
 * returns an empty hidden set, so the list degrades to "show everything".
 */
export async function listWorkspaceSessions(dir: string): Promise<SessionInfo[]> {
  const sessions = await listSessions({ dir })
  const hidden = new Set(listHiddenSessions(resolve(dir)))
  const showTool = getShowToolSessions()
  return sessions
    .filter((s) => !hidden.has(s.sessionId))
    .map((s) => ({ s, tool: isToolSession(s.sessionId) }))
    .filter(({ tool }) => showTool || !tool)
    .map(({ s, tool }) => ({
      sessionId: s.sessionId,
      title: titleOf(s),
      lastModified: s.lastModified,
      mode: getSessionMode(s.sessionId),
      isToolSession: tool,
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
export function mapMessage(m: { type: string; message: unknown }): TranscriptItem[] {
  const msg = m.message as { role?: string; content?: unknown } | undefined
  const content = msg?.content
  if (m.type === 'assistant') {
    if (!Array.isArray(content)) return []
    const items: TranscriptItem[] = []
    for (const block of content) {
      const b = block as {
        type?: string
        id?: string
        text?: string
        name?: string
        input?: unknown
      }
      if (b.type === 'text' && typeof b.text === 'string') {
        items.push({ kind: 'assistant', text: b.text })
      } else if (b.type === 'tool_use' && b.name) {
        items.push({
          kind: 'tool_use',
          toolUseId: b.id ?? '',
          toolName: b.name,
          input: b.input ?? {},
        })
      }
    }
    return items
  }
  if (m.type === 'user') {
    if (typeof content === 'string') {
      const text = normalizeTranscriptText(content)
      return text ? [{ kind: 'user', text }] : []
    }
    if (!Array.isArray(content)) return []
    const items: TranscriptItem[] = []
    for (const block of content) {
      const b = block as {
        type?: string
        tool_use_id?: string
        text?: string
        content?: unknown
        is_error?: boolean
      }
      if (b.type === 'text' && typeof b.text === 'string') {
        const text = normalizeTranscriptText(b.text)
        if (text) items.push({ kind: 'user', text })
      } else if (b.type === 'tool_result') {
        items.push({
          kind: 'tool_result',
          toolUseId: b.tool_use_id ?? '',
          content: stringifyToolResult(b.content),
          isError: !!b.is_error,
        })
      }
    }
    return items
  }
  return []
}

/** True if an assistant SDK message carries a `thinking` block. */
function assistantHasThinking(m: { type: string; message: unknown }): boolean {
  if (m.type !== 'assistant') return false
  const content = (m.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return false
  return content.some((b) => (b as { type?: string }).type === 'thinking')
}

/**
 * Flatten a session's SDK transcript into render items, inserting an empty-turn
 * `notice` per turn that thought but produced nothing visible (mirrors the live
 * `notice` in claude.ts so reconnecting to such a turn shows the same line).
 *
 * The detection MUST be per-turn, not per-message: the on-disk transcript splits
 * one model turn into several single-block messages (a `thinking` message, a
 * `text` message, a `tool_use` message…). So a lone `thinking` message is almost
 * always just the lead-in to a turn that continues with text/tools in the *next*
 * message — not an empty turn. A turn is genuinely empty only if, across every
 * assistant message until the next real user prompt, it emitted a thinking block
 * but no assistant text and no tool call. A real user prompt (string / text
 * content, not a tool_result) is the turn boundary; the notice lands at the end
 * of the empty turn, before that next prompt.
 */
export function flattenMessages(messages: { type: string; message: unknown }[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  let turnHadVisible = false
  let turnHadThinking = false
  const closeTurn = () => {
    if (turnHadThinking && !turnHadVisible) out.push({ kind: 'notice', text: EMPTY_TURN_NOTICE })
    turnHadThinking = false
    turnHadVisible = false
  }
  for (const m of messages) {
    const items = mapMessage(m)
    if (m.type === 'assistant') {
      if (items.length > 0) turnHadVisible = true
      if (assistantHasThinking(m)) turnHadThinking = true
    } else if (m.type === 'user' && items.some((it) => it.kind === 'user')) {
      // A real user prompt ends the preceding assistant turn.
      closeTurn()
    }
    out.push(...items)
  }
  closeTurn() // settle the final turn (EOF)
  return out
}

/** Read a session's transcript and flatten it into render items. */
export async function loadHistory(dir: string, sessionId: string): Promise<TranscriptItem[]> {
  const messages = await getSessionMessages(sessionId, { dir })
  return flattenMessages(messages)
}

/**
 * Load the last N assistant messages from a session's on-disk transcript.
 * Returns plain-text assistant replies, most-recent first (index 0 = most recent).
 * Used by the reconcile logic to judge whether a dead-process session's work was
 * actually completed. Note: the SDK returns messages in chronological order
 * (oldest first), so we reverse before slicing.
 */
export async function loadLastAssistantMessages(
  dir: string,
  sessionId: string,
  count: number,
): Promise<string[]> {
  try {
    const messages = await getSessionMessages(sessionId, { dir })
    const assistantTexts: string[] = []
    for (const m of messages) {
      if (m.type === 'assistant') {
        const content = (m.message as { content?: unknown })?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string }
            if (b.type === 'text' && typeof b.text === 'string') {
              assistantTexts.push(b.text)
            }
          }
        }
      }
    }
    // SDK returns chronological (oldest first); reverse so most recent is first.
    return assistantTexts.reverse().slice(0, count)
  } catch {
    return []
  }
}

/** Whether a session still exists on disk (false if listing fails). */
export async function sessionExists(dir: string, sessionId: string): Promise<boolean> {
  try {
    const sessions = await listSessions({ dir })
    return sessions.some((s) => s.sessionId === sessionId)
  } catch {
    return false
  }
}

export async function removeSession(dir: string, sessionId: string): Promise<void> {
  // Delete the SDK's transcript file, then forget any c3-side tool-session tag
  // (both the in-memory cache and its persisted row) so a re-created session
  // reusing the id isn't wrongly classed as tool-created.
  await deleteSession(sessionId, { dir })
  toolSessionIds.delete(sessionId)
  deleteToolSessionRecord(sessionId)
}

export async function renameWorkspaceSession(
  dir: string,
  sessionId: string,
  title: string,
): Promise<void> {
  await renameSession(sessionId, title, { dir })
}
