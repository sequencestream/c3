/**
 * Vendor-aware session history read path — the single place that turns a
 * `(vendor, workspacePath, sessionId)` triple into `TranscriptItem[]`.
 *
 * Every reader of an already-persisted transcript goes through here (interactive
 * `select_session` replay and the automation execution detail alike), so the two
 * never disagree about where a vendor's transcript lives.
 */
import type { CanonicalMessage, TranscriptItem, VendorId } from '@ccc/shared/protocol'
import { CodexSessionStore, codexStoreRoots } from '../../kernel/agent/adapters/codex/index.js'
import { resolveSessionStoreScope } from '../../kernel/agent-config/index.js'
import { loadHistory } from '../../sessions.js'

const codexHistoryStore = new CodexSessionStore()

/** Read a session's persisted transcript from its vendor's native session store. */
export async function loadHistoryForVendor(
  vendor: VendorId,
  workspacePath: string,
  sessionId: string,
): Promise<TranscriptItem[]> {
  if (vendor === 'codex') {
    // Read from the session's frozen store scope's CODEX_HOME first, with the
    // other root as a fallback (ADR-0015) — so a session that ran in the sandbox
    // is read back from the persistent sandbox home, not host `~/.codex`.
    const storeRoots = codexStoreRoots(workspacePath, resolveSessionStoreScope(sessionId))
    return canonicalToTranscript(
      await codexHistoryStore.read(sessionId, { cwd: workspacePath, storeRoots }),
    )
  }
  // Claude transcripts are read via the SDK, which keys its projects root off the
  // server process's CLAUDE_CONFIG_DIR. The sandbox writes claude transcripts into
  // that same host config dir (getSandboxClaudeConfigDir), so no scope branch is
  // needed here — a sandboxed claude session is already host-readable.
  return loadHistory(workspacePath, sessionId)
}

function canonicalToTranscript(messages: readonly CanonicalMessage[]): TranscriptItem[] {
  const out: TranscriptItem[] = []
  for (const msg of messages) {
    for (const block of msg.blocks) {
      if (block.type === 'text') {
        const text = block.text.trim()
        if (!text) continue
        out.push(msg.role === 'user' ? { kind: 'user', text } : { kind: 'assistant', text })
      } else if (block.type === 'tool_use') {
        out.push({
          kind: 'tool_use',
          toolUseId: block.id,
          toolName: block.name,
          input: block.input,
        })
        if (block.result) {
          out.push({
            kind: 'tool_result',
            toolUseId: block.id,
            content: block.result.content,
            isError: block.result.isError,
          })
        }
      }
    }
  }
  return out
}
