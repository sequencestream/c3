import { describe, expect, it } from 'vitest'
import type { AutomationTemplateBuildArgs } from './index'
import {
  ARCH_REVIEW_PROMPT,
  WEEKLY_VULN_ANALYSIS_PROMPT,
  WEEKLY_WORKTREE_CLEANUP_PROMPT,
  TEMPLATE_MAX_WALL_CLOCK_MS,
  getAutomationTemplate,
} from './index'

/** Count physical lines in a template string, excluding leading/trailing blank lines. */
function countPhysicalLines(s: string): number {
  const trimmed = s.trim()
  if (!trimmed) return 0
  return trimmed.split('\n').length
}

describe('all templates', () => {
  const ids = [
    'weekly-arch-review',
    'weekly-vuln-analysis',
    'weekly-worktree-cleanup',
    'custom-event-echo',
  ] as const

  it.each(ids)('%s exists and build() returns maxWallClockMs', (id) => {
    const template = getAutomationTemplate(id)
    expect(template).toBeDefined()
    const input = template!.build({ workspaceName: '/ws', agentId: 'a1' })
    expect(input.maxWallClockMs).toBe(TEMPLATE_MAX_WALL_CLOCK_MS)
  })

  it.each(ids)('%s has a registered titleKey and descriptionKey', (id) => {
    const template = getAutomationTemplate(id)
    expect(template).toBeDefined()
    expect(template!.titleKey).toMatch(/^automation\.list\.templates\./)
    expect(template!.descriptionKey).toMatch(/^automation\.list\.templates\./)
  })

  // The PR state source is the server-side derivation on the intent PR row, so the
  // LLM-polling review/fix chain is no longer offered as a one-click template. The
  // `pr:*` event types and the PR-status sync tool stay available for user-built
  // automations; only these ready-made entries are gone.
  it.each(['pr-status-poller', 'pr-review-runner', 'pr-review-fix'])(
    '%s is no longer a built-in template',
    (id) => {
      expect(getAutomationTemplate(id)).toBeUndefined()
    },
  )
})

describe('weekly architecture review automation template', () => {
  it('builds the Friday claude review configuration', () => {
    const input = getAutomationTemplate('weekly-arch-review')?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 18 * * 5',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
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

  it('prompt is ≤10 lines and retains core scoring logic markers', () => {
    expect(countPhysicalLines(ARCH_REVIEW_PROMPT)).toBeLessThanOrEqual(10)
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
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 9 * * 1',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
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

  it('prompt is ≤10 lines and retains core security markers', () => {
    expect(countPhysicalLines(WEEKLY_VULN_ANALYSIS_PROMPT)).toBeLessThanOrEqual(10)
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
      workspaceName: '/workspace',
      agentId: 'a1',
    })

    expect(template).toBeDefined()
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 3 * * 0',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
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

  it('prompt is ≤10 lines and retains core safety gates', () => {
    expect(countPhysicalLines(WEEKLY_WORKTREE_CLEANUP_PROMPT)).toBeLessThanOrEqual(10)
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

  it('prompt retains conservative worktree and branch deletion behavior', () => {
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git worktree remove')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git branch -d')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('intent/')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git ls-remote origin')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git push origin --delete')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('Never use wildcards')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git worktree remove -f')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git worktree remove --force')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git branch -D')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('mcp__c3__save_intents')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('mcp__c3__save_intent_directly')
  })
})

describe('custom event echo automation template', () => {
  it('builds the command echo configuration', () => {
    const input = getAutomationTemplate('custom-event-echo')?.build({
      workspaceName: '/workspace',
      agentId: '',
    })
    expect(input).toMatchObject({
      type: 'command',
      config: { command: 'echo hello' },
      vendor: 'claude',
      triggerType: 'event',
      cronExpression: '',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    // command template does NOT carry agentId.
    expect(input).not.toHaveProperty('agentId')
    expect(input?.eventFilters).toEqual([{ type: 'my:create-event' }])
    expect(input?.toolAllowlist).toEqual([])
  })

  it('does not carry LLM-specific tools', () => {
    const template = getAutomationTemplate('custom-event-echo')
    expect(template).toBeDefined()
    const input = template!.build({ workspaceName: '/workspace' } as AutomationTemplateBuildArgs)
    expect(input.toolAllowlist).toEqual([])
    expect(input.type).toBe('command')
    expect(input.config).not.toHaveProperty('prompt')
    expect(input.config).toHaveProperty('command')
  })
})
