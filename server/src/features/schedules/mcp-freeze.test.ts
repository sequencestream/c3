import { describe, it, expect } from 'vitest'
import type { WorkspaceMcpConfig } from '@ccc/shared/protocol'
import { freezeTools, matchesFrozenTool, isWriteTool } from './mcp-freeze.js'

const emptyConfig: WorkspaceMcpConfig = { mcpServers: {}, denylist: [] }

describe('freezeTools — read/write classification', () => {
  it('classifies SDK built-in read tools as non-write', () => {
    const frozen = freezeTools([], [], emptyConfig, 'sandboxed')
    expect(frozen.readToolNames.has('Read')).toBe(true)
    expect(frozen.readToolNames.has('Grep')).toBe(true)
    expect(frozen.readToolNames.has('WebSearch')).toBe(true)
    expect(frozen.writeToolNames.has('Read')).toBe(false)
  })

  it('classifies SDK built-in write tools as write', () => {
    const frozen = freezeTools([], [], emptyConfig, 'sandboxed')
    expect(frozen.writeToolNames.has('Write')).toBe(true)
    expect(frozen.writeToolNames.has('Edit')).toBe(true)
    expect(frozen.writeToolNames.has('Bash')).toBe(true)
    expect(frozen.readToolNames.has('Write')).toBe(false)
  })
})

describe('freezeTools — denylist subtraction', () => {
  it('workspace denylist removes a tool from the frozen set', () => {
    const config: WorkspaceMcpConfig = { mcpServers: {}, denylist: ['Read'] }
    const frozen = freezeTools([], [], config, 'sandboxed')
    expect(frozen.readToolNames.has('Read')).toBe(false)
    expect(frozen.tools.find((t) => t.name === 'Read')).toBeUndefined()
  })

  it('schedule denylist removes a tool from the frozen set', () => {
    const frozen = freezeTools([], ['Bash'], emptyConfig, 'sandboxed')
    expect(frozen.writeToolNames.has('Bash')).toBe(false)
  })

  it('denylist takes priority over allowlist (subtraction wins)', () => {
    // Allowlist permits Write, but denylist removes it → not present
    const frozen = freezeTools(['Write', 'Read'], ['Write'], emptyConfig, 'sandboxed')
    expect(frozen.writeToolNames.has('Write')).toBe(false)
    expect(frozen.readToolNames.has('Read')).toBe(true)
  })
})

describe('freezeTools — allowlist intersection', () => {
  it('empty allowlist means no restriction (all known tools present minus denylist)', () => {
    const frozen = freezeTools([], [], emptyConfig, 'sandboxed')
    expect(frozen.readToolNames.has('Read')).toBe(true)
    expect(frozen.writeToolNames.has('Write')).toBe(true)
  })

  it('non-empty allowlist restricts to only listed tools', () => {
    const frozen = freezeTools(['Read', 'Grep'], [], emptyConfig, 'sandboxed')
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
    const frozen = freezeTools([], [], config, 'sandboxed')
    const namespace = frozen.tools.find((t) => t.name === 'mcp__c3__')
    expect(namespace).toBeDefined()
  })
})

describe('matchesFrozenTool', () => {
  it('matches exact SDK tool names', () => {
    const frozen = freezeTools([], [], emptyConfig, 'sandboxed')
    expect(matchesFrozenTool('Read', frozen)).toBe(true)
    expect(matchesFrozenTool('Write', frozen)).toBe(true)
  })

  it('rejects tools not in the frozen set', () => {
    const frozen = freezeTools(['Read'], [], emptyConfig, 'sandboxed')
    expect(matchesFrozenTool('Write', frozen)).toBe(false)
    expect(matchesFrozenTool('UnknownTool', frozen)).toBe(false)
  })

  it('matches MCP tools by their namespace prefix', () => {
    const config: WorkspaceMcpConfig = {
      mcpServers: { c3: { command: 'node' } },
      denylist: [],
    }
    const frozen = freezeTools([], [], config, 'sandboxed')
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
    const frozen = freezeTools([], [], config, 'sandboxed')
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
    const frozen = freezeTools([], [], config, 'sandboxed')
    expect(isWriteTool('mcp__c3__save_intents', frozen)).toBe(true)
    expect(isWriteTool('mcp__c3__delete_thing', frozen)).toBe(true)
  })

  it('falls back to inline classification without a frozen set', () => {
    expect(isWriteTool('Read')).toBe(false)
    expect(isWriteTool('Write')).toBe(true)
    expect(isWriteTool('UnknownTool')).toBe(true) // conservative
  })
})
