/**
 * The relay prompts, as content contracts.
 *
 * A relay session's whole authority comes from what the server told it, so these
 * assert the facts that must be present (which intent, which PRs, which round,
 * which session id to conclude under) and the two orderings the loop depends on:
 * read the WorkNote history before the diff, publish the forge-visible result
 * alongside the terminal backfill, and conclude with a tool call rather than
 * with prose. They also pin the tool allowlists, because those are the phase's real
 * capability boundary — a reviewer that could edit is not a reviewer.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_REVIEW_FIX_ROUNDS,
  NETWORK_ACCESS_TOOL,
  type Intent,
  type IntentPr,
} from '@ccc/shared/protocol'
import {
  RELAY_FIX_TOOL_ALLOWLIST,
  RELAY_REVIEW_TOOL_ALLOWLIST,
  buildRelayFixPrompt,
  buildRelayReviewPrompt,
} from './relay-prompt.js'

const intent = {
  id: 'intent-42',
  title: '接力目标意图',
  content: '把 A 改成 B。',
  reviewStatus: null,
} as unknown as Intent

const pr: IntentPr = {
  id: 'row-1',
  intentId: 'intent-42',
  deliveryId: null,
  forge: 'github',
  repo: 'acme/widgets',
  number: '128',
  url: 'https://example.invalid/pr/128',
  status: 'reviewing',
  headBranch: 'intent/42',
  baseBranch: 'main',
  createdAt: 1,
  updatedAt: 1,
}

const base = { intent, prs: [pr], sessionId: 'c3-session-9', cwd: '/w/worktrees/intent-42' }

describe('review prompt', () => {
  const prompt = buildRelayReviewPrompt({ ...base, round: 0 })

  it('names the intent, the PR and the session the conclusion must be filed under', () => {
    expect(prompt).toContain('intent-42')
    expect(prompt).toContain('接力目标意图')
    expect(prompt).toContain('把 A 改成 B。')
    expect(prompt).toContain('PR #128')
    expect(prompt).toContain('acme/widgets')
    expect(prompt).toContain('https://example.invalid/pr/128')
    expect(prompt).toContain('intent/42')
    expect(prompt).toContain('main')
    expect(prompt).toContain('c3-session-9')
    expect(prompt).toContain('/w/worktrees/intent-42')
  })

  it('states the round and its ceiling', () => {
    expect(prompt).toContain(`已用 0 / 上限 ${MAX_REVIEW_FIX_ROUNDS}`)
    expect(buildRelayReviewPrompt({ ...base, round: 2 })).toContain('已用 2')
  })

  it('requires the WorkNote history to be read BEFORE the diff', () => {
    const history = prompt.indexOf('list_intent_worknotes')
    const diff = prompt.indexOf('gh pr diff')
    expect(history).toBeGreaterThan(-1)
    expect(diff).toBeGreaterThan(history)
  })

  it('keeps local commands in the worktree already assigned to the session', () => {
    expect(prompt).toContain('不要向命令工具另传 workdir/cwd')
    expect(prompt).toContain('不得把 shell 语法拼进目录参数')
  })

  it('separates an empty history from a read error', () => {
    expect(prompt).toContain('空历史是合法结果')
    expect(prompt).toContain('读取报错不是空历史')
  })

  it('refuses to accept prose as a conclusion', () => {
    expect(prompt).toContain('sync_intent_review_status')
    expect(prompt).toContain('不调用这个工具就等于没有结论')
  })

  it('uses the execution-specific MCP namespace when the runner supplies one', () => {
    const namespaced = buildRelayReviewPrompt({
      ...base,
      round: 0,
      mcpServerName: 'c3_exec_123',
    })
    expect(namespaced).toContain('mcp__c3_exec_123__list_intent_worknotes')
    expect(namespaced).toContain('mcp__c3_exec_123__append_intent_worknote')
    expect(namespaced).toContain('mcp__c3_exec_123__sync_intent_review_status')
    expect(namespaced).not.toContain('mcp__c3__sync_intent_review_status')
  })

  it('keeps rejected as an intent fact when publishing the PR comment fails', () => {
    expect(prompt).toContain('[review] pass')
    expect(prompt).toContain('[review] change-required')
    expect(prompt).toContain('gh pr comment')
    expect(prompt).toContain('<!-- c3:relay-review:c3-session-9 -->')
    expect(prompt).toContain('结论是 rejected,即使 PR/MR 评论失败也必须回填')
    expect(prompt).toContain('评论失败时不得回填 approved')
    expect(prompt.indexOf('gh pr comment')).toBeLessThan(
      prompt.indexOf('mcp__c3__sync_intent_review_status'),
    )
  })

  it('forbids changing the code it reviews', () => {
    expect(prompt).toContain('只评审、不改码、不提交、不合并')
  })

  it('reads as a re-review once a round has been spent', () => {
    expect(buildRelayReviewPrompt({ ...base, round: 1 })).toContain('复审')
  })
})

describe('fix prompt', () => {
  const prompt = buildRelayFixPrompt({ ...base, round: 2 })

  it('states which round it is and what it may touch', () => {
    expect(prompt).toContain(`第 2 轮修复(上限 ${MAX_REVIEW_FIX_ROUNDS} 轮)`)
    expect(prompt).toContain('不做无关重构')
  })

  it('points the session at the intent worktree with no fallback', () => {
    expect(prompt).toContain('/w/worktrees/intent-42')
    expect(prompt).toContain('不要切回项目主检出目录')
    expect(prompt).toContain('不要向命令工具另传 workdir/cwd')
  })

  it('requires a fix note and the fix terminal, and says `fixed` is not approval', () => {
    expect(prompt).toContain('append_intent_worknote')
    expect(prompt).toContain('kind="fix"')
    expect(prompt).toContain('sync_intent_fix_status')
    expect(prompt).toContain('fixed 只表示本轮已处理,不代表评审通过')
  })

  it('uses the execution-specific MCP namespace for the fix terminal too', () => {
    const namespaced = buildRelayFixPrompt({
      ...base,
      round: 2,
      mcpServerName: 'c3_exec_456',
    })
    expect(namespaced).toContain('mcp__c3_exec_456__sync_intent_fix_status')
    expect(namespaced).not.toContain('mcp__c3__sync_intent_fix_status')
  })

  it('publishes the fix result on every PR before backfilling fixed', () => {
    expect(prompt).toContain('[fix] completed')
    expect(prompt).toContain('gh pr comment')
    expect(prompt).toContain('<!-- c3:relay-fix:c3-session-9 -->')
    expect(prompt).toContain('任一目标评论失败时不要回填终态')
    expect(prompt.indexOf('gh pr comment')).toBeLessThan(
      prompt.indexOf('mcp__c3__sync_intent_fix_status'),
    )
  })

  it('accepts "no code change was warranted" as a real outcome', () => {
    expect(prompt).toContain('不要制造空提交')
    expect(prompt).toContain('判断整轮都不需要改码时')
  })
})

describe('tool allowlists are the phase capability boundary', () => {
  it('gives both PR-facing phases raw network access without widening file writes', () => {
    expect(RELAY_REVIEW_TOOL_ALLOWLIST).toContain(NETWORK_ACCESS_TOOL)
    expect(RELAY_FIX_TOOL_ALLOWLIST).toContain(NETWORK_ACCESS_TOOL)
  })

  it('a reviewer can read and conclude, but cannot edit or file a fix result', () => {
    expect(RELAY_REVIEW_TOOL_ALLOWLIST).toContain('mcp__c3__sync_intent_review_status')
    expect(RELAY_REVIEW_TOOL_ALLOWLIST).toContain('mcp__c3__list_intent_worknotes')
    expect(RELAY_REVIEW_TOOL_ALLOWLIST).not.toContain('Edit')
    expect(RELAY_REVIEW_TOOL_ALLOWLIST).not.toContain('Write')
    expect(RELAY_REVIEW_TOOL_ALLOWLIST).not.toContain('mcp__c3__sync_intent_fix_status')
  })

  it('a fixer can edit but can never grade its own work', () => {
    expect(RELAY_FIX_TOOL_ALLOWLIST).toContain('Edit')
    expect(RELAY_FIX_TOOL_ALLOWLIST).toContain('mcp__c3__sync_intent_fix_status')
    expect(RELAY_FIX_TOOL_ALLOWLIST).not.toContain('mcp__c3__sync_intent_review_status')
  })
})

describe('an empty PR list is reported, never silently reviewed', () => {
  it('says so instead of rendering an empty table', () => {
    expect(buildRelayReviewPrompt({ ...base, prs: [], round: 0 })).toContain('没有活跃 PR')
  })
})
