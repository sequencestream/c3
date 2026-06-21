import type { AgentConfig, CreateScheduleInput } from '@ccc/shared/protocol'

export interface ScheduleTemplateBuildArgs {
  workspaceId: string
  agentId: string
}

export interface ScheduleTemplate {
  id: string
  titleKey: 'schedule.list.templates.prPoller.title'
  descriptionKey: 'schedule.list.templates.prPoller.description'
  build(args: ScheduleTemplateBuildArgs): CreateScheduleInput
}

export const PR_STATUS_POLLER_PROMPT = `Reconcile GitHub PR status for this workspace.

1. Find candidate intents, inspect each candidate, and process only intents whose prStatus is reviewing and which have a prUrl or prId.
2. Use Bash with gh to query the real GitHub PR status. Do not change intents whose PR is still open/reviewing.
3. If a PR is merged, call save_intent_pr_info with prStatus "merged" and done true. If it is closed without merging, call save_intent_pr_info with prStatus "closed" and leave done unset.
4. Only when a status actually changed, call publish_pr_event with result "success", operation "merge" or "close", the PR identity/state, and association.intentId.

Do not reopen PRs, merge PRs, resolve conflicts, or change intents outside this reconciliation.`

const PR_STATUS_POLLER: ScheduleTemplate = {
  id: 'pr-status-poller',
  titleKey: 'schedule.list.templates.prPoller.title',
  descriptionKey: 'schedule.list.templates.prPoller.description',
  build: ({ workspaceId, agentId }) => ({
    type: 'llm',
    config: { prompt: PR_STATUS_POLLER_PROMPT },
    workspaceId,
    agentId,
    vendor: 'claude',
    triggerType: 'cron',
    cronExpression: '*/10 * * * *',
    mode: 'bypassPermissions',
    toolAllowlist: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'mcp__c3__find_intents',
      'mcp__c3__view_intent',
      'mcp__c3__save_intent_pr_info',
      'mcp__c3__publish_pr_event',
    ],
  }),
}

/** Register new schedule templates here; the list UI is intentionally generic. */
export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [PR_STATUS_POLLER]

export function getScheduleTemplate(id: string): ScheduleTemplate | undefined {
  return SCHEDULE_TEMPLATES.find((template) => template.id === id)
}

export function findEnabledVendorAgent(
  agents: readonly AgentConfig[],
  vendor: 'claude',
): AgentConfig | undefined {
  return agents.find((agent) => agent.vendor === vendor && agent.enabled !== false)
}
