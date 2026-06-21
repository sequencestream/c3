import { describe, expect, it } from 'vitest'
import { PR_STATUS_POLLER_PROMPT, getScheduleTemplate } from './index'

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
