import { describe, it, expect } from 'vitest'
import type { WorkspaceMcpConfig } from '@ccc/shared/protocol'
import { freezeTools, hasSelectedC3McpTool, matchesFrozenTool, isWriteTool } from './mcp-freeze.js'

const emptyConfig: WorkspaceMcpConfig = { mcpServers: {}, denylist: [] }

describe('freezeTools — read/write classification', () => {
  it('classifies SDK built-in read tools as non-write', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(frozen.readToolNames.has('Read')).toBe(true)
    expect(frozen.readToolNames.has('Grep')).toBe(true)
    expect(frozen.readToolNames.has('WebSearch')).toBe(true)
    expect(frozen.writeToolNames.has('Read')).toBe(false)
  })

  it('classifies SDK built-in write tools as write', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(frozen.writeToolNames.has('Write')).toBe(true)
    expect(frozen.writeToolNames.has('Edit')).toBe(true)
    expect(frozen.writeToolNames.has('Bash')).toBe(true)
    expect(frozen.readToolNames.has('Write')).toBe(false)
  })
})

describe('freezeTools — denylist subtraction', () => {
  it('workspace denylist removes a tool from the frozen set', () => {
    const config: WorkspaceMcpConfig = { mcpServers: {}, denylist: ['Read'] }
    const frozen = freezeTools([], [], config)
    expect(frozen.readToolNames.has('Read')).toBe(false)
    expect(frozen.tools.find((t) => t.name === 'Read')).toBeUndefined()
  })

  it('automation denylist removes a tool from the frozen set', () => {
    const frozen = freezeTools([], ['Bash'], emptyConfig)
    expect(frozen.writeToolNames.has('Bash')).toBe(false)
  })

  it('denylist takes priority over allowlist (subtraction wins)', () => {
    // Allowlist permits Write, but denylist removes it → not present
    const frozen = freezeTools(['Write', 'Read'], ['Write'], emptyConfig)
    expect(frozen.writeToolNames.has('Write')).toBe(false)
    expect(frozen.readToolNames.has('Read')).toBe(true)
  })
})

describe('freezeTools — allowlist intersection', () => {
  it('empty allowlist means no restriction (all known tools present minus denylist)', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(frozen.readToolNames.has('Read')).toBe(true)
    expect(frozen.writeToolNames.has('Write')).toBe(true)
  })

  it('non-empty allowlist restricts to only listed tools', () => {
    const frozen = freezeTools(['Read', 'Grep'], [], emptyConfig)
    expect(frozen.readToolNames.has('Read')).toBe(true)
    expect(frozen.readToolNames.has('Grep')).toBe(true)
    // Write is not in the allowlist → excluded
    expect(frozen.writeToolNames.has('Write')).toBe(false)
    expect(frozen.readToolNames.has('WebSearch')).toBe(false)
  })
})

describe('freezeTools — MCP server namespace registration', () => {
  it('registers an mcp__<server>__ namespace prefix for each configured server', () => {
    const config: WorkspaceMcpConfig = {
      mcpServers: { c3: { command: 'node', args: ['server.js'] } },
      denylist: [],
    }
    const frozen = freezeTools([], [], config)
    const namespace = frozen.tools.find((t) => t.name === 'mcp__c3__')
    expect(namespace).toBeDefined()
  })
})

describe('matchesFrozenTool', () => {
  it('matches exact SDK tool names', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(matchesFrozenTool('Read', frozen)).toBe(true)
    expect(matchesFrozenTool('Write', frozen)).toBe(true)
  })

  it('rejects tools not in the frozen set', () => {
    const frozen = freezeTools(['Read'], [], emptyConfig)
    expect(matchesFrozenTool('Write', frozen)).toBe(false)
    expect(matchesFrozenTool('UnknownTool', frozen)).toBe(false)
  })

  it('matches MCP tools by their namespace prefix', () => {
    const config: WorkspaceMcpConfig = {
      mcpServers: { c3: { command: 'node' } },
      denylist: [],
    }
    const frozen = freezeTools([], [], config)
    expect(matchesFrozenTool('mcp__c3__save_intents', frozen)).toBe(true)
    expect(matchesFrozenTool('mcp__c3__find_intents', frozen)).toBe(true)
    // A different server's tool is not in scope
    expect(matchesFrozenTool('mcp__other__do_thing', frozen)).toBe(false)
  })
})

describe('isWriteTool — MCP naming convention', () => {
  it('classifies mcp read-prefixed tools as non-write', () => {
    const config: WorkspaceMcpConfig = {
      mcpServers: { c3: { command: 'node' } },
      denylist: [],
    }
    const frozen = freezeTools([], [], config)
    expect(isWriteTool('mcp__c3__find_intents', frozen)).toBe(false)
    expect(isWriteTool('mcp__c3__get_status', frozen)).toBe(false)
    expect(isWriteTool('mcp__c3__list_items', frozen)).toBe(false)
    expect(isWriteTool('mcp__c3__view_intent', frozen)).toBe(false)
  })

  it('classifies mcp tools without read prefix as write (conservative default)', () => {
    const config: WorkspaceMcpConfig = {
      mcpServers: { c3: { command: 'node' } },
      denylist: [],
    }
    const frozen = freezeTools([], [], config)
    expect(isWriteTool('mcp__c3__save_intents', frozen)).toBe(true)
    expect(isWriteTool('mcp__c3__delete_thing', frozen)).toBe(true)
  })

  it('falls back to inline classification without a frozen set', () => {
    expect(isWriteTool('Read')).toBe(false)
    expect(isWriteTool('Write')).toBe(true)
    expect(isWriteTool('UnknownTool')).toBe(true) // conservative
  })
})

describe('freezeTools — c3 in-process MCP tools', () => {
  it('mounts c3 only when its allowlist entry is explicitly selected', () => {
    expect(hasSelectedC3McpTool([])).toBe(false)
    expect(hasSelectedC3McpTool(['Read', 'Bash'])).toBe(false)
    expect(hasSelectedC3McpTool(['mcp__c3__find_intents'])).toBe(true)
  })

  it('includes c3 MCP tools in the frozen set without workspace MCP config', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(frozen.readToolNames.has('mcp__c3__find_intents')).toBe(true)
    expect(frozen.readToolNames.has('mcp__c3__view_intent')).toBe(true)
    expect(frozen.writeToolNames.has('mcp__c3__save_intents')).toBe(true)
    expect(frozen.writeToolNames.has('mcp__c3__save_intent_pr_info')).toBe(true)
    expect(frozen.writeToolNames.has('mcp__c3__save_intent_directly')).toBe(true)
    expect(frozen.writeToolNames.has('mcp__c3__publish_pr_event')).toBe(true)
  })

  it('includes the four discussion tools with find/view read and start/continue write', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(frozen.readToolNames.has('mcp__c3__find_discussions')).toBe(true)
    expect(frozen.readToolNames.has('mcp__c3__view_discussion')).toBe(true)
    expect(frozen.writeToolNames.has('mcp__c3__start_discussion')).toBe(true)
    expect(frozen.writeToolNames.has('mcp__c3__continue_discussion')).toBe(true)
  })

  it('mounts c3 when a discussion tool is the only selected c3 entry', () => {
    expect(hasSelectedC3McpTool(['mcp__c3__find_discussions'])).toBe(true)
    expect(hasSelectedC3McpTool(['mcp__c3__continue_discussion'])).toBe(true)
  })

  it('classifies find_intents and view_intent as read-only', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(isWriteTool('mcp__c3__find_intents', frozen)).toBe(false)
    expect(isWriteTool('mcp__c3__view_intent', frozen)).toBe(false)
  })

  it('classifies save_intents as write', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(isWriteTool('mcp__c3__save_intents', frozen)).toBe(true)
  })

  it('matches via matchesFrozenTool without workspace config', () => {
    const frozen = freezeTools([], [], emptyConfig)
    expect(matchesFrozenTool('mcp__c3__find_intents', frozen)).toBe(true)
    expect(matchesFrozenTool('mcp__c3__view_intent', frozen)).toBe(true)
    expect(matchesFrozenTool('mcp__c3__save_intents', frozen)).toBe(true)
  })

  it('survives allowlist filtering when selected', () => {
    const frozen = freezeTools(['mcp__c3__find_intents', 'mcp__c3__save_intents'], [], emptyConfig)
    expect(matchesFrozenTool('mcp__c3__find_intents', frozen)).toBe(true)
    expect(matchesFrozenTool('mcp__c3__save_intents', frozen)).toBe(true)
    // Not in allowlist → filtered out
    expect(matchesFrozenTool('Read', frozen)).toBe(false)
    expect(matchesFrozenTool('mcp__c3__view_intent', frozen)).toBe(false)
  })

  it('can be removed via denylist', () => {
    const frozen = freezeTools([], ['mcp__c3__find_intents'], emptyConfig)
    expect(matchesFrozenTool('mcp__c3__find_intents', frozen)).toBe(false)
    expect(matchesFrozenTool('mcp__c3__save_intents', frozen)).toBe(true) // not denied
  })
})
