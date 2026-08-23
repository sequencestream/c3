/**
 * The robot launch profile — the lock a robot turn runs under. What is pinned
 * here is what ADR-0046 and the tool-grid spec depend on being true: the
 * `network-access` pseudo-entry never reaches the gate/allowlist, a c3 MCP write
 * tool alone never opens a writable native sandbox (only a local write/exec tool
 * like Codex `shell`/`apply_patch` does), and the MCP binder is offered exactly
 * the c3 tools the allowlist ticked — nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { NETWORK_ACCESS_TOOL } from '@ccc/shared/protocol'
import { createRobot, resetRobotStoreForTests, type CreateRobotInput } from './robot-store.js'
import { robotLaunchProfile, type RobotMcpBinder } from './profile.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-robot-profile-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetRobotStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetRobotStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

const input = (over: Partial<CreateRobotInput> = {}): CreateRobotInput => ({
  name: 'helper',
  platform: 'feishu',
  appId: 'cli_app',
  appSecret: 'super-secret',
  vendor: 'codex',
  agentId: 'agent-1',
  ...over,
})

function makeBinder(): RobotMcpBinder & { bindings: string[][] } {
  const bindings: string[][] = []
  return {
    bindings,
    bindC3Tools: (selected) => {
      bindings.push([...selected])
      // A stub binder the profile hands the run path — the test only observes
      // what subset was selected.
      return () => ({ servers: {}, dispose: () => {} })
    },
  }
}

function bindCalls(binder: RobotMcpBinder & { bindings: string[][] }): string[][] {
  return binder.bindings
}

describe('robotLaunchProfile — unknown robot', () => {
  it('narrows to read-only + offline with no MCP binder', () => {
    const binder = makeBinder()
    const profile = robotLaunchProfile('missing', binder)
    expect(profile.allowedTools.size).toBe(0)
    expect(profile.writeEnabled).toBe(false)
    expect(profile.networkAccess).toBe(false)
    expect(profile.bindMcp).toBeUndefined()
    expect(profile.disallowedTools).toContain('Bash')
    expect(profile.gate).toBe('robot')
  })
})

describe('robotLaunchProfile — allowlist split', () => {
  it('empty allowlist keeps the robot read-only and offline', () => {
    const id = createRobot(input()).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.allowedTools.size).toBe(0)
    expect(profile.writeEnabled).toBe(false)
    expect(profile.networkAccess).toBe(false)
    expect(profile.bindMcp).toBeUndefined()
  })

  it('network-access is an opt-in flag and never enters allowedTools', () => {
    const id = createRobot(input({ toolAllowlist: ['shell', NETWORK_ACCESS_TOOL] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.networkAccess).toBe(true)
    expect(profile.allowedTools.has(NETWORK_ACCESS_TOOL)).toBe(false)
    expect(profile.allowedTools.has('shell')).toBe(true)
  })

  it('network-access alone is read-only (no local write tool selected)', () => {
    const id = createRobot(input({ toolAllowlist: [NETWORK_ACCESS_TOOL] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.networkAccess).toBe(true)
    expect(profile.writeEnabled).toBe(false)
    expect(profile.allowedTools.size).toBe(0)
  })

  it('a codex local write tool selects writeEnabled', () => {
    const id = createRobot(input({ vendor: 'codex', toolAllowlist: ['shell'] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.writeEnabled).toBe(true)
  })

  it('apply_patch also selects writeEnabled for codex', () => {
    const id = createRobot(input({ vendor: 'codex', toolAllowlist: ['apply_patch'] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.writeEnabled).toBe(true)
  })

  it('a c3 MCP write tool alone does NOT open a writable sandbox', () => {
    const id = createRobot(input({ vendor: 'codex', toolAllowlist: ['mcp__c3__save_intents'] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.allowedTools.has('mcp__c3__save_intents')).toBe(true)
    expect(profile.writeEnabled).toBe(false)
    expect(profile.appendSystemPrompt).toContain('save_intents')
    expect(profile.appendSystemPrompt).toContain('文字明确确认')
    expect(profile.appendSystemPrompt).toContain('status/automate')
    expect(profile.appendSystemPrompt).toContain('旧值→新值')
    expect(profile.appendSystemPrompt).toContain('管理员勾选工具只授予调用能力')
  })

  it('a read-only c3 MCP tool alone stays read-only', () => {
    const id = createRobot(input({ vendor: 'codex', toolAllowlist: ['mcp__c3__find_intents'] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.writeEnabled).toBe(false)
  })

  it('list_workspaces is read-only and reaches the robot MCP binder', () => {
    const id = createRobot(
      input({ vendor: 'codex', toolAllowlist: ['mcp__c3__list_workspaces'] }),
    ).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.writeEnabled).toBe(false)
    expect(profile.allowedTools.has('mcp__c3__list_workspaces')).toBe(true)
    expect(bindCalls(binder)).toEqual([['list_workspaces']])
  })
})

describe('robotLaunchProfile — MCP binder subset', () => {
  it('offers exactly the selected c3 tools to the binder', () => {
    const id = createRobot(
      input({
        toolAllowlist: ['mcp__c3__find_intents', 'mcp__c3__save_intents', 'Read'],
      }),
    ).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.bindMcp).toBeDefined()
    expect(bindCalls(binder)).toEqual([['find_intents', 'save_intents']])
    // SDK tools never reach the binder — only the c3 MCP subset.
    expect(bindCalls(binder).flat()).not.toContain('Read')
  })

  it('offers no binder when no c3 tool is selected', () => {
    const id = createRobot(input({ toolAllowlist: ['Read', NETWORK_ACCESS_TOOL] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.bindMcp).toBeUndefined()
    expect(bindCalls(binder)).toEqual([])
  })

  it('does not confuse an unregistered workspace-mcp prefix with a c3 tool', () => {
    const id = createRobot(input({ toolAllowlist: ['mcp__some_server__do_thing'] })).id
    const binder = makeBinder()
    const profile = robotLaunchProfile(id, binder)
    expect(profile.bindMcp).toBeUndefined()
  })
})
