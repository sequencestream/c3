import { describe, expect, it } from 'vitest'
import {
  buildToolManifest,
  C3_MCP_TOOLS,
  ROBOT_C3_MCP_TOOLS,
  selectedRobotC3McpToolNames,
} from './index.js'

const LIST_WORKSPACES = 'mcp__c3__list_workspaces'

describe('tool manifest usage scopes', () => {
  it('offers list_workspaces as a read-only robot capability', () => {
    const robot = buildToolManifest('claude', undefined, 'robot')
    expect(robot).toContainEqual({ name: LIST_WORKSPACES, isWrite: false })
    expect(ROBOT_C3_MCP_TOOLS).toContainEqual({ name: LIST_WORKSPACES, isWrite: false })
  })

  it('does not offer list_workspaces to automations or the shared automation catalog', () => {
    const automation = buildToolManifest('claude', undefined, 'automation')
    expect(automation.map((tool) => tool.name)).not.toContain(LIST_WORKSPACES)
    expect(C3_MCP_TOOLS.map((tool) => tool.name)).not.toContain(LIST_WORKSPACES)
  })

  it('passes a selected robot list_workspaces entry to the per-turn binder', () => {
    expect(selectedRobotC3McpToolNames([LIST_WORKSPACES])).toEqual(['list_workspaces'])
  })
})
