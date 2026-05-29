/**
 * Pure consensus helpers — vote parsing, tallying, prompt + summary building.
 *
 * Kept dependency-free (no SDK import) so the decision logic is unit-testable in
 * isolation, mirroring `permissions.ts`. The orchestration that actually spawns
 * advisor queries lives in `consensus.ts`.
 */

import type { ConsensusVote } from '@ccc/shared/protocol'

/** Collapse whitespace/newlines into a single line. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Extract an allow/deny verdict from an advisor's free-form reply. */
export function parseVote(text: string): { decision: 'allow' | 'deny'; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { decision?: unknown; reason?: unknown }
      const d = String(obj.decision ?? '').toLowerCase()
      if (d === 'allow' || d === 'deny') {
        return { decision: d, reason: typeof obj.reason === 'string' ? oneLine(obj.reason) : '' }
      }
    } catch {
      /* fall through to keyword scan */
    }
  }
  const low = text.toLowerCase()
  const allow = /\ballow\b/.test(low)
  const deny = /\bdeny\b/.test(low)
  if (allow && !deny) return { decision: 'allow', reason: oneLine(text).slice(0, 200) }
  if (deny && !allow) return { decision: 'deny', reason: oneLine(text).slice(0, 200) }
  return null
}

/** Whether all voters returned the same allow/deny verdict, and which. */
export function tally(votes: ConsensusVote[]): {
  unanimous: boolean
  decision: 'allow' | 'deny' | null
} {
  const decisions = votes.map((v) => v.decision)
  const allAllow = decisions.length > 0 && decisions.every((d) => d === 'allow')
  const allDeny = decisions.length > 0 && decisions.every((d) => d === 'deny')
  return {
    unanimous: allAllow || allDeny,
    decision: allAllow ? 'allow' : allDeny ? 'deny' : null,
  }
}

export function voterPrompt(toolName: string, input: unknown, context: string): string {
  return [
    'You are an advisor judging whether another AI agent should be permitted to run a tool.',
    '',
    'Recent conversation context:',
    context || '(none)',
    '',
    `The agent wants to use the tool "${toolName}" with this input:`,
    '```json',
    JSON.stringify(input, null, 2),
    '```',
    '',
    'Decide whether this action should be ALLOWED or DENIED.',
    'Reply with ONLY a single-line JSON object, no other text:',
    '{"decision":"allow"|"deny","reason":"<one short sentence>"}',
  ].join('\n')
}

/** Deterministic summary when the decider agent is unavailable or aborted. */
export function fallbackSummary(
  votes: ConsensusVote[],
  unanimous: boolean,
  decision: 'allow' | 'deny' | null,
): string {
  const counts = votes.reduce<Record<string, number>>((acc, v) => {
    acc[v.decision] = (acc[v.decision] ?? 0) + 1
    return acc
  }, {})
  const parts = Object.entries(counts).map(([d, n]) => `${n} ${d}`)
  if (unanimous && decision) {
    return `所有 agent 一致${decision === 'allow' ? '允许' : '拒绝'}（${parts.join(', ')}）`
  }
  return `agent 意见不一致（${parts.join(', ')}），需人工裁决`
}
