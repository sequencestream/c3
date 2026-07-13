import { describe, expect, it } from 'vitest'
import {
  ARCH_REVIEW_PROMPT,
  PR_STATUS_POLLER_PROMPT,
  WEEKLY_VULN_ANALYSIS_PROMPT,
  WEEKLY_WORKTREE_CLEANUP_PROMPT,
  getAutomationTemplate,
} from './index'

describe('PR status poller automation template', () => {
  it('builds the enabled Claude reconciliation configuration', () => {
    const input = getAutomationTemplate('pr-status-poller')?.build({
      workspaceId: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '*/10 * * * *',
      mode: 'bypassPermissions',
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
        'mcp__c3__save_intent_pr_info',
        'mcp__c3__publish_event',
      ]),
    )
    expect(PR_STATUS_POLLER_PROMPT).toContain('reviewing')
    expect(PR_STATUS_POLLER_PROMPT).toContain('gh')
    expect(PR_STATUS_POLLER_PROMPT).toContain('merged')
    expect(PR_STATUS_POLLER_PROMPT).toContain('closed')
  })
})

describe('weekly architecture review automation template', () => {
  it('builds the Friday claude review configuration', () => {
    const input = getAutomationTemplate('weekly-arch-review')?.build({
      workspaceId: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 18 * * 5',
      mode: 'bypassPermissions',
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
        'mcp__c3__save_intent_directly',
      ]),
    )
    // The directly-writing automation tool must NOT pull in the confirmation-gated save.
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intents')
  })

  it('embeds the high-value scoring logic in the prompt', () => {
    expect(ARCH_REVIEW_PROMPT).toContain('7 DAYS')
    expect(ARCH_REVIEW_PROMPT).toContain('find_intents')
    expect(ARCH_REVIEW_PROMPT).toContain('draft')
    expect(ARCH_REVIEW_PROMPT).toContain('<=3')
    expect(ARCH_REVIEW_PROMPT).toContain('STRONG signals')
    expect(ARCH_REVIEW_PROMPT).toContain('PRODUCE INTENTS ONLY')
  })
})

describe('weekly vulnerability analysis automation template', () => {
  it('builds the Monday claude weekly configuration', () => {
    const input = getAutomationTemplate('weekly-vuln-analysis')?.build({
      workspaceId: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 9 * * 1',
      mode: 'bypassPermissions',
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
        'mcp__c3__save_intent_directly',
      ]),
    )
    // Draft-writing template must NOT pull in the confirmation-gated save.
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intents')
  })

  it('embeds the security window, dedup, cap and no-code-change boundaries in the prompt', () => {
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('7 DAYS')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('security')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('vulnerability')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('Injection')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('find_intents')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('DRAFT')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('<=3')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('PRODUCE INTENTS ONLY')
    // Hard boundary: analysis only, never auto-fix / commit / PR / full audit.
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('never open a PR')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain(
      'NOT a whole-repository historical security audit',
    )
  })
})

describe('weekly expired worktree cleanup automation template', () => {
  it('builds the Sunday claude cleanup configuration', () => {
    const template = getAutomationTemplate('weekly-worktree-cleanup')
    const input = template?.build({
      workspaceId: '/workspace',
      agentId: 'a1',
    })

    expect(template).toBeDefined()
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 3 * * 0',
      mode: 'bypassPermissions',
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
      ]),
    )
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intents')
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intent_directly')
  })

  it('embeds the cleanup age, intent status, dirty and managed-only gates', () => {
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('more than 7 days old')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('intent-')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('mcp__c3__view_intent')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('done or cancelled')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('orphan managed worktree')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git status --porcelain')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain(
      '<c3-home>/worktrees/<projectDirName>/intent-*/',
    )
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('Never delete active-intent worktrees')
  })

  it('embeds conservative worktree and branch deletion behavior', () => {
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git worktree remove <path>')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git branch -d <branch>')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('intent/')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git ls-remote origin <branch>')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git push origin --delete <branch>')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('Never use wildcards')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git worktree remove -f')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git worktree remove --force')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git branch -D')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('mcp__c3__save_intents')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('mcp__c3__save_intent_directly')
  })
})
