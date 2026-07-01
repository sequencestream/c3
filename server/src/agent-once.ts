/**
 * One-shot, tool-disabled agent query — the shared "advisor" primitive.
 *
 * Runs a single configured agent for one non-interactive turn under its own
 * launch overrides (base url / key / model via {@link launchForAgent}) and
 * returns its assistant text. Tools are denied so the agent reasons purely from
 * the prompt; no setting sources are loaded so the call stays light (no
 * CLAUDE.md / hooks / Skills). The session it spins up is registered as a *tool*
 * session (not a user session), so it never counts as a user-facing session.
 *
 * Extracted from consensus so both the consensus vote and the discussion
 * organizer engine share one stateless-turn implementation.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConfig } from '@ccc/shared/protocol'
import { launchForAgent } from './kernel/agent-config/index.js'
import { findClaudeExecutable } from './kernel/infra/child-env.js'
import { addToolSession } from './sessions.js'
import type { SessionOwnerKind } from './features/sessions/session-metadata-store.js'

export async function askAgentOnce(
  agent: AgentConfig,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  origin?: { ownerKind: SessionOwnerKind; ownerId: string } | null,
  /**
   * The stable advisor role/contract, delivered on the system channel so the
   * per-turn `prompt` stays the variable user context — a byte-stable system
   * prefix the API prompt cache hits across voters and across successive votes.
   * Delivered as a RAW custom system prompt (a plain string), NOT the claude_code
   * preset, to keep this call light (no CLAUDE.md / hooks / cwd context — the
   * advisor reasons purely from the prompt). Omit ⇒ the SDK default system.
   */
  systemInstruction?: string,
): Promise<string> {
  const launch = launchForAgent(agent)
  const claudePath = findClaudeExecutable()
  const q = query({
    prompt,
    options: {
      cwd,
      ...(systemInstruction ? { systemPrompt: systemInstruction } : {}),
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(launch.envOverrides ? { env: { ...process.env, ...launch.envOverrides } } : {}),
      ...(launch.model ? { model: launch.model } : {}),
      permissionMode: 'default',
      // Advisor must not act — it only answers from context.
      canUseTool: async () => ({ behavior: 'deny', message: 'agent-once: no tools' }),
    },
  })

  const onAbort = () => {
    try {
      const p = q.interrupt?.()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* noop */
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })

  let text = ''
  let sessionId = ''
  try {
    for await (const m of q) {
      if (signal.aborted) break
      // Capture session_id from the first event and register it as a tool session.
      if (!sessionId) {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) {
          sessionId = sid
          addToolSession(sid, {
            workspacePath: cwd,
            agentId: agent.id,
            ownerKind: origin?.ownerKind ?? null,
            ownerId: origin?.ownerId ?? null,
          })
        }
      }
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string }
            if (b.type === 'text' && typeof b.text === 'string') text += b.text
          }
        }
      } else if (m.type === 'result') {
        break
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return text.trim()
}
