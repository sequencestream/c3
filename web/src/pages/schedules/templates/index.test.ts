import { describe, expect, it } from 'vitest'
import { ARCH_REVIEW_PROMPT, PR_STATUS_POLLER_PROMPT, getScheduleTemplate } from './index'

describe('PR status poller schedule template', () => {
  it('builds the enabled Claude reconciliation configuration', () => {
    const input = getScheduleTemplate('pr-status-poller')?.build({
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
        'mcp__c3__publish_pr_event',
      ]),
    )
    expect(PR_STATUS_POLLER_PROMPT).toContain('reviewing')
    expect(PR_STATUS_POLLER_PROMPT).toContain('gh')
    expect(PR_STATUS_POLLER_PROMPT).toContain('merged')
    expect(PR_STATUS_POLLER_PROMPT).toContain('closed')
  })
})

describe('weekly architecture review schedule template', () => {
  it('builds the Friday claude review configuration', () => {
    const input = getScheduleTemplate('weekly-arch-review')?.build({
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
    // The directly-writing schedule tool must NOT pull in the confirmation-gated save.
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
